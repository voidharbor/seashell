#include "core_proc.h"
#include "app.h"
#include "paths.h"
#include "window.h"
#include "version.h"
#include <shlobj.h>
#include <thread>
#include <vector>

namespace {
const char* kBeforeQuit = "{\"k\":\"send\",\"ch\":\"app:beforeQuit\",\"p\":{}}";
const wchar_t* kDistro = L"Ubuntu-24.04";

// CommandLineToArgvW's rules: quote an argument holding a space, tab or quote,
// doubling the backslashes that precede a quote.
std::wstring quoteArg(const std::wstring& a) {
  if (!a.empty() && a.find_first_of(L" \t\"") == std::wstring::npos) return a;
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : a) {
    if (c == L'\\') { slashes++; continue; }
    if (c == L'"') out.append(slashes * 2 + 1, L'\\');
    else out.append(slashes, L'\\');
    slashes = 0;
    out += c;
  }
  out.append(slashes * 2, L'\\');
  return out + L"\"";
}

void closeH(HANDLE& h) {
  if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
  h = nullptr;
}

// Post to the window; when its queue is full (10 000 posted messages) wait,
// which stops the reader, fills the pipe and so throttles the core's writes.
bool postToWindow(UINT msg, WPARAM w, LPARAM l) {
  for (;;) {
    HWND h = Window::instance().hwnd();
    if (!h || !IsWindow(h)) return false;
    if (PostMessageW(h, msg, w, l)) return true;
    Sleep(5);
  }
}

// Bytes of core lines posted and not yet handled on the UI thread. A pty:data
// line can be a megabyte of base64, so the message count alone does not bound
// the shell: past this cap the reader waits, the pipe fills and the core's
// writes (and the pty reads behind them) are throttled.
const size_t kMaxQueuedLineBytes = 16u << 20;
std::atomic<size_t> g_queuedLineBytes{ 0 };

bool postLine(std::string* line) {
  size_t n = line->size();
  while (g_queuedLineBytes.load() > kMaxQueuedLineBytes) {
    HWND h = Window::instance().hwnd();
    if (!h || !IsWindow(h)) return false;
    Sleep(2);
  }
  g_queuedLineBytes += n;
  if (postToWindow(Window::WM_APP_CORE_LINE, 0, (LPARAM)line)) return true;
  g_queuedLineBytes -= n;
  return false;
}
}  // namespace

void CoreProc::lineHandled(size_t bytes) { g_queuedLineBytes -= bytes; }

struct CoreProc::Run {
  HANDLE proc = nullptr;
  HANDLE stdinW = nullptr;
  HANDLE stdoutR = nullptr;
  HANDLE readerDone = nullptr;
  DWORD pid = 0;
  LPARAM gen = 0;
  ~Run() { closeH(proc); closeH(stdinW); closeH(stdoutR); closeH(readerDone); }
};

CoreProc::~CoreProc() {}

std::wstring CoreProc::commandLine() const { return cmd_; }

bool CoreProc::alive() const {
  std::lock_guard<std::mutex> lock(mu_);
  return run_ && run_->proc && WaitForSingleObject(run_->proc, 0) == WAIT_TIMEOUT;
}

DWORD CoreProc::pid() const {
  std::lock_guard<std::mutex> lock(mu_);
  return run_ ? run_->pid : 0;
}

