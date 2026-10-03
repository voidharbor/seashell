// The loopback test driver (SEASHELL_TEST_PORT; 0 picks any free port). A
// listener thread accepts on 127.0.0.1 and writes <userData>\test.json with
// {port, token}. Each request is one JSON line {token, cmd, ...}, each reply one
// JSON line. Commands run on the UI thread: the connection thread posts
// WM_APP_DRIVER with a DriverCall* and waits on its event. `wait` polls the
// model from the connection thread; `quit` replies, then posts WM_CLOSE;
// `pingCore` times core:ping round trips from the connection thread; `drag`
// waits for each move's model on a condition variable that the UI thread
// signals once Ui::setModel has applied it (noteModel). `wheel` sends a
// WM_MOUSEWHEEL, `scrollTo` sets a view's scroll offset, `rows` lists the
// explorer's rows as drawn, `coreSend {ch, p}` writes a send envelope to the
// core (its test:update stands in for main's updater). `drop {paneId?, target?,
// paths?, text?}` takes a data object through the body's DropTarget.
#pragma once
#include <winsock2.h>
#include <windows.h>
#include <nlohmann/json.hpp>
#include <array>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

// One request handed to the UI thread. Reference counted: the connection
// thread may give up waiting while the message is still queued.
struct DriverCall {
  nlohmann::json req;
  nlohmann::json reply;
  std::function<nlohmann::json()> run;   // when set, the UI thread runs this instead of execute(req) (pingCore's invoke)
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
  void noteModel(double seq);       // a ui:model has been applied (after Ui::setModel); wakes a drag step waiting for it if it moved the dragged divider or grip
  // The model path (stats' modelMs, medians over the last 200 models): per
  // ui:model the reader-to-UI queue hop, the JSON parse, UiModel::parse,
  // Ui::setModel, and the apply from the end of the build to the end of
  // onModel around it; then each surface's gap from the model's invalidate to
  // the end of the paint that follows it.
  void noteModelPath(double queueMs, double parseMs, double buildMs, double layoutMs, double applyMs);
  void noteModelInvalidated(bool strip);   // the model invalidated the body, and the strip when `strip`
  void notePaint(bool strip, LONGLONG beginQpc, LONGLONG endQpc);   // one strip or body paint, QPC ticks
  static double ticksMs(LONGLONG qpcTicks);

  // GetKeyState(vk) < 0, except while the driver dispatches a `key` chord:
  // then the chord's own Ctrl, Shift and Alt (Task 13's key path asks here).
  static bool keyDown(int vk);

private:
  void acceptLoop();
  void serve(SOCKET s);
  nlohmann::json handle(const nlohmann::json& req);          // connection thread
  nlohmann::json onUi(const nlohmann::json& req, std::function<nlohmann::json()> run = nullptr);   // posts to the UI thread and waits
  nlohmann::json execute(const nlohmann::json& req);         // UI thread
  nlohmann::json key(const std::string& chord);
  nlohmann::json text(const std::string& s);
  nlohmann::json click(const nlohmann::json& req, const char* type);
  nlohmann::json drag(const nlohmann::json& req);            // connection thread: press, waited moves, release
  nlohmann::json dragStep(const nlohmann::json& req);        // UI thread: one part of a drag
  nlohmann::json pingCore(const nlohmann::json& req);        // connection thread: n sequential core:ping invokes, timed
  nlohmann::json stats();
  nlohmann::json grid(const std::string& paneId);
  nlohmann::json coreKill();
  nlohmann::json wheel(const nlohmann::json& req);           // UI thread: one WM_MOUSEWHEEL through the window procedure
  nlohmann::json rows();                                     // UI thread: the explorer rows as drawn
  nlohmann::json drop(const nlohmann::json& req);            // UI thread: a drop through the body's DropTarget at a target's centre

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
  std::string dragTarget_;                 // the divider or grip a driver drag pressed, "" for any other target, UI thread only
  struct ModelPath { double queue, parse, build, layout, apply; };
  std::deque<ModelPath> modelPaths_;       // the last 200 ui:models, UI thread only
  std::deque<double> paintGap_[2], paintDraw_[2];   // [0] body, [1] strip: invalidate to paint end, and the paint alone
  LONGLONG paintPending_[2] = { 0, 0 };    // QPC of the oldest model invalidate that surface has not painted yet
  // A drag step's wait: the UI thread arms it (dragStep move, before the
  // WM_MOUSEMOVE) and stamps the first model past modelWaitSeq_ in noteModel;
  // the connection thread sleeps on modelCv_ until then or the step timeout.
  std::mutex modelMu_;
  std::condition_variable modelCv_;
  double modelWaitSeq_ = -1;               // the seq before the move; -1 while no step waits
  LONGLONG modelAt_ = 0;                   // QPC ticks when that model had been applied; 0 until it has
  bool armedRectSet_ = false;              // the step armed with the dragged divider's (or grip's) rect: only a model that changes it stamps
  std::array<double, 4> armedRect_{};      // that rect before the move, DIP x, y, w, h (UI thread only)
};
