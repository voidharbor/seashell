#include "hostapi.h"
#include "app.h"
#include "gfx.h"
#include "paths.h"
#include "window.h"
#include <dwmapi.h>
#include <shellapi.h>
#include <shellscalingapi.h>
#include <shobjidl.h>
#include <wrl/client.h>
#include <cstdio>
#include <vector>

#pragma comment(lib, "shcore.lib")

using nlohmann::json;
using Microsoft::WRL::ComPtr;

namespace {
const size_t kClipMax = 100000;   // UTF-16 units, what a JS string's length counts

std::string strArg(const json& p, const char* k) {
  if (!p.is_object()) return {};
  auto it = p.find(k);
  return it != p.end() && it->is_string() ? it->get<std::string>() : std::string();
}

json fail(const std::string& code) { return { { "ok", false }, { "code", code } }; }

// A path from the core is Linux; a Windows path (C:\x) is taken as is.
std::wstring winPath(const std::string& path) {
  if (path.size() >= 2 && path[1] == ':') return fromUtf8(path);
  return toWindowsPath(path);
}

json pickFolder() {
  ComPtr<IFileOpenDialog> dlg;
  HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(dlg.GetAddressOf()));
  if (FAILED(hr)) return { { "ok", false }, { "error", "IFileOpenDialog failed" } };
  FILEOPENDIALOGOPTIONS opts = 0;
  dlg->GetOptions(&opts);
  dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  hr = dlg->Show(Window::instance().hwnd());
  if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return fail("ECANCEL");
  if (FAILED(hr)) return { { "ok", false }, { "error", "dialog failed" } };
  ComPtr<IShellItem> item;
  PWSTR path = nullptr;
  if (FAILED(dlg->GetResult(item.GetAddressOf())) || FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)))
    return fail("ECANCEL");
  std::string lp = toLinuxPath(path);
  CoTaskMemFree(path);
  return { { "ok", true }, { "path", lp } };
}

bool openClipboard() {
  for (int i = 0; i < 10; i++) {   // another app may hold it for a moment
    if (OpenClipboard(Window::instance().hwnd())) return true;
    Sleep(10);
  }
  return false;
}

json clipRead() {
  if (!openClipboard()) return { { "text", "" } };
  std::wstring text;
  if (HANDLE h = GetClipboardData(CF_UNICODETEXT)) {
    if (auto* p = static_cast<const wchar_t*>(GlobalLock(h))) { text = p; GlobalUnlock(h); }
  }
  CloseClipboard();
  return { { "text", toUtf8(text) } };
}

json clipWrite(const json& p) {
  std::wstring text = fromUtf8(strArg(p, "text"));
  if (text.size() > kClipMax) return fail("ETOOBIG");
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
  if (!mem) return { { "ok", false }, { "error", "GlobalAlloc failed" } };
  memcpy(GlobalLock(mem), text.c_str(), (text.size() + 1) * sizeof(wchar_t));
  GlobalUnlock(mem);
  if (!openClipboard()) { GlobalFree(mem); return { { "ok", false }, { "error", "clipboard busy" } }; }
  EmptyClipboard();
  bool ok = SetClipboardData(CF_UNICODETEXT, mem) != nullptr;
  CloseClipboard();
  if (!ok) { GlobalFree(mem); return { { "ok", false }, { "error", "SetClipboardData failed" } }; }
  return { { "ok", true } };
}

json shellOpen(const wchar_t* file, const wchar_t* params) {
  auto r = (INT_PTR)ShellExecuteW(Window::instance().hwnd(), L"open", file, params, nullptr, SW_SHOWNORMAL);
  if (r <= 32) return { { "ok", false }, { "error", "ShellExecute failed (" + std::to_string((long long)r) + ")" } };
  return { { "ok", true } };
}

// Under the test driver an open reaches no app on the desktop: the converted
// target is logged ("open:withDefaultApp C:\x") for the driver checks to read,
// and the open answers ok without executing.
bool loggedInstead(const char* ch, const std::wstring& target) {
  if (!App::instance().testMode()) return false;
  App::log("%s %s", ch, toUtf8(target).c_str());
  return true;
}

json openExternal(const json& p) {
  std::string url = strArg(p, "url");
  auto starts = [&](const char* pre) { return _strnicmp(url.c_str(), pre, strlen(pre)) == 0; };
  if (!starts("http://") && !starts("https://")) return { { "ok", false }, { "error", "not http" } };
  std::wstring w = fromUtf8(url);
  if (loggedInstead("open:externalHttp", w)) return { { "ok", true } };
  return shellOpen(w.c_str(), nullptr);
}

json rectJson(const RECT& r, double scale) {
  return { { "x", (int)(r.left / scale) }, { "y", (int)(r.top / scale) },
           { "width", (int)((r.right - r.left) / scale) }, { "height", (int)((r.bottom - r.top) / scale) } };
}

BOOL CALLBACK addMonitor(HMONITOR mon, HDC, LPRECT, LPARAM out) {
  MONITORINFOEXW mi{};
  mi.cbSize = sizeof mi;
  if (!GetMonitorInfoW(mon, &mi)) return TRUE;
  UINT dx = 96, dy = 96;
  if (FAILED(GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &dx, &dy))) dx = 96;
  double scale = dx / 96.0;
  // A stable id per device name (FNV-1a), as Electron's ids are numbers.
  uint32_t id = 2166136261u;
  for (const wchar_t* c = mi.szDevice; *c; c++) { id ^= (uint32_t)*c; id *= 16777619u; }
  reinterpret_cast<json*>(out)->push_back({ { "id", id }, { "bounds", rectJson(mi.rcMonitor, scale) },
                                            { "workArea", rectJson(mi.rcWork, scale) }, { "scaleFactor", scale },
                                            { "primary", (mi.dwFlags & MONITORINFOF_PRIMARY) != 0 } });
  return TRUE;
}

