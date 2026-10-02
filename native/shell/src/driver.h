// The loopback test driver (SEASHELL_TEST_PORT; 0 picks any free port). A
// listener thread accepts on 127.0.0.1 and writes <userData>\test.json with
// {port, token}. Each request is one JSON line {token, cmd, ...}, each reply one
// JSON line. Commands run on the UI thread: the connection thread posts
// WM_APP_DRIVER with a DriverCall* and waits on its event. `wait` polls the
// model from the connection thread; `quit` replies, then posts WM_CLOSE.
#pragma once
#include <winsock2.h>
#include <windows.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <deque>
#include <string>
#include <thread>

// One request handed to the UI thread. Reference counted: the connection
// thread may give up waiting while the message is still queued.
struct DriverCall {
  nlohmann::json req;
  nlohmann::json reply;
  HANDLE done = nullptr;   // set by the UI thread once reply is filled
  std::atomic<int> refs{ 1 };
  void release() { if (--refs == 0) { if (done) CloseHandle(done); delete this; } }
};

class Driver {
public:
  static Driver& instance();
  bool start();                     // test mode only: listen, write test.json; false logs why
  void stop();                      // close the listener, remove test.json
  void onCall(DriverCall* c);       // UI thread, WM_APP_DRIVER; fills the reply, sets done, releases

  // Stats hooks, UI thread.
  void noteFrame(double ms);        // one body paint, BeginDraw to EndDraw
  void notePtyBytes(size_t n);      // decoded pty:data bytes for any pane

  // GetKeyState(vk) < 0, except while the driver dispatches a `key` chord:
  // then the chord's own Ctrl, Shift and Alt (Task 13's key path asks here).
  static bool keyDown(int vk);

private:
  void acceptLoop();
  void serve(SOCKET s);
  nlohmann::json handle(const nlohmann::json& req);          // connection thread
  nlohmann::json onUi(const nlohmann::json& req);            // posts to the UI thread and waits
  nlohmann::json execute(const nlohmann::json& req);         // UI thread
  nlohmann::json key(const std::string& chord);
  nlohmann::json text(const std::string& s);
  nlohmann::json click(const nlohmann::json& req, const char* type);
  nlohmann::json drag(const nlohmann::json& req);            // connection thread: press, waited moves, release
  nlohmann::json dragStep(const nlohmann::json& req);        // UI thread: one part of a drag
  nlohmann::json stats();
  nlohmann::json grid(const std::string& paneId);
  nlohmann::json coreKill();

  SOCKET listen_ = INVALID_SOCKET;
  std::thread acceptor_;
  std::string token_;
  std::wstring testJson_;
  std::atomic<bool> running_{ false };
  struct Sample { ULONGLONG at; double v; };
  std::deque<Sample> frames_, ptyBytes_;   // the last 5 s, UI thread only
  int heldMods_ = -1;                      // -1, or the kMod* bits (driver.cpp) while dispatching a chord
  HWND dragWin_ = nullptr;                 // the window a driver drag pressed in, UI thread only
  float dragX_ = 0, dragY_ = 0;            // the press point, client pixels of the top-level window
};
