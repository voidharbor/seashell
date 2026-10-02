// Bake-off candidate D: a Win32 window drawing ten 120x40 text grids with
// DirectWrite, grid 0 fed by a ConPTY running wsl.exe zsh. Escape sequences
// are skipped, not interpreted (only CR, LF, BS, cursor position and erase are
// honoured so the prompt reads right). The floor of a native rewrite, not a
// terminal.
#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <string>
#include <thread>
#include <mutex>
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <algorithm>
#pragma comment(lib, "d2d1")
#pragma comment(lib, "dwrite")

static const int kCols = 120, kRows = 40, kGrids = 10;

// A fixed 120x40 screen with a cursor. ConPTY paints with absolute cursor
// moves, so CUP and erase-display are honoured; everything else is skipped.
struct Grid {
  std::vector<std::wstring> rows = std::vector<std::wstring>(kRows);
  size_t row = 0, col = 0;
  void put(wchar_t c) {
    if (col >= (size_t)kCols) return;
    std::wstring& r = rows[row];
    if (r.size() < col) r.resize(col, L' ');
    if (col < r.size()) r[col] = c; else r.push_back(c);
    col++;
  }
  void newline() { if (row + 1 < (size_t)kRows) row++; else { rows.erase(rows.begin()); rows.emplace_back(); } }
  void moveTo(int r, int c) { row = (size_t)std::max(0, std::min(r, kRows - 1)); col = (size_t)std::max(0, std::min(c, kCols - 1)); }
  void eraseToEnd() { std::wstring& r = rows[row]; if (col < r.size()) r.resize(col); }
  void clear() { for (auto& r : rows) r.clear(); }
  std::wstring text() const { std::wstring s; for (size_t i = 0; i < rows.size(); i++) { if (i) s += L'\n'; s += rows[i]; } return s; }
};

static ID2D1Factory* g_d2d; static IDWriteFactory* g_dw; static ID2D1HwndRenderTarget* g_rt; static IDWriteTextFormat* g_fmt;
static float g_fmtSize = 0;
static Grid g_grids[kGrids];
static std::mutex g_mu;
static HANDLE g_ptyIn; static HPCON g_hpc;

// Raw ConPTY bytes into grid 0: a tiny state machine that drops CSI, OSC and
// two-byte escapes, maps non-ASCII UTF-8 to '?', and keeps printable ASCII.
static void feed(const char* buf, DWORD got) {
  static int st = 0; static std::string csi;
  Grid& g = g_grids[0];
  for (DWORD i = 0; i < got; i++) {
    unsigned char c = (unsigned char)buf[i];
    switch (st) {
      case 0:
        if (c == 0x1b) st = 1;
        else if (c == '\n') { g.newline(); g.col = 0; }
        else if (c == '\r') g.col = 0;
        else if (c == '\b') { if (g.col) g.col--; }
        else if (c >= 0x20 && c < 0x7f) g.put((wchar_t)c);
        else if (c >= 0xc0) g.put(L'?');
        break;
      case 1:
        if (c == '[') { st = 2; csi.clear(); }
        else if (c == ']' || c == 'P' || c == '_' || c == '^') st = 3;
        else if (c >= 0x20 && c <= 0x2f) st = 4;
        else st = 0;
        break;
      case 2:
        if (c >= 0x40 && c <= 0x7e) {
          if (c == 'K' && (csi.empty() || csi == "0")) g.eraseToEnd();
          else if (c == 'J' && (csi == "2" || csi == "3")) g.clear();
          else if ((c == 'H' || c == 'f') && (csi.empty() || isdigit((unsigned char)csi[0]) || csi[0] == ';')) {
            int r = atoi(csi.c_str()); size_t semi = csi.find(';'); int cc = semi == std::string::npos ? 1 : atoi(csi.c_str() + semi + 1);
            g.moveTo((r ? r : 1) - 1, (cc ? cc : 1) - 1);
          }
          st = 0;
        }
        else csi.push_back((char)c);
        break;
      case 3:
        if (c == 0x07) st = 0; else if (c == 0x1b) st = 5;
        break;
      case 4: st = 0; break;
      case 5: st = (c == '\\') ? 0 : 3; break;
    }
  }
}

