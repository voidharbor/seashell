// The chrome: every Phase 1 view drawn from the UiModel, hit testing by target
// id, and the input that is not a grid's (redesign spec 6.2 and 6.3; native
// design spec section 9). Rects come from the model's DIP rects times the DPI
// scale; the shell never computes pane layout. UI thread only.
//
// Coordinates: strip rects are client pixels of the top-level window, body
// rects are pixels of the body child (client y minus the strip height).
#pragma once
#include <windows.h>
#include <d2d1_1.h>
#include <map>
#include <string>
#include <vector>
#include "chords.h"
#include "model.h"
#include "ui/edit.h"
#include "ui/painter.h"
#include "ui/tokens.h"

class Ui {
public:
  static Ui& instance();
  void setModel(const UiModel&);                 // relayout of chrome rects from the model's DIP rects
  void relayout();                               // the window or the DPI changed: hit rects again
  void drawBackground(ID2D1RenderTarget* rt);    // the body's chrome color, under the grids
  void drawStrip(ID2D1RenderTarget* rt);         // tabs, +, web, sleep, settings, zoom badge; transparent where glass shows
  void drawBody(ID2D1RenderTarget* rt);          // pane frames, dividers, status bar, overlays; grids are drawn by App between frames and overlays
  std::string stripTargetAt(POINT clientPx) const;   // "strip:empty" | "tab:<id>" | ... (WM_NCHITTEST uses it)
  std::string bodyTargetAt(POINT bodyPx) const;      // "pane:<id>:grid" | "pane:<id>:close" | "divider:<id>" | "find:query" | "restore:yes" | ...
  // Mouse messages at client pixels of the top-level window (a body message
  // adds the strip height; a wheel converts its screen point). Emits ui:event;
  // true when consumed (not a grid).
  bool mouse(UINT msg, POINT clientPx, int button, Mods);
  bool key(UINT msg, WPARAM, LPARAM, Mods);          // for the focused edit widget or an open card; false lets the grid have it
  LPCWSTR cursorFor(POINT bodyPx) const;             // IDC_SIZEWE over a vertical divider, IDC_SIZENS over a horizontal one, IDC_IBEAM over an edit, IDC_ARROW
  void mouseLeave(bool strip);                       // WM_MOUSELEAVE, or the pointer went onto the caption
  void captionPress();                               // a press on strip:empty (the window drag): blur the edit
  void captionDblClick();                            // dblclick strip:empty, which the core turns into a new tab
  void cancelDrag();                                 // the body lost the capture mid divider drag: end it where it was
  // The driver's click by target: what a click on that target does (the
  // shell's own handling first, else the ui:event), without a pointer.
  void targetClick(const std::string& target, bool dbl, int button, Mods m);

  // App's hooks.
  void setCoreDead(bool dead, DWORD code);           // every pane shows "core exited" and the toast names the code
  void setCaretPhase(bool on);                       // App's 530 ms blink, for the edit caret
  bool wantsBlink() const;                           // an edit widget has focus
  bool modal() const;                                // the restore card is up
  // A target's rect in client pixels of the top-level window (the driver's
  // drag and point clicks); false when nothing on screen has that id.
  bool targetRect(const std::string& target, D2D1_RECT_F* clientPx) const;

private:
  struct Hit { D2D1_RECT_F r; std::string target; };
  void layout();                                 // runs every view with a null painter to register the hits
  void hit(bool strip, D2D1_RECT_F r, const std::string& target);
  D2D1_RECT_F dev(const Rect& r) const;          // a model DIP rect in body pixels
  float bodyTop() const;
  float dpi() const;
  bool hovered(const std::string& target) const { return hover_ == target; }
  bool pressed(const std::string& target) const { return pressed_ == target && hover_ == target; }
  BtnState btn(const std::string& target, bool isDefault = false) const;
  const PaneModel* pane(const std::string& id) const;
  bool paneVisible(const PaneModel& p) const;
  void send(const char* type, const std::string& target, float xDip, float yDip, int button, Mods m);
  void setHover(const std::string& target, bool strip, POINT clientPx);
  std::wstring tooltipFor(const std::string& target) const;
  void syncEdits(const UiModel& old);
  EditWidget* focusedEdit();
  void activate(const std::string& target, Mods m, float xDip, float yDip);   // a click the shell handles itself, else the ui:event
  static void CALLBACK animTick(HWND, UINT, UINT_PTR, DWORD);
  static void CALLBACK tipTick(HWND, UINT, UINT_PTR, DWORD);
  void updateAnimTimer();
  float attentionLevel(const PaneModel& p, ULONGLONG now, bool* on) const;

  // The views, one file each.
  void viewTabs(Painter& p);                     // tabs.cpp
  bool onGlass() const;                          // tokens.composition is not '0': the strip is DWM glass
  void viewPanes(Painter& p);                    // panes.cpp
  void viewExitOverlay(Painter& p, const PaneModel& pm, D2D1_RECT_F grid);   // panes.cpp
  void viewDividers(Painter& p);                 // dividers.cpp
  void viewStatus(Painter& p);                   // status.cpp
  void viewFindBar(Painter& p);                  // overlays.cpp
  void viewOverlays(Painter& p);                 // overlays.cpp: toast, empty state, splash, restore card, tooltip

  UiModel m_;
  bool haveModel_ = false;
  Tokens t_;
  ChordTable chords_;
  bool registering_ = false;
  std::vector<Hit> stripHits_, bodyHits_;        // later entries are on top
  std::string hover_, pressed_;
  bool hoverStrip_ = false;
  POINT pointer_{ -1, -1 };                      // client pixels, for the tooltip
  std::wstring tip_;
  bool tipShown_ = false;
  UINT_PTR tipTimer_ = 0;
  EditWidget find_, rename_;
  std::string dragDivider_;
  float dragGrabDip_ = 0;                        // pointer minus the divider's leading edge, in DIP
  float dragLastX_ = 0, dragLastY_ = 0;          // the last down or move sent for it, in DIP
  int restoreFocus_ = 0;                         // 0 Restore, 1 Start fresh
  bool coreDead_ = false;
  DWORD coreCode_ = 0;
  bool caretOn_ = true;
  std::map<std::string, ULONGLONG> doneSince_;   // when each pane's attention turned 'done'
  std::map<std::string, ULONGLONG> waitingSince_;
  UINT_PTR animTimer_ = 0;
};
