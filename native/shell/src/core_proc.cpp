#include "core_proc.h"
#include "app.h"
#include "paths.h"
#include "window.h"
#include "version.h"
#include "wsl_distro.h"
#include <shlobj.h>
#include <algorithm>
#include <cstring>
#include <condition_variable>
#include <deque>
#include <thread>
#include <vector>

namespace {
const char* kBeforeQuit = "{\"k\":\"send\",\"ch\":\"app:beforeQuit\",\"p\":{}}";

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
// What send() queues for a core that is not reading its stdin before it drops.
const size_t kMaxOutboxBytes = 16u << 20;
std::atomic<size_t> g_queuedLineBytes{ 0 };

std::wstring joinArgs(const std::vector<std::wstring>& args) {
  std::wstring cmd;
  for (const auto& a : args) { if (!cmd.empty()) cmd += L' '; cmd += quoteArg(a); }
  return cmd;
}

// The directory holding SeaShell.exe.
std::wstring exeDir() {
  std::wstring p(32768, L'\0');
  DWORD n = GetModuleFileNameW(nullptr, p.data(), (DWORD)p.size());
  p.resize(n);
  size_t slash = p.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : p.substr(0, slash);
}

// The installed build is the exe at ...\AppData\Local\Programs\SeaShell\SeaShell.exe
// (compared case-insensitively); a test run (SEASHELL_TEST_PORT) may also ask
// for it with SEASHELL_TEST_INSTALLED=1. Only that build gets SEASHELL_INSTALLED=1,
// which turns the core's update check on. Worked out and logged once.
bool shellInstalled() {
  static const bool installed = [] {
    std::wstring p(32768, L'\0');
    DWORD n = GetModuleFileNameW(nullptr, p.data(), (DWORD)p.size());
    p.resize(n < p.size() ? n : 0);
    const std::wstring suffix = L"\\AppData\\Local\\Programs\\SeaShell\\SeaShell.exe";
    bool byPath = p.size() >= suffix.size() &&
                  CompareStringOrdinal(p.c_str() + (p.size() - suffix.size()), (int)suffix.size(), suffix.c_str(),
                                       (int)suffix.size(), TRUE) == CSTR_EQUAL;
    bool byTest = App::instance().testMode() && envW(L"SEASHELL_TEST_INSTALLED") == L"1";
    App::log("installed: %d", (byPath || byTest) ? 1 : 0);
    return byPath || byTest;
  }();
  return installed;
}

const DWORD kStageTimeoutMs = 60000;

// Spec 4.5: copy resources\core into ~/.cache/seashell-win/core/<version> with
// stage-core.sh (a no-op when VERSION and BUILD already match) and return the
// staged directory it prints, Linux form. "" on any failure, logged, with
// the reason in words in `why`.
std::wstring stageCore(const std::wstring& distro, std::string& how, std::wstring& why) {
  std::wstring res = exeDir() + L"\\resources";
  for (const wchar_t* f : { L"\\stage-core.sh", L"\\core\\index.cjs" }) {
    if (GetFileAttributesW((res + f).c_str()) == INVALID_FILE_ATTRIBUTES) {
      App::log("error: core staging: %s is missing and SEASHELL_CORE_DIR is not set; the core was not started",
               toUtf8(res + f).c_str());
      why = res + f + L" is missing. Unzip the whole SeaShell folder again.";
      return L"";
    }
  }
  std::wstring wsl = wslExe();
  std::wstring cmd = joinArgs({ wsl, L"-d", distro, L"-e", L"sh", fromUtf8(toLinuxPath(res + L"\\stage-core.sh")),
                                fromUtf8(toLinuxPath(res + L"\\core")), fromUtf8(SEASHELL_VERSION_STR) });
  SECURITY_ATTRIBUTES sa{ sizeof sa, nullptr, TRUE };
  HANDLE outR = nullptr, outW = nullptr;
  if (!CreatePipe(&outR, &outW, &sa, 64 * 1024)) {
    App::log("error: core staging: CreatePipe %lu", GetLastError());
    why = L"CreatePipe failed.";
    return L"";
  }
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  PROCESS_INFORMATION pi{};
  DWORD err = 0;
  bool ok = spawnHidden(wsl, cmd, nul, outW, outW, pi, err);
  closeH(outW); closeH(nul);
  if (!ok) {
    App::log("error: core staging: CreateProcess wsl.exe %lu: %s", err, toUtf8(cmd).c_str());
    why = L"wsl.exe did not start (error " + std::to_wstring(err) + L"). Is WSL installed?";
    closeH(outR);
    return L"";
  }
  CloseHandle(pi.hThread);
  // Read as it comes (never blocks: only what PeekNamedPipe says is there),
  // until the process ends or the timeout.
  std::string out;
  ULONGLONG end = GetTickCount64() + kStageTimeoutMs;
  bool exited = false;
  for (;;) {
    DWORD avail = 0;
    while (PeekNamedPipe(outR, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
      char buf[4096];
      DWORD got = 0;
      if (!ReadFile(outR, buf, std::min<DWORD>(avail, sizeof buf), &got, nullptr) || got == 0) break;
      out.append(buf, got);
    }
    if (exited) break;
    if (WaitForSingleObject(pi.hProcess, 50) == WAIT_OBJECT_0) { exited = true; continue; }   // one last read
    if (GetTickCount64() >= end) break;
  }
  DWORD code = 1;
  if (!exited) {
    App::log("error: core staging did not finish in %lu ms; ending it: %s", kStageTimeoutMs, toUtf8(cmd).c_str());
    TerminateProcess(pi.hProcess, 1);
  } else {
    GetExitCodeProcess(pi.hProcess, &code);
  }
  CloseHandle(pi.hProcess);
  closeH(outR);
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
  for (char& c : out) if (c == '\r' || c == '\n') c = ' ';
  App::log("core staging exit %lu: %s", code, out.c_str());
  if (!exited || code != 0) {
    // wsl.exe's own errors come back as UTF-16; drop the NULs so the words survive.
    std::string said;
    for (char c : out) if (c != '\0') said += c;
    if (said.size() > 400) said = said.substr(said.size() - 400);
    why = !exited ? L"Copying the core into WSL did not finish in " + std::to_wstring(kStageTimeoutMs / 1000) + L" seconds."
                  : L"Copying the core into WSL failed (exit " + std::to_wstring(code) + L"): " + fromUtf8(said);
    return L"";
  }
  // The last line is "staged <dst>" or "current <dst>".
  std::string last = out;
  for (const char* tag : { "staged ", "current " }) {
    size_t at = last.rfind(tag);
    if (at != std::string::npos && (at == 0 || last[at - 1] == ' ')) {
      std::string dst = last.substr(at + strlen(tag));
      if (!dst.empty() && dst[0] == '/') { how = std::string(tag, strlen(tag) - 1); return fromUtf8(dst); }
    }
  }
  App::log("error: core staging printed no staged directory");
  why = L"Copying the core into WSL printed no staged folder: " + fromUtf8(out);
  return L"";
}

bool postLine(std::string* line) {
  size_t n = line->size();
  while (g_queuedLineBytes.load() > kMaxQueuedLineBytes) {
    HWND h = Window::instance().hwnd();
    if (!h || !IsWindow(h)) return false;
    Sleep(2);
  }
  g_queuedLineBytes += n;
  // wParam carries the post time (QPC) for the driver's queue hop in modelMs.
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  if (postToWindow(Window::WM_APP_CORE_LINE, (WPARAM)t.QuadPart, (LPARAM)line)) return true;
  g_queuedLineBytes -= n;
  return false;
}
}  // namespace

bool spawnHidden(const std::wstring& exe, const std::wstring& cmd, HANDLE in, HANDLE out, HANDLE err,
                 PROCESS_INFORMATION& pi, DWORD& lastError) {
  // The handle list refuses a duplicate (ERROR_INVALID_PARAMETER), and stdout
  // and stderr may be one handle.
  HANDLE inherit[3] = { in, out, err };
  DWORD count = 0;
  for (HANDLE h : { in, out, err })
    if (std::find(inherit, inherit + count, h) == inherit + count) inherit[count++] = h;
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<char> attrBuf(attrSize);
  auto* attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  bool attrsOk = InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize) &&
                 UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, count * sizeof(HANDLE), nullptr, nullptr);
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = in;
  si.StartupInfo.hStdOutput = out;
  si.StartupInfo.hStdError = err;
  si.lpAttributeList = attrsOk ? attrs : nullptr;
  pi = PROCESS_INFORMATION{};
  std::wstring cmdBuf = cmd;
  BOOL ok = CreateProcessW(exe.c_str(), cmdBuf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | (attrsOk ? EXTENDED_STARTUPINFO_PRESENT : 0), nullptr, nullptr,
                           &si.StartupInfo, &pi);
  lastError = GetLastError();
  if (attrsOk) DeleteProcThreadAttributeList(attrs);
  return ok != FALSE;
}

