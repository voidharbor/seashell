// Keyboard, mouse and clipboard input for the terminal grids (native design
// spec section 5): chords to ui:command, keys and characters into libvterm,
// mouse reports when a program asked for them, otherwise selection, the wheel
// with its ramp, path double-click, paste and copy. UI thread only; App owns
// the one instance and routes the body window's input messages here.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <map>
#include <optional>
#include <string>
#include <vector>
#include "chords.h"
#include "grid.h"
#include "selection.h"
#include "wheel_ramp.h"

class GridView;

class GridInput {
public:
  void setChords(const std::vector<ChordModel>& chords) { chords_.set(chords); }
  // WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP, WM_CHAR, WM_SYSCHAR for
  // the focused pane's grid (nullptr when no terminal pane has focus: chords
  // still run). True when consumed.
  bool key(Grid* g, UINT msg, WPARAM w, LPARAM l);
  // Mouse messages in body client coordinates (device pixels); WM_MOUSEWHEEL
  // carries screen coordinates, as Windows sends it.
  bool mouse(UINT msg, WPARAM w, LPARAM l);
  void focus(bool on);                                  // WM_SETFOCUS / WM_KILLFOCUS on the body
  // grid:cmd paste, copy, selectAll, clear. True when the op was one of these.
  bool gridCmd(const std::string& op, const std::string& paneId, const nlohmann::json& cmd);
  // After pty bytes went into a grid: the selection stays on its text while
  // rows move into scrollback (the viewport is Grid's own).
  void noteFed(Grid& g, size_t sbBefore, const std::string& newestBefore, size_t sbCap);
  void dropPane(const std::string& paneId);
  const Selection* selection(const std::string& paneId) const;
  std::string selectionText(const std::string& paneId) const;   // the driver's stats

private:
  struct Hit { std::string paneId; Grid* g = nullptr; GridView* v = nullptr; long absRow = 0; int col = 0; int boundary = 0; };
  bool hitTest(float x, float y, bool clamp, const std::string& onlyPane, Hit* out) const;
  bool cellHit(const std::string& id, float x, float y, bool clamp, Hit* out) const;   // one grid's cell under the point
  void write(Grid& g, const std::string& bytes);
  void afterTyped(Grid& g, bool submit);                // scroll to the bottom, clear the selection
  void selectInputLine(Grid& g);
  VTermModifier mods() const;
  void sendPathClick(const Hit& h);
  void sendUrlClick(const Hit& h);   // a click that selected nothing, over a line holding a URL
  void appBarDown(const Hit& h, int part, float y);
  void appBarSend(Grid& g, GridView& v, int notches);
  static void CALLBACK repeatTick(HWND, UINT, UINT_PTR, DWORD);
  static void CALLBACK edgeTick(HWND, UINT, UINT_PTR, DWORD);
  void stopTimers();
  void extendTo(float x, float y);

  ChordTable chords_;
  bool swallowChar_ = false;          // the WM_CHAR of a key already handled on WM_KEYDOWN
  wchar_t highSurrogate_ = 0;
  bool inputLineSelected_ = false;    // true only between an input-line select and the next key
  std::string inputLinePane_;
  std::map<std::string, Selection> sel_;
  WheelRamp ramp_;
  float wheelCarry_ = 0;              // partial notches from a precision touchpad, under mouse tracking
  // The left-button gesture in progress.
  enum class Drag { None, Select, Report, AppThumb, AppTrack };
  Drag drag_ = Drag::None;
  std::string dragPane_;
  int reportButton_ = 0;              // the libvterm button held while reporting
  float lastX_ = 0, lastY_ = 0;
  float thumbStartY_ = 0; int thumbStartOffset_ = 0, thumbStartRange_ = 0;
  int trackPart_ = 0; float trackY_ = 0;
  UINT_PTR repeatTimer_ = 0, edgeTimer_ = 0;
  struct Click { float x = -100, y = -100; ULONGLONG at = 0; std::string paneId; };
  Click lastDbl_;                     // for the triple click
};
