#include "app.h"
#include "driver.h"
#include "gfx.h"
#include "log.h"
#include "paths.h"
#include "window.h"
#include "version.h"
#include <shobjidl.h>
#include <cstdarg>
#include <cstdint>
#include <memory>

namespace {
// What the first instance publishes under Local\SeaShellHost-<instance>-hwnd so
// a second launch finds its window exactly, never by title: Josh's Electron
// SeaShell is also titled "SeaShell".
struct Handoff { uint64_t hwnd; uint32_t pid; };
const char* kSecondInstance = "{\"k\":\"send\",\"ch\":\"app:secondInstance\",\"p\":{}}";
// main's quit drain is capped at 4 s on win32; the core then exits on its own.
const UINT kQuitGraceMs = 5000;
// A core that dies this soon after starting gets one relaunch (spec 4.5).
const ULONGLONG kEarlyDeathMs = 5000;
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

// WM_CLOSE: run the core's quit drain (app:beforeQuit, which snapshots the
// session and reaps the panes), then close once it exits or the grace runs out.
void App::requestQuit() {
  log("quit requested");
  if (quitting_) return;
  if (!core_.alive()) { quit(0); return; }
  quitting_ = true;
  core_.beginQuit();
  log("app:beforeQuit sent");
  quitTimer_ = SetTimer(nullptr, 0, kQuitGraceMs, quitTimeout);
}

void CALLBACK App::quitTimeout(HWND, UINT, UINT_PTR id, DWORD) {
  App& a = instance();
  KillTimer(nullptr, id);
  a.quitTimer_ = 0;
  log("core still running %u ms after app:beforeQuit; ending it", kQuitGraceMs);
  a.core_.stop(0);
  quit(0);
}

bool App::startCore() {
  firstModel_ = false;
  if (!core_.start()) {
    coreDead_ = true;
    log("coreDead: the core did not start");
    return false;
  }
  wire_.sendGeometry();   // the controller boots on the first geometry
  return true;
}

void App::onCoreExit(DWORD code, LPARAM gen) {
  if (gen != core_.generation()) { log("core exit code %lu from an earlier run; ignored", code); return; }
  ULONGLONG ran = GetTickCount64() - core_.startedTick();
  log("core exit code %lu after %llu ms", code, ran);
  wire_.reset();
  if (quitting_) {
    if (quitTimer_) { KillTimer(nullptr, quitTimer_); quitTimer_ = 0; }
    quit(0);
    return;
  }
  // The shell sent app:beforeQuit or closed the pipe: a normal exit, not a crash.
  if (core_.exitExpected()) return;
  bool first = !coreDied_;
  coreDied_ = true;
  if (first && ran < kEarlyDeathMs) {
    log("core relaunch: it exited within %llu ms of starting", kEarlyDeathMs);
    if (startCore()) return;
  }
  coreDead_ = true;
  // Task 15 paints "core exited" on every pane and shows this as the toast.
  log("coreDead: The SeaShell core stopped (code %lu). Restart a pane or quit.", code);
  Window::instance().invalidateStrip();
  Window::instance().invalidateBody();
}

void App::onResized() {
  HWND h = Window::instance().hwnd();
  if (!core_.alive() || quitting_ || !h || IsIconic(h)) return;
  RECT rc{};
  GetClientRect(h, &rc);
  if (rc.right <= rc.left || rc.bottom <= rc.top) return;
  wire_.sendGeometry();
}

bool App::onInput(HWND, UINT, WPARAM, LPARAM) { return false; }

LRESULT App::onAppMessage(UINT msg, WPARAM w, LPARAM l) {
  if (msg == Window::WM_APP_CORE_LINE) {
    std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(l));
    wire_.onCoreLine(std::move(*line));
  } else if (msg == Window::WM_APP_CORE_EXIT) {
    onCoreExit((DWORD)w, l);
  } else if (msg == Window::WM_APP_DRIVER) {
    Driver::instance().onCall(reinterpret_cast<DriverCall*>(l));
  }
  return 0;
}

// A second launch hands over app:secondInstance; nothing else is relayed.
void App::onPeerEnvelope(const std::string& json) {
  nlohmann::json e = nlohmann::json::parse(json, nullptr, false);
  bool ok = !e.is_discarded() && e.is_object() && e.value("k", "") == "send" && e.value("ch", "") == "app:secondInstance";
  if (!ok) { log("error: peer envelope refused: %.200s", json.c_str()); return; }
  if (!core_.alive()) { log("app:secondInstance dropped: no core"); return; }
  core_.send(json);
  log("app:secondInstance sent to the core");
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
  if (testMode_) Driver::instance().start();   // a failed listener is logged; the shell still runs

  wire_.write = [this](const std::string& line) { core_.send(line); };
  wire_.onModel = [this](const UiModel& m) {
    model_ = m;
    Window::instance().invalidateStrip();   // Task 15 draws it
    Window::instance().invalidateBody();
    if (!firstModel_) {
      firstModel_ = true;
      wire_.sendGeometry();
    }
  };
  // Task 11 feeds the grids; until then the byte counts prove the wire.
  wire_.onPtyData = [](const std::string& paneId, const std::string& bytes) {
    Driver::instance().notePtyBytes(bytes.size());
    log("on pty:data pane %s bytes %zu", paneId.c_str(), bytes.size());
  };
  wire_.onGridCmd = [](const nlohmann::json& cmd) {
    log("on grid:cmd %s %s", cmd.value("op", "?").c_str(), cmd.value("paneId", "?").c_str());
  };
  startCore();

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  Driver::instance().stop();
  core_.stop(2000);   // a no-op once the drain above let it exit
  log("shell exit %d", exitCode_);
  CoUninitialize();
  CloseHandle(mutex_);
  return exitCode_;
}