std::wstring wslExe() {
  wchar_t sysDir[MAX_PATH] = {};
  GetSystemDirectoryW(sysDir, MAX_PATH);
  return std::wstring(sysDir) + L"\\wsl.exe";
}

void CoreProc::lineHandled(size_t bytes) { g_queuedLineBytes -= bytes; }

struct CoreProc::Run {
  HANDLE proc = nullptr;
  HANDLE stdinW = nullptr;
  HANDLE stdoutR = nullptr;
  HANDLE readerDone = nullptr;
  DWORD pid = 0;
  LPARAM gen = 0;
  // send() queues here and returns; the writer thread alone writes stdinW, so
  // the UI thread never blocks on a core whose stdin pipe is full (it may be
  // stuck writing its stdout to a reader that waits on the UI thread).
  std::mutex outMu;
  std::condition_variable outCv;
  std::deque<std::string> outbox;
  size_t outBytes = 0;
  bool closing = false;   // the writer drains the outbox, closes stdinW and ends
  void close() {
    { std::lock_guard<std::mutex> lock(outMu); closing = true; }
    outCv.notify_all();
  }
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
  // A dev run names the bundle directory itself; otherwise the release layout's
  // resources\core is staged into the distro once per shell process (spec 4.5).
  lastError_.clear();
  const std::wstring& distro = wslDistro();
  if (distro.empty()) {
    lastError_ = wslDistroPick().error;
    App::log("error: no WSL distro; the core was not started");
    return false;
  }
  std::wstring coreDir = envW(L"SEASHELL_CORE_DIR");
  std::string how = "SEASHELL_CORE_DIR";
  // The staged core carries its own node (stage-core.sh, fetch-node.sh), the
  // build node-pty was made for, so the distro needs none. A dev run naming
  // its bundle uses SEASHELL_NODE, else the first node on the distro's PATH.
  std::wstring node;
  if (coreDir.empty()) {
    if (stagedDir_.empty()) stagedDir_ = stageCore(distro, stagedHow_, lastError_);
    if (stagedDir_.empty()) return false;
    coreDir = stagedDir_;
    how = stagedHow_;
    while (coreDir.size() > 1 && coreDir.back() == L'/') coreDir.pop_back();
    node = coreDir + L"/node/bin/node";
  } else {
    node = envW(L"SEASHELL_NODE");
    if (node.empty()) node = L"node";
  }
  while (coreDir.size() > 1 && coreDir.back() == L'/') coreDir.pop_back();
  App::log("core dir %s (%s), node %s, distro %s", toUtf8(coreDir).c_str(), how.c_str(), toUtf8(node).c_str(),
           toUtf8(distro).c_str());

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