bool CoreProc::start() {
  // Task 17 stages the bundle under ~/.cache/seashell-win/core/<version>; until
  // then a dev run names the bundle directory itself.
  std::wstring coreDir = envW(L"SEASHELL_CORE_DIR");
  if (coreDir.empty()) {
    App::log("error: SEASHELL_CORE_DIR is not set and core staging does not exist yet; the core was not started");
    return false;
  }
  while (coreDir.size() > 1 && coreDir.back() == L'/') coreDir.pop_back();

  std::wstring userData = userDataWin();
  SHCreateDirectoryExW(nullptr, userData.c_str(), nullptr);   // fine when it exists

  SECURITY_ATTRIBUTES sa{ sizeof sa, nullptr, TRUE };
  HANDLE inR = nullptr, inW = nullptr, outR = nullptr, outW = nullptr;
  if (!CreatePipe(&inR, &inW, &sa, 64 * 1024) || !CreatePipe(&outR, &outW, &sa, 64 * 1024)) {
    App::log("error: CreatePipe %lu", GetLastError());
    closeH(inR); closeH(inW); closeH(outR); closeH(outW);
    return false;
  }
  // Only the child's ends are inheritable.
  SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  HANDLE errH = CreateFileW((userData + L"\\core.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (errH == INVALID_HANDLE_VALUE) {
    App::log("error: core.log %lu; core stderr goes to NUL", GetLastError());
    errH = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  }

  wchar_t sysDir[MAX_PATH] = {};
  GetSystemDirectoryW(sysDir, MAX_PATH);
  std::wstring wsl = std::wstring(sysDir) + L"\\wsl.exe";
  std::vector<std::wstring> args = {
    wsl, L"-d", kDistro, L"--cd", L"~", L"-e", L"env",
    L"SEASHELL_HOST=native-win",
    L"SEASHELL_HOST_PID=" + std::to_wstring(GetCurrentProcessId()),
    L"SEASHELL_USER_DATA=" + fromUtf8(userDataLinux()),
    L"SEASHELL_CORE_VERSION=" + fromUtf8(SEASHELL_VERSION_STR),
    L"SEASHELL_INSTANCE=" + instanceName(),
  };
  std::wstring cdp = envW(L"SEASHELL_CDP_PORT");
  if (!cdp.empty()) args.push_back(L"SEASHELL_CDP_PORT=" + cdp);
  args.push_back(L"/usr/bin/node");
  args.push_back(coreDir + L"/index.cjs");
  std::wstring cmd;
  for (const auto& a : args) { if (!cmd.empty()) cmd += L' '; cmd += quoteArg(a); }

  // Inherit exactly the three stdio handles, nothing else the shell holds open.
  HANDLE inherit[3] = { inR, outW, errH };
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<char> attrBuf(attrSize);
  auto* attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  bool attrsOk = InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize) &&
                 UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof inherit, nullptr, nullptr);
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = inR;
  si.StartupInfo.hStdOutput = outW;
  si.StartupInfo.hStdError = errH;
  si.lpAttributeList = attrsOk ? attrs : nullptr;
  PROCESS_INFORMATION pi{};
  std::wstring cmdBuf = cmd;
  BOOL ok = CreateProcessW(wsl.c_str(), cmdBuf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | (attrsOk ? EXTENDED_STARTUPINFO_PRESENT : 0), nullptr, nullptr,
                           &si.StartupInfo, &pi);
  DWORD err = GetLastError();
  if (attrsOk) DeleteProcThreadAttributeList(attrs);
  closeH(inR); closeH(outW); closeH(errH);
  cmd_ = cmd;
  if (!ok) {
    App::log("error: CreateProcess wsl.exe %lu: %s", err, toUtf8(cmd).c_str());
    closeH(inW); closeH(outR);
    return false;
  }
  CloseHandle(pi.hThread);

  auto run = std::make_shared<Run>();
  run->proc = pi.hProcess;
  run->pid = pi.dwProcessId;
  run->stdinW = inW;
  run->stdoutR = outR;
  run->readerDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  {
    std::lock_guard<std::mutex> lock(mu_);
    run->gen = ++gen_;
    run_ = run;
    expected_ = false;
    started_ = GetTickCount64();
  }

  std::thread([run] {
    std::vector<char> buf(64 * 1024);
    std::string pending;
    DWORD got = 0;
    while (ReadFile(run->stdoutR, buf.data(), (DWORD)buf.size(), &got, nullptr) && got > 0) {
      pending.append(buf.data(), got);
      size_t start = 0, nl;
      while ((nl = pending.find('\n', start)) != std::string::npos) {
        size_t end = nl;
        if (end > start && pending[end - 1] == '\r') end--;
        if (end > start) {
          auto* line = new std::string(pending, start, end - start);
          if (!postLine(line)) delete line;
        }
        start = nl + 1;
      }
      pending.erase(0, start);
    }
    SetEvent(run->readerDone);
  }).detach();

  std::thread([run] {
    WaitForSingleObject(run->proc, INFINITE);
    WaitForSingleObject(run->readerDone, 2000);   // the last lines land before the exit
    DWORD code = 0;
    GetExitCodeProcess(run->proc, &code);
    postToWindow(Window::WM_APP_CORE_EXIT, (WPARAM)code, run->gen);
  }).detach();

  App::log("core started pid %lu: %s", run->pid, toUtf8(cmd).c_str());
  return true;
}

void CoreProc::send(const std::string& line) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!run_ || !run_->stdinW) {
    App::log("core pipe gone; dropped %zu bytes", line.size());
    return;
  }
  std::string out = line + "\n";
  const char* p = out.data();
  size_t left = out.size();
  while (left > 0) {
    DWORD w = 0;
    if (!WriteFile(run_->stdinW, p, (DWORD)left, &w, nullptr)) {
      App::log("error: core pipe write %lu; dropped %zu bytes", GetLastError(), left);
      closeH(run_->stdinW);
      return;
    }
    p += w;
    left -= w;
  }
}

void CoreProc::beginQuit() {
  expected_ = true;
  send(kBeforeQuit);
}

void CoreProc::stop(DWORD graceMs) {
  if (!alive()) return;
  beginQuit();
  std::shared_ptr<Run> run;
  {
    std::lock_guard<std::mutex> lock(mu_);
    run = run_;
    closeH(run->stdinW);   // the core also quits through main's drain when its stdin closes
  }
  if (WaitForSingleObject(run->proc, graceMs) == WAIT_TIMEOUT) {
    App::log("core pid %lu did not exit in %lu ms; terminating", run->pid, graceMs);
    TerminateProcess(run->proc, 1);
    WaitForSingleObject(run->proc, 1000);
  }
}
