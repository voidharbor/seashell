// The top-level SeaShellHost window (DWM custom frame, glass strip) and its
// opaque SeaShellBody child. One per process.
#pragma once
#include <windows.h>
#include <string>
#include "paths.h"

struct Dpi { float dpi = 96.f; float scale() const { return dpi / 96.f; } };

class Window {
public:
  static Window& instance();
  bool create(HINSTANCE hinst, bool noActivate);   // saved bounds or 1440x900 DIP at 100,100
  HWND hwnd() const { return hwnd_; }              // the top-level window (glass strip lives here)
  HWND body() const { return body_; }              // the opaque child covering everything below the strip
  Dpi dpi() const { return Dpi{ (float)dpi_ }; }
  int stripHeightPx() const;    // the model's tabStripH (38 DIP times uiScale) times scale, the IE9 tab row (DWM caption buttons sit in it)
  void onStripHeightChanged();  // the model's tabStripH changed: the glass and the body follow
  RECT bodyRect() const;        // client rect minus the strip
  void invalidateStrip();
  void invalidateBody(const RECT* r = nullptr);
  void setTitle(const std::wstring& s);
  void post(UINT msg, WPARAM w = 0, LPARAM l = 0);   // PostMessage to hwnd()
  SavedBounds bounds() const;   // the last normal rect plus the maximized flag, for saveBounds
  // WM_APP messages the rest of the shell uses:
  static constexpr UINT WM_APP_CORE_LINE = WM_APP + 1;   // wParam: QPC at the post; lParam: std::string* (heap, receiver deletes)
  static constexpr UINT WM_APP_CORE_EXIT = WM_APP + 2;   // wParam: exit code
  static constexpr UINT WM_APP_DRIVER   = WM_APP + 3;   // lParam: DriverCall* (Task 9)
  static constexpr UINT WM_APP_PTY_FEED = WM_APP + 4;   // batched pty bytes ready (Task 11)
  // dwData of a WM_COPYDATA envelope from a second instance ('SSH1').
  static constexpr ULONG_PTR kCopyDataEnvelope = 0x53534831;

private:
  static LRESULT CALLBACK hostProc(HWND h, UINT msg, WPARAM w, LPARAM l);
  static LRESULT CALLBACK bodyProc(HWND h, UINT msg, WPARAM w, LPARAM l);
  LRESULT onHost(HWND h, UINT msg, WPARAM w, LPARAM l);
  LRESULT onBody(HWND h, UINT msg, WPARAM w, LPARAM l);
  LRESULT hitTest(POINT screen) const;
  int borderPx() const;
  void extendFrame();
  void relayout();
  void paintStrip();
  void paintBody();
  void freeStripDib();
  // The Alt tap (Phase 2 Task 16, Review Focus 5): WM_SYSKEYUP for VK_MENU
  // with no other key and no press since its WM_SYSKEYDOWN, and neither Ctrl
  // nor Shift held, pops the application menu (Ui::altTap); every Alt+<key>
  // goes on to the grid untouched. Also the test-mode menu's keyboard
  // (AppMenu::key). True when the key message was taken here.
  bool menuKeys(UINT msg, WPARAM w, LPARAM l);
  void noteMouse(UINT msg);     // a press or the wheel: the Alt down is not a tap any more

  HWND hwnd_ = nullptr, body_ = nullptr;
  UINT dpi_ = 96;
  RECT normal_{};               // last normal (not maximized, not minimized) window rect
  HDC stripDc_ = nullptr; HBITMAP stripBmp_ = nullptr; HGDIOBJ stripOld_ = nullptr;
  int stripW_ = 0, stripH_ = 0;
  bool altTap_ = false;         // Alt went down alone and nothing else happened since
};