  std::wstring wsl = wslExe();
  std::vector<std::wstring> args = {
    wsl, L"-d", distro, L"--cd", L"~", L"-e", L"env",
    L"SEASHELL_HOST=native-win",
    L"SEASHELL_HOST_PID=" + std::to_wstring(GetCurrentProcessId()),
    L"SEASHELL_USER_DATA=" + fromUtf8(userDataLinux()),
    L"SEASHELL_CORE_VERSION=" + fromUtf8(SEASHELL_VERSION_STR),
    L"SEASHELL_INSTANCE=" + instanceName(),
    L"SEASHELL_WSL_DISTRO=" + distro,
  };
  std::wstring cdp = envW(L"SEASHELL_CDP_PORT");
  if (!cdp.empty()) args.push_back(L"SEASHELL_CDP_PORT=" + cdp);
  // Under the test driver the core accepts the driver's test:* sends (coreSend; Task 14).
  if (!envW(L"SEASHELL_TEST_PORT").empty()) args.push_back(L"SEASHELL_TEST_MODE=1");
  if (shellInstalled()) args.push_back(L"SEASHELL_INSTALLED=1");
  // A test run may point the update check at a local release (updater.ts reads
  // these two); outside test mode the core never sees them and asks GitHub.
  if (App::instance().testMode()) {
    for (const wchar_t* name : { L"SEASHELL_UPDATE_API", L"SEASHELL_UPDATE_ORIGIN" }) {
      std::wstring v = envW(name);
      if (!v.empty()) args.push_back(std::wstring(name) + L"=" + v);
    }
  }
  args.push_back(node);
  // global.gc for the core's idle collector (src/core/idle-gc.ts).
  args.push_back(L"--expose-gc");
  args.push_back(coreDir + L"/index.cjs");
  std::wstring cmd = joinArgs(args);