static void startPty(HWND hwnd) {
  auto fail = [](const wchar_t* what, DWORD code) {
    std::lock_guard<std::mutex> lk(g_mu);
    for (const wchar_t* p = what; *p; p++) g_grids[0].put(*p);
    std::wstring n = L" failed: " + std::to_wstring(code);
    for (wchar_t c : n) g_grids[0].put(c);
  };
  HANDLE inR, inW, outR, outW;
  if (!CreatePipe(&inR, &inW, nullptr, 0) || !CreatePipe(&outR, &outW, nullptr, 0)) { fail(L"CreatePipe", GetLastError()); return; }
  COORD size{(SHORT)kCols, (SHORT)kRows};
  HRESULT hr = CreatePseudoConsole(size, inR, outW, 0, &g_hpc);
  // ConPTY duplicates its ends; ours must go or ReadFile never sees EOF.
  CloseHandle(inR); CloseHandle(outW);
  if (FAILED(hr)) { fail(L"CreatePseudoConsole", (DWORD)hr); return; }
  g_ptyIn = inW;  // kept open: closing it would end zsh's stdin
  STARTUPINFOEXW si{}; si.StartupInfo.cb = sizeof(si); SIZE_T n = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &n);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, n);
  InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &n);
  UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_hpc, sizeof(g_hpc), nullptr, nullptr);
  std::wstring cmd = L"wsl.exe -d Ubuntu-24.04 --cd /Users/joshwald -e zsh -l"; PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi)) {
    fail(L"CreateProcess wsl.exe", GetLastError()); return;
  }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  DeleteProcThreadAttributeList(si.lpAttributeList); HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  std::thread([outR, hwnd] {
    char buf[4096]; DWORD got;
    // SEASHELL_D_LOG=<file> dumps the raw ConPTY bytes, for debugging only.
    wchar_t logPath[MAX_PATH]; FILE* log = nullptr;
    if (GetEnvironmentVariableW(L"SEASHELL_D_LOG", logPath, MAX_PATH)) _wfopen_s(&log, logPath, L"wb");
    while (ReadFile(outR, buf, sizeof buf, &got, nullptr) && got) {
      if (log) { fwrite(buf, 1, got, log); fflush(log); }
      { std::lock_guard<std::mutex> lk(g_mu); feed(buf, got); }
      InvalidateRect(hwnd, nullptr, FALSE);
    }
  }).detach();
}

static void discardTarget() { if (g_rt) { g_rt->Release(); g_rt = nullptr; } }

static void paint(HWND h) {
  PAINTSTRUCT ps; BeginPaint(h, &ps);
  RECT r; GetClientRect(h, &r);
  if (!g_rt && r.right > 0 && r.bottom > 0) {
    float dpi = (float)GetDpiForWindow(h);
    g_d2d->CreateHwndRenderTarget(D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1::PixelFormat(), dpi, dpi),
                                  D2D1::HwndRenderTargetProperties(h, D2D1::SizeU(r.right, r.bottom)), &g_rt);
  }
  if (!g_rt) { EndPaint(h, &ps); return; }
  D2D1_SIZE_F sz = g_rt->GetSize(); float cw = sz.width / 5, chh = sz.height / 2;
  // 40 rows must fit a cell; columns past the cell width are clipped.
  float fontSize = chh / kRows / 1.2f;
  if (fontSize < 4) fontSize = 4;
  if (!g_fmt || fontSize != g_fmtSize) {
    if (g_fmt) { g_fmt->Release(); g_fmt = nullptr; }
    g_dw->CreateTextFormat(L"Consolas", nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, fontSize, L"en-us", &g_fmt);
    g_fmt->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    g_fmtSize = fontSize;
  }
  g_rt->BeginDraw(); g_rt->Clear(D2D1::ColorF(0, 0, 0));
  ID2D1SolidColorBrush *br, *line;
  g_rt->CreateSolidColorBrush(D2D1::ColorF(0.157f, 0.996f, 0.078f), &br);
  g_rt->CreateSolidColorBrush(D2D1::ColorF(0.3f, 0.3f, 0.3f), &line);
  {
    std::lock_guard<std::mutex> lk(g_mu);
    for (int i = 0; i < kGrids; i++) {
      D2D1_RECT_F rc = D2D1::RectF((i % 5) * cw + 3, (i / 5) * chh + 2, (i % 5 + 1) * cw - 3, (i / 5 + 1) * chh - 2);
      std::wstring t = g_grids[i].text();
      g_rt->DrawText(t.c_str(), (UINT32)t.size(), g_fmt, rc, br, D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
  }
  for (int c = 1; c < 5; c++) g_rt->DrawLine(D2D1::Point2F(c * cw, 0), D2D1::Point2F(c * cw, sz.height), line);
  g_rt->DrawLine(D2D1::Point2F(0, chh), D2D1::Point2F(sz.width, chh), line);
  br->Release(); line->Release();
  if (g_rt->EndDraw() == D2DERR_RECREATE_TARGET) discardTarget();
  EndPaint(h, &ps);
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_PAINT: paint(h); return 0;
    case WM_ERASEBKGND: return 1;
    case WM_SIZE: if (g_rt) g_rt->Resize(D2D1::SizeU(LOWORD(l), HIWORD(l))); InvalidateRect(h, nullptr, FALSE); return 0;
    case WM_DPICHANGED: {
      discardTarget();
      RECT* s = (RECT*)l; SetWindowPos(h, nullptr, s->left, s->top, s->right - s->left, s->bottom - s->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_DESTROY: if (g_hpc) ClosePseudoConsole(g_hpc); PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_d2d);
  DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), (IUnknown**)&g_dw);
  for (int i = 1; i < kGrids; i++) {
    Grid& g = g_grids[i];
    for (int r = 0; r < kRows; r++) g.rows[r] = (L"zsh idle pane " + std::to_wstring(i) + L" line " + std::to_wstring(r));
  }
  WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hi; wc.lpszClassName = L"SeaShellBakeoffWin32";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW); RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"SeaShell bakeoff D", WS_OVERLAPPEDWINDOW, 100, 100, 1440, 900, nullptr, nullptr, hi, nullptr);
  // No activation: an unattended run must not take keyboard focus from the desktop.
  ShowWindow(hwnd, SW_SHOWNOACTIVATE); startPty(hwnd);
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); } return 0;
}
