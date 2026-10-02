#include "app.h"
#include "gfx.h"
#include "log.h"
#include "paths.h"
#include "window.h"
#include "version.h"
#include <shobjidl.h>
#include <cstdarg>
#include <cstdint>

namespace {
// What the first instance publishes under Local\SeaShellHost-<instance>-hwnd so
// a second launch finds its window exactly, never by title: Josh's Electron
// SeaShell is also titled "SeaShell".
struct Handoff { uint64_t hwnd; uint32_t pid; };
const char* kSecondInstance = "{\"k\":\"send\",\"ch\":\"app:secondInstance\",\"p\":{}}";
}

App& App::instance() { static App a; return a; }

void App::log(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  logV(fmt, ap);
  va_end(ap);
}

int App::run(HINSTANCE hinst) { return instance().main(hinst); }

void App::quit(int code) {
  App& a = instance();
  a.exitCode_ = code;
  HWND h = Window::instance().hwnd();
  if (h && IsWindow(h)) {
    saveBounds(Window::instance().bounds());
    DestroyWindow(h);   // WM_DESTROY posts the quit
  } else {
    PostQuitMessage(code);
  }
}

void App::requestQuit() {
  log("quit requested");
  quit(0);
}

void App::onResized() {}

bool App::onInput(HWND, UINT, WPARAM, LPARAM) { return false; }

LRESULT App::onAppMessage(UINT msg, WPARAM, LPARAM l) {
  // Until Task 8 owns these, free what the sender allocated.
  if (msg == Window::WM_APP_CORE_LINE) delete reinterpret_cast<std::string*>(l);
  return 0;
}

void App::onPeerEnvelope(const std::string& json) {
  log("peer envelope %s", json.c_str());   // Task 8 forwards it to the core
}

void App::onWindowDestroyed() {
  if (handoff_) { CloseHandle(handoff_); handoff_ = nullptr; }
  PostQuitMessage(exitCode_);
}

void App::publishWindow(const std::wstring& inst) {
  std::wstring name = L"Local\\SeaShellHost-" + inst + L"-hwnd";
  handoff_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Handoff), name.c_str());
  if (!handoff_) { log("error: CreateFileMapping %lu", GetLastError()); return; }
  if (auto* h = static_cast<Handoff*>(MapViewOfFile(handoff_, FILE_MAP_WRITE, 0, 0, sizeof(Handoff)))) {
    h->pid = GetCurrentProcessId();
    h->hwnd = (uint64_t)(uintptr_t)Window::instance().hwnd();
    UnmapViewOfFile(h);
  }
}

// The mutex is taken: find the first instance's window through its handoff
// mapping (checking class and pid), hand it the envelope, and exit.
bool App::signalFirstInstance(const std::wstring& inst) {
  std::wstring name = L"Local\\SeaShellHost-" + inst + L"-hwnd";
  for (int tries = 0; tries < 50; tries++, Sleep(100)) {   // the first may still be creating its window
    HANDLE m = OpenFileMappingW(FILE_MAP_READ, FALSE, name.c_str());
    if (!m) continue;
    Handoff ho{};
    if (auto* v = static_cast<const Handoff*>(MapViewOfFile(m, FILE_MAP_READ, 0, 0, sizeof(Handoff)))) { ho = *v; UnmapViewOfFile(v); }
    CloseHandle(m);
    HWND h = (HWND)(uintptr_t)ho.hwnd;
    if (!h || !IsWindow(h)) continue;
    wchar_t cls[64] = {};
    DWORD pid = 0;
    GetClassNameW(h, cls, 64);
    GetWindowThreadProcessId(h, &pid);
    if (wcscmp(cls, L"SeaShellHost") != 0 || pid != ho.pid) { log("error: handoff window %p is not ours", (void*)h); return false; }
    COPYDATASTRUCT cds{ Window::kCopyDataEnvelope, (DWORD)strlen(kSecondInstance), (PVOID)kSecondInstance };
    DWORD_PTR res = 0;
    if (!SendMessageTimeoutW(h, WM_COPYDATA, 0, (LPARAM)&cds, SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &res)) {
      log("error: WM_COPYDATA to pid %lu failed %lu", pid, GetLastError());
      return false;
    }
    log("second instance: app:secondInstance sent to pid %lu", pid);
    return true;
  }
  log("error: instance %s is running but published no window", toUtf8(inst).c_str());
  return false;
}

int App::main(HINSTANCE hinst) {
  hinst_ = hinst;
  logOpen(envW(L"SEASHELL_SHELL_LOG"));
  testMode_ = !envW(L"SEASHELL_TEST_PORT").empty();
  std::wstring inst = instanceName();
  log("shell %s start pid %lu instance %s userData %s%s", SEASHELL_VERSION_STR, GetCurrentProcessId(),
      toUtf8(inst).c_str(), toUtf8(userDataWin()).c_str(), testMode_ ? " test" : "");

  mutex_ = CreateMutexW(nullptr, FALSE, (L"Local\\SeaShellHost-" + inst).c_str());
  if (!mutex_) { log("error: CreateMutex %lu", GetLastError()); return 1; }
  if (GetLastError() == ERROR_ALREADY_EXISTS) return signalFirstInstance(inst) ? 0 : 1;

  SetCurrentProcessExplicitAppUserModelID(L"dev.seashell.app");
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(hr)) { log("error: CoInitializeEx 0x%08lx", (unsigned long)hr); return 1; }
  if (!Gfx::instance().init()) return 1;
  if (!Window::instance().create(hinst, testMode_)) return 1;
  publishWindow(inst);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  log("shell exit %d", exitCode_);
  CoUninitialize();
  CloseHandle(mutex_);
  return exitCode_;
}