  PROCESS_INFORMATION pi{};
  DWORD err = 0;
  bool ok = spawnHidden(wsl, cmd, inR, outW, errH, pi, err);
  closeH(inR); closeH(outW); closeH(errH);
  cmd_ = cmd;
  if (!ok) {
    App::log("error: CreateProcess wsl.exe %lu: %s", err, toUtf8(cmd).c_str());
    lastError_ = L"wsl.exe did not start (error " + std::to_wstring(err) + L"). Is WSL installed?";
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
    for (;;) {
      std::string chunk;
      {
        std::unique_lock<std::mutex> lock(run->outMu);
        run->outCv.wait(lock, [&] { return !run->outbox.empty() || run->closing; });
        if (run->outbox.empty()) break;   // closing and drained
        chunk = std::move(run->outbox.front());
        run->outbox.pop_front();
        run->outBytes -= chunk.size();
      }
      const char* p = chunk.data();
      size_t left = chunk.size();
      while (left > 0) {
        DWORD w = 0;
        if (!WriteFile(run->stdinW, p, (DWORD)left, &w, nullptr)) {
          App::log("error: core pipe write %lu; dropped %zu bytes", GetLastError(), left);
          std::lock_guard<std::mutex> lock(run->outMu);
          run->closing = true;
          run->outbox.clear();
          run->outBytes = 0;
          break;
        }
        p += w;
        left -= w;
      }
    }
    closeH(run->stdinW);   // the core also quits through main's drain when its stdin closes
  }).detach();

  std::thread([run] {
    WaitForSingleObject(run->proc, INFINITE);
    run->close();   // the writer has nobody to write to
    WaitForSingleObject(run->readerDone, 2000);   // the last lines land before the exit
    DWORD code = 0;
    GetExitCodeProcess(run->proc, &code);
    postToWindow(Window::WM_APP_CORE_EXIT, (WPARAM)code, run->gen);
  }).detach();

  App::log("core started pid %lu: %s", run->pid, toUtf8(cmd).c_str());
  return true;
}

void CoreProc::send(const std::string& line) {
  std::shared_ptr<Run> run;
  {
    std::lock_guard<std::mutex> lock(mu_);
    run = run_;
  }
  if (!run) {
    App::log("core pipe gone; dropped %zu bytes", line.size());
    return;
  }
  std::lock_guard<std::mutex> lock(run->outMu);
  if (run->closing) {
    App::log("core pipe gone; dropped %zu bytes", line.size());
    return;
  }
  if (run->outBytes + line.size() + 1 > kMaxOutboxBytes) {
    App::log("error: core is not reading its stdin; dropped %zu bytes", line.size());
    return;
  }
  run->outbox.push_back(line + "\n");
  run->outBytes += line.size() + 1;
  run->outCv.notify_one();
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
  }
  run->close();   // the writer sends app:beforeQuit, then closes the core's stdin
  if (WaitForSingleObject(run->proc, graceMs) == WAIT_TIMEOUT) {
    App::log("core pid %lu did not exit in %lu ms; terminating", run->pid, graceMs);
    TerminateProcess(run->proc, 1);
    WaitForSingleObject(run->proc, 1000);
  }
}
