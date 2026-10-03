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
#include "ui/popup.h"
#include "ui/scrollbar.h"
#include "ui/tokens.h"

class Ui {
public:
  static Ui& instance();
  void setModel(UiModel&&);                      // relayout of chrome rects from the model's DIP rects; keeps the last rows for a model without them
  const UiModel& model() const { return m_; }    // the applied model (App::model)
  bool stripChanged() const { return stripChanged_; }   // the last setModel changed what the strip draws (App repaints it only then)
  void relayout();                               // the window or the DPI changed: hit rects again
  void drawBackground(ID2D1RenderTarget* rt);    // the body's chrome color, under the grids
  void drawStrip(ID2D1RenderTarget* rt);         // tabs, +, web, sleep, settings, zoom badge; transparent where glass shows
  void drawBody(ID2D1RenderTarget* rt);          // the explorer, pane frames, dividers, status bar and the drawer's panel; App draws the pane grids before it
  void drawOverlays(ID2D1RenderTarget* rt);      // the find bar, the menu and the overlays; App draws the drawer's grid before them
  std::string stripTargetAt(POINT clientPx) const;   // "strip:empty" | "tab:<id>" | ... (WM_NCHITTEST uses it)
  std::string bodyTargetAt(POINT bodyPx) const;      // "pane:<id>:grid" | "pane:<id>:close" | "divider:<id>" | "find:query" | "restore:yes" | ...
  // Mouse messages at client pixels of the top-level window (a body message
  // adds the strip height; a wheel converts its screen point). Emits ui:event;
  // true when consumed (not a grid). wheelDelta is WM_MOUSEWHEEL's.
  bool mouse(UINT msg, POINT clientPx, int button, Mods, int wheelDelta = 0);
  bool key(UINT msg, WPARAM, LPARAM, Mods);          // for the focused edit widget or an open card; false lets the grid have it
  LPCWSTR cursorFor(POINT bodyPx) const;             // IDC_SIZEWE over a vertical divider or the sidebar grip, IDC_SIZENS over a horizontal divider or the drawer grip, IDC_IBEAM over an edit or a grid, IDC_ARROW
  void mouseLeave(bool strip);                       // WM_MOUSELEAVE, or the pointer went onto the caption
  void captionPress();                               // a press on strip:empty (the window drag): blur the edit
  void captionDblClick();                            // dblclick strip:empty, which the core turns into a new tab
  void cancelDrag();                                 // the body lost the capture mid divider, grip or scrollbar drag: end it where it was
  // The driver's click by target: what a click on that target does (the
  // shell's own handling first, else the ui:event), without a pointer.
  void targetClick(const std::string& target, bool dbl, int button, Mods m);

