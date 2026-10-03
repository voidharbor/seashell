// The shell's lifetime: single instance, the window, the message loop, quit.
// Later tasks hang the core (Task 8), the driver (Task 9), the grids and the
// UI off the hooks below.
#pragma once
#include <windows.h>
#include <map>
#include <memory>
#include <string>
#include "core_proc.h"
#include "find.h"
#include "grid.h"
#include "grid_input.h"
#include "grid_view.h"
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
  const UiModel& model() const;                    // the applied model, which Ui holds (one copy, moved in)
  bool coreDead() const { return coreDead_; }        // every pane shows "core exited" (Ui::setCoreDead)
  void restartCore();                                // Restart on a dead core: a fresh core run, the grids dropped
  bool coreAlive() const { return core_.alive(); }
  DWORD corePid() const { return core_.pid(); }      // wsl.exe, the shell's own child (the driver's coreKill)
  Grid* grid(const std::string& paneId);             // nullptr when the core never created it
  GridView* view(const std::string& paneId);         // the view drawing that grid, or nullptr
  Grid* focusedGrid();                               // the grid keys go to: the open drawer's while it has focus, else the focused pane's
  std::string focusedGridId() const;                 // its id, "" for none (the driver's stats)
  GridInput& input() { return input_; }
  std::string defaultPaneId() const;                 // the focused pane, else the first grid (the driver's default)

  // Hooks the window calls.
  void onResized();                                // Task 8: shell:geometry
  bool onInput(HWND from, UINT msg, WPARAM w, LPARAM l);   // Ui first, then GridInput; true when handled
  void onActivate(bool active);                    // WM_ACTIVATE: the cursor goes hollow in the background
  LRESULT onAppMessage(UINT msg, WPARAM w, LPARAM l);      // Window::WM_APP_*
  void onPeerEnvelope(const std::string& json);    // WM_COPYDATA from a second instance
  void onWindowDestroyed();
  void paintBody();                                // the body child's WM_PAINT: every visible pane's grid
  // shell:colorization (Task 16): at start, on WM_DWMCOLORIZATIONCOLORCHANGED
  // and WM_DWMCOMPOSITIONCHANGED, and from the driver's test overrides.
  void sendColorization();                         // {argb, opaque, composition} to the core
  void overrideColorization(const nlohmann::json& argb);   // a "#AARRGGBB" string is used instead of DWM's; null reads DWM again
  void overrideComposition(bool on);               // false forces the composition-off branch; true reads DWM again
  static nlohmann::json dwmColorization();         // the real DWM state, read now: {argb, opaque, composition}

private:
  int main(HINSTANCE hinst);
  bool signalFirstInstance(const std::wstring& inst);
  void publishWindow(const std::wstring& inst);
  bool startCore();
  void onCoreExit(DWORD code, LPARAM gen);
  static void CALLBACK quitTimeout(HWND, UINT, UINT_PTR, DWORD);
  void onGridCmd(const nlohmann::json& cmd);
  void onPtyData(const std::string& paneId, const std::string& bytes);
  void drainFeed();                                // WM_APP_PTY_FEED
  static void CALLBACK blinkTick(HWND, UINT, UINT_PTR, DWORD);
  // Find (Task 14): grid:cmd find and findClear and the re-search after
  // output settles. The query's keys are Ui's edit widget's.
  void runFind(const std::string& paneId, const nlohmann::json& cmd);
  void scrollToMatch(const std::string& paneId);
  static void CALLBACK findRefresh(HWND, UINT, UINT_PTR, DWORD);

  HINSTANCE hinst_ = nullptr;
  bool testMode_ = false;
  int exitCode_ = 0;
  HANDLE mutex_ = nullptr;
  HANDLE handoff_ = nullptr;                       // file mapping holding this instance's HWND
  CoreProc core_;
  Wire wire_;
  bool coreDead_ = false;                          // died twice, or after its first 5 s: not restarted
  bool coreDied_ = false;                          // an unexpected exit happened (only the first may relaunch)
  bool windowActive_ = false;                      // the top-level window is the active one
  bool firstModel_ = false;                        // this core run has sent its first ui:model
  bool quitting_ = false;                          // app:beforeQuit sent, waiting for the core to exit
  UINT_PTR quitTimer_ = 0;
  std::map<std::string, std::unique_ptr<Grid>> grids_;   // by pane id, from grid:cmd create
  std::map<std::string, std::unique_ptr<GridView>> views_;   // one per grid, drawing it
  std::map<std::string, size_t> sbCap_;            // each grid's scrollback cap, from grid:cmd create
  GridInput input_;                                // keys, mouse, selection and clipboard (Task 13)
  bool blinkOn_ = true;                            // the cursor blink phase, flipped every 530 ms
  std::map<std::string, std::string> feed_;        // pty bytes waiting for the next WM_APP_PTY_FEED
  bool feedPosted_ = false;
  struct FindRun { std::string query; Finder::Options opt{}; Finder::Result last{}; };
  std::map<std::string, Finder> finders_;          // per pane, while it has a find going
  std::map<std::string, FindRun> findRuns_;        // the pane's last search, re-run 200 ms after output stops
  UINT_PTR findTimer_ = 0;
  bool argbForced_ = false;                        // the driver's colorization override (never DWM's own state)
  std::string argbForce_;
  bool compositionOff_ = false;                    // the driver's composition {on:false}
  long long lineQueueTicks_ = 0;                   // the core line being handled: its post to here, QPC ticks (the driver's modelMs)
};
