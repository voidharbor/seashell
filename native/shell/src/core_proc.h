// The core: node under WSL (spec 4.1, 4.5), spawned once through wsl.exe with
// piped stdio and CREATE_NO_WINDOW. A reader thread posts each stdout line to
// the window as WM_APP_CORE_LINE; a waiter thread posts WM_APP_CORE_EXIT
// (wParam: exit code, lParam: the run's generation, so a stale exit from an
// earlier run is ignored after a relaunch).
#pragma once
#include <windows.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>

class CoreProc {
public:
  ~CoreProc();
  bool start();                         // stages (unless SEASHELL_CORE_DIR), spawns wsl.exe, starts the reader
  void send(const std::string& line);   // appends '\n', writes under a mutex; drops with a log line if the pipe is gone
  bool alive() const; DWORD pid() const;
  void stop(DWORD graceMs);             // sends app:beforeQuit, waits graceMs for exit, then TerminateProcess
  std::wstring commandLine() const;     // for the log

  // The quit drain without blocking the UI thread: sends app:beforeQuit and
  // marks this run's exit as expected (never a crash, never relaunched).
  void beginQuit();
  bool exitExpected() const { return expected_; }   // the shell sent app:beforeQuit or closed the pipe
  LPARAM generation() const { return gen_; }
  ULONGLONG startedTick() const { return started_; }

private:
  struct Run;
  std::shared_ptr<Run> run_;            // the live run; its threads hold their own reference
  mutable std::mutex mu_;               // guards run_ and every write to its stdin
  std::wstring cmd_;
  std::atomic<bool> expected_{ false };
  LPARAM gen_ = 0;
  ULONGLONG started_ = 0;
};