json colorization() {
  DWORD argb = 0;
  BOOL opaque = FALSE;
  if (FAILED(DwmGetColorizationColor(&argb, &opaque))) return { { "ok", false } };
  char hex[16];
  snprintf(hex, sizeof hex, "#%08lX", (unsigned long)argb);
  return { { "ok", true }, { "argb", hex }, { "opaque", opaque != FALSE } };
}

// PrintWindow into a 32-bpp DIB, then WIC to PNG. Test driver only.
json screenshot(const json& p) {
  std::string path = strArg(p, "path");
  if (path.empty()) return { { "ok", false }, { "error", "no path" } };
  HWND hwnd = Window::instance().hwnd();
  RECT wr{};
  GetWindowRect(hwnd, &wr);
  int w = wr.right - wr.left, h = wr.bottom - wr.top;
  if (w <= 0 || h <= 0) return { { "ok", false }, { "error", "no window" } };
  BITMAPINFO bi{};
  bi.bmiHeader = { sizeof(BITMAPINFOHEADER), w, -h, 1, 32, BI_RGB };
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HDC dc = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, screen);
  if (!bmp) { DeleteDC(dc); return { { "ok", false }, { "error", "CreateDIBSection failed" } }; }
  HGDIOBJ old = SelectObject(dc, bmp);
  BOOL printed = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT);
  SelectObject(dc, old);
  json result = { { "ok", false }, { "error", "PrintWindow failed" } };
  if (printed) {
    // PrintWindow leaves alpha undefined; the PNG is opaque.
    auto* px = static_cast<uint32_t*>(bits);
    for (int i = 0; i < w * h; i++) px[i] |= 0xFF000000u;
    IWICImagingFactory* wic = Gfx::instance().wic();
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> enc;
    ComPtr<IWICBitmapFrameEncode> frame;
    WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
    HRESULT hr = wic ? wic->CreateStream(stream.GetAddressOf()) : E_FAIL;
    if (SUCCEEDED(hr)) hr = stream->InitializeFromFilename(winPath(path).c_str(), GENERIC_WRITE);
    if (SUCCEEDED(hr)) hr = wic->CreateEncoder(GUID_ContainerFormatPng, nullptr, enc.GetAddressOf());
    if (SUCCEEDED(hr)) hr = enc->Initialize(stream.Get(), WICBitmapEncoderNoCache);
    if (SUCCEEDED(hr)) hr = enc->CreateNewFrame(frame.GetAddressOf(), nullptr);
    if (SUCCEEDED(hr)) hr = frame->Initialize(nullptr);
    if (SUCCEEDED(hr)) hr = frame->SetSize(w, h);
    if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&fmt);
    if (SUCCEEDED(hr)) hr = frame->WritePixels(h, w * 4, w * h * 4, static_cast<BYTE*>(bits));
    if (SUCCEEDED(hr)) hr = frame->Commit();
    if (SUCCEEDED(hr)) hr = enc->Commit();
    if (SUCCEEDED(hr)) result = { { "ok", true }, { "path", path }, { "width", w }, { "height", h } };
    else {
      char msg[64];
      snprintf(msg, sizeof msg, "WIC 0x%08lx", (unsigned long)hr);
      result = { { "ok", false }, { "error", msg } };
    }
  }
  DeleteObject(bmp);
  DeleteDC(dc);
  return result;
}
}  // namespace

json HostApi::handle(const std::string& ch, const json& p) {
  HWND hwnd = Window::instance().hwnd();
  if (ch == "window:minimize") { ShowWindow(hwnd, SW_MINIMIZE); return { { "ok", true } }; }
  if (ch == "window:toggleMaximize") { ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE); return { { "ok", true } }; }
  if (ch == "window:close") { PostMessageW(hwnd, WM_CLOSE, 0, 0); return { { "ok", true } }; }
  if (ch == "window:isMaximized" || ch == "window:maximized") return { { "maximized", IsZoomed(hwnd) != FALSE } };
  if (ch == "app:pickFolder") return pickFolder();
  if (ch == "clip:read") return clipRead();
  if (ch == "clip:write") return clipWrite(p);
  if (ch == "open:withDefaultApp") {
    std::wstring path = winPath(strArg(p, "path"));
    if (loggedInstead("open:withDefaultApp", path)) return { { "ok", true } };
    return shellOpen(path.c_str(), nullptr);
  }
  if (ch == "open:revealInFinder") {
    std::wstring path = winPath(strArg(p, "path"));
    if (loggedInstead("open:revealInFinder", path)) return { { "ok", true } };
    std::wstring params = L"/select,\"" + path + L"\"";
    return shellOpen(L"explorer.exe", params.c_str());
  }
  if (ch == "open:externalHttp") return openExternal(p);
  if (ch == "display:list") {
    json list = json::array();
    EnumDisplayMonitors(nullptr, nullptr, addMonitor, (LPARAM)&list);
    return list;
  }
  if (ch == "display:colorization") return colorization();
  if (ch == "test:screenshot") {
    if (!App::instance().testMode()) return fail("ENOTEST");
    return screenshot(p);
  }
  // grid:cmd is a push, never an invoke; answer so the caller's promise settles.
  return fail("ENOTINVOKE");
}
