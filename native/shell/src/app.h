// The shell's lifetime: single instance, the window, the message loop, quit.
// Later tasks hang the core (Task 8), the driver (Task 9), the grids and the
// UI off the hooks below.
#pragma once
#include <windows.h>
#include <string>
#include "core_proc.h"
#include "model.h"
#include "wire.h"

class App {
public:
  static App& instance();
  static int run(HINSTANCE hinst);                 // wWinMain's whole body; returns the exit code
  static void quit(int code);                      // save bounds, destroy the window, leave the loop
  static void log(const char* fmt, ...);           // one line to SEASHELL_SHELL_LOG and the debugger

  void requestQuit();                              // WM_CLOSE: Task 8 runs the core's drain first
  bool testMode() const { return testMode_; }      // SEASHELL_TEST_PORT is set: never take focus
  HINSTANCE hinst() const { return hinst_; }
  Wire& wire() { return wire_; }
  const UiModel& model() const { return model_; }
  bool coreDead() const { return coreDead_; }        // Task 15 paints every pane's exit overlay

  // Hooks the window calls.
  void onResized();                                // Task 8: shell:geometry
  bool onInput(HWND from, UINT msg, WPARAM w, LPARAM l);   // Tasks 13 and 15; true when handled
  LRESULT onAppMessage(UINT msg, WPARAM w, LPARAM l);      // Window::WM_APP_*
  void onPeerEnvelope(const std::string& json);    // WM_COPYDATA from a second instance
  void onWindowDestroyed();

private:
  int main(HINSTANCE hinst);
  bool signalFirstInstance(const std::wstring& inst);
  void publishWindow(const std::wstring& inst);
  bool startCore();
  void onCoreExit(DWORD code, LPARAM gen);
  static void CALLBACK quitTimeout(HWND, UINT, UINT_PTR, DWORD);

  HINSTANCE hinst_ = nullptr;
  bool testMode_ = false;
  int exitCode_ = 0;
  HANDLE mutex_ = nullptr;
  HANDLE handoff_ = nullptr;                       // file mapping holding this instance's HWND
  CoreProc core_;
  Wire wire_;
  UiModel model_;
  bool coreDead_ = false;                          // died twice, or after its first 5 s: not restarted
  bool coreDied_ = false;                          // an unexpected exit happened (only the first may relaunch)
  bool firstModel_ = false;                        // this core run has sent its first ui:model
  bool quitting_ = false;                          // app:beforeQuit sent, waiting for the core to exit
  UINT_PTR quitTimer_ = 0;
};