  // App's hooks.
  void setCoreDead(bool dead, DWORD code);           // every pane shows "core exited" and the toast names the code
  void setCaretPhase(bool on);                       // App's 530 ms blink, for the edit caret
  bool wantsBlink() const;                           // an edit widget has focus
  bool modal() const;                                // the restore card or a sheet is up
  // A target's rect in client pixels of the top-level window (the driver's
  // drag and point clicks); false when nothing on screen has that id.
  bool targetRect(const std::string& target, D2D1_RECT_F* clientPx) const;
  // The explorer's rows as the last layout placed them (the driver's `rows`):
  // y and h in client DIP, `visible` when some of the row shows in the tree.
  // viewportDip is the tree's rect in client DIP (zero while hidden),
  // offsetDip its scroll offset.
  struct DrawnRow { std::string id; float y = 0, h = 0; bool visible = false; };
  std::vector<DrawnRow> sidebarRows(D2D1_RECT_F* viewportDip, float* offsetDip) const;
  // The driver's scrollTo: a view's scroll offset in DIP, clamped; false when
  // that view is not on screen ('sidebar' is the only one so far).
  bool scrollView(const std::string& view, float offsetDip, float* clamped);

private:
  Ui();
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
  bool stripDark() const;                        // tokens.stripDark is '1': the dark tab strip (Task 12b); nothing below the strip reads it
  void viewPanes(Painter& p);                    // panes.cpp
  void viewExitOverlay(Painter& p, const PaneModel& pm, D2D1_RECT_F grid);   // panes.cpp
  void viewDividers(Painter& p);                 // dividers.cpp
  void viewStatus(Painter& p);                   // status.cpp
  void viewUpdate(Painter& p);                   // overlays.cpp: the update banner in its band above the status bar
  void viewFindBar(Painter& p);                  // overlays.cpp
  void viewOverlays(Painter& p);                 // overlays.cpp: toast, empty state, splash, restore card, tooltip
  void viewSidebar(Painter& p);                  // sidebar.cpp: the explorer column, its scrollbar, the strip and the grip
  void viewMenu(Painter& p);                     // sidebar.cpp: the context menu popup over the body
  void viewDrawer(Painter& p);                   // drawer.cpp: the shell drawer's panel, grip and header; App draws its grid
  void viewSheet(Painter& p);                    // sheet.cpp: the dim and the sheet's card (from viewOverlays)
  bool sheetKey(UINT msg, WPARAM, LPARAM, Mods); // sheet.cpp: the sheet takes the keyboard
  bool sheetMouse(UINT msg, POINT clientPx, int button, Mods, const std::string& target, int wheelDelta);   // sheet.cpp
  void sheetFocusMove(int dir);                  // Tab and Shift+Tab
  bool sheetOptionDisabled(const std::string& target) const;
  std::wstring sheetTooltip(const std::string& target) const;
  void syncSheet(const UiModel& old);            // opens or closes the sheet's text field

  // The explorer column's geometry for the current model (sidebar.cpp):
  // rects in body pixels; rowDip and padDip in the model's DIP (uiScale in).
  struct SidebarGeom {
    bool on = false;
    D2D1_RECT_F col{}, head{}, tree{}, strip{}, bar{};
    float rowsRight = 0;                         // the rows' right edge: the tree's, or the scrollbar's left
    float rowDip = 22, padDip = 4;
    std::vector<int> line;                       // each row's line in the tree (a truncation line takes one)
    int lines = 0;
  };
  void sidebarGeometry();
  float sidebarRowTop(size_t i) const;           // body pixels
  void syncSidebar(const UiModel& old);
  void sidebarReveal();
  bool sidebarWheel(POINT clientPx, int delta);
  void sidebarScrolled(POINT clientPx);
  bool sidebarBarPress(UINT msg, POINT clientPx, const std::string& target);
  bool sidebarAnimating(ULONGLONG now) const;
  bool menuSendsOwnDown(const std::string& target, int button) const;
  static std::string rightOnRow(const std::string& target, int button);   // sidebar:twisty:<p> under a right press is sidebar:row:<p>
  void closeMenuOnPress(const std::string& target, float xDip, float yDip, int button, Mods m);

  UiModel m_;
  bool haveModel_ = false;
  bool stripChanged_ = true;
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
  SidebarGeom sb_;
  ScrollBar sbBar_;
  ScrollState sbScroll_;                         // the tree's scroll, DIP (shell view state)
  double sbRevealSeq_ = 0;                       // the last revealSeq centred
  std::map<std::string, ULONGLONG> flashSince_;  // when each flashing row's flash began, by path
  struct NameLayout { Microsoft::WRL::ComPtr<IDWriteTextLayout> tl; bool used = false; };
  std::map<std::string, NameLayout> sbNames_;    // the shown rows' name layouts by name, box and font size (viewSidebar)
  Popup menu_;                                   // the explorer's context menu
  EditWidget sheetEdit_;                         // the sheet's text field
  ScrollBar sheetBar_;
  ScrollState sheetScroll_;                      // the sheet's body scroll, DIP (shell view state)
  std::vector<std::string> sheetStops_;          // the focusable targets in Tab order, as the last layout placed them
  std::string sheetFocus_;                       // the target with the keyboard focus ring; "" none
  int pressedButton_ = 0;                        // the button of the press in pressed_
};
