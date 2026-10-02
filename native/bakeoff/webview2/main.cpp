// Bake-off candidate B: one window, one WebView2, ten xterm instances in the
// page, terminal 0 attached to a ConPTY running wsl.exe zsh. Measures the floor
// of keeping the web renderer. Not the product host.
#include <windows.h>
#include <objbase.h>
#include <wrl.h>
#include <wil/com.h>
#include <WebView2.h>
#include <string>
#include <thread>
#include <vector>
using Microsoft::WRL::Callback;

static wil::com_ptr<ICoreWebView2Controller> g_ctl;
static wil::com_ptr<ICoreWebView2> g_wv;
static HANDLE g_ptyIn = nullptr;   // we write keystrokes here
static HPCON g_hpc = nullptr;
static bool g_ptyStarted = false;

// Startup failures go to a log next to the user data folder, since a WIN32
// subsystem exe has no console to print to.
static std::wstring g_log;
static void logLine(const std::wstring& s) {
  if (g_log.empty()) return;
  HANDLE f = CreateFileW(g_log.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  std::wstring line = s + L"\r\n";
  int n = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), nullptr, 0, nullptr, nullptr);
  std::string u(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), u.data(), n, nullptr, nullptr);
  DWORD w; WriteFile(f, u.data(), (DWORD)u.size(), &w, nullptr);
  CloseHandle(f);
}
static void logHr(const wchar_t* what, HRESULT hr) {
  wchar_t b[64]; swprintf_s(b, L" hr=0x%08lX", (unsigned long)hr);
  logLine(std::wstring(what) + b);
}

static std::wstring b64(const char* d, size_t n) {
  static const wchar_t* T = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::wstring o; o.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned char)d[i] << 16 | (i + 1 < n ? (unsigned char)d[i + 1] << 8 : 0) | (i + 2 < n ? (unsigned char)d[i + 2] : 0);
    o += T[v >> 18 & 63]; o += T[v >> 12 & 63];
    o += i + 1 < n ? T[v >> 6 & 63] : L'='; o += i + 2 < n ? T[v & 63] : L'=';
  }
  return o;
}

static void startPty(HWND hwnd) {
  HANDLE inR, inW, outR, outW;
  if (!CreatePipe(&inR, &inW, nullptr, 0) || !CreatePipe(&outR, &outW, nullptr, 0)) { logLine(L"CreatePipe failed"); return; }
  COORD size{120, 40};
  HRESULT hr = CreatePseudoConsole(size, inR, outW, 0, &g_hpc);
  if (FAILED(hr)) { logHr(L"CreatePseudoConsole", hr); return; }
  g_ptyIn = inW;
  STARTUPINFOEXW si{}; si.StartupInfo.cb = sizeof(si);
  SIZE_T n = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &n);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, n);
  InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &n);
  UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_hpc, sizeof(g_hpc), nullptr, nullptr);
  std::wstring cmd = L"wsl.exe -d Ubuntu-24.04 --cd /Users/joshwald -e zsh -l";
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi)) {
    logHr(L"CreateProcessW wsl.exe", HRESULT_FROM_WIN32(GetLastError()));
    return;
  }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  // The pseudoconsole holds its own copies; closing ours lets ReadFile see EOF.
  CloseHandle(inR); CloseHandle(outW);
  std::thread([outR, hwnd] {
    char buf[8192]; DWORD got;
    while (ReadFile(outR, buf, sizeof buf, &got, nullptr) && got) {
      auto* s = new std::wstring(L"{\"ch\":\"data\",\"p\":\"" + b64(buf, got) + L"\"}");
      if (!PostMessageW(hwnd, WM_APP + 1, 0, (LPARAM)s)) { delete s; break; }
    }
  }).detach();
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_SIZE: if (g_ctl) { RECT r; GetClientRect(h, &r); g_ctl->put_Bounds(r); } return 0;
    case WM_APP + 1: { auto* s = (std::wstring*)l; if (g_wv) g_wv->PostWebMessageAsJson(s->c_str()); delete s; return 0; }
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE, PWSTR, int nShow) {
  int argc = 0; LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring pageDir = argc > 1 ? argv[1] : L".";
  std::wstring udf = argc > 2 ? argv[2] : L"C:\\seashell-build\\redesign\\bakeoff\\webview2-udf";
  g_log = udf + L".log";
  // WebView2 requires a single-threaded apartment on the UI thread.
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(hr)) { logHr(L"CoInitializeEx", hr); return 1; }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW wc{}; wc.lpfnWndProc = WndProc; wc.hInstance = hi; wc.lpszClassName = L"SeaShellBakeoffWebView2";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW); wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
  RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"SeaShell bakeoff B", WS_OVERLAPPEDWINDOW, 100, 100, 1440, 900, nullptr, nullptr, hi, nullptr);
  ShowWindow(hwnd, nShow);
  hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([hwnd, pageDir](HRESULT ehr, ICoreWebView2Environment* env) -> HRESULT {
      if (FAILED(ehr) || !env) { logHr(L"environment", ehr); PostQuitMessage(1); return S_OK; }
      env->CreateCoreWebView2Controller(hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([hwnd, pageDir](HRESULT chr, ICoreWebView2Controller* c) -> HRESULT {
        if (FAILED(chr) || !c) { logHr(L"controller", chr); PostQuitMessage(1); return S_OK; }
        g_ctl = c; g_ctl->get_CoreWebView2(&g_wv);
        RECT r; GetClientRect(hwnd, &r); g_ctl->put_Bounds(r);
        auto wv3 = g_wv.try_query<ICoreWebView2_3>();
        if (!wv3) { logLine(L"ICoreWebView2_3 unavailable"); PostQuitMessage(1); return S_OK; }
        wv3->SetVirtualHostNameToFolderMapping(L"bakeoff.seashell", pageDir.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        g_wv->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
          wil::unique_cotaskmem_string s;
          if (FAILED(a->TryGetWebMessageAsString(&s)) || !s || !g_ptyIn) return S_OK;
          int len = (int)wcslen(s.get());
          int n = WideCharToMultiByte(CP_UTF8, 0, s.get(), len, nullptr, 0, nullptr, nullptr);
          std::string u(n, '\0');
          WideCharToMultiByte(CP_UTF8, 0, s.get(), len, u.data(), n, nullptr, nullptr);
          DWORD w; WriteFile(g_ptyIn, u.data(), (DWORD)u.size(), &w, nullptr);
          return S_OK; }).Get(), nullptr);
        // Start the shell only once the page (and its message listener) is up,
        // so the first prompt is not posted into a page that is still loading.
        g_wv->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([hwnd](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* a) -> HRESULT {
          BOOL ok = FALSE; a->get_IsSuccess(&ok);
          if (!ok) logLine(L"navigation failed");
          if (!g_ptyStarted) { g_ptyStarted = true; startPty(hwnd); }
          return S_OK; }).Get(), nullptr);
        g_wv->Navigate(L"https://bakeoff.seashell/bakeoff.html");
        return S_OK; }).Get());
      return S_OK; }).Get());
  if (FAILED(hr)) { logHr(L"CreateCoreWebView2EnvironmentWithOptions", hr); return 1; }
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  if (g_hpc) ClosePseudoConsole(g_hpc);
  CoUninitialize();
  return 0;
}
