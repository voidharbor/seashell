// One pane's terminal: a libvterm VTerm (reflow on, OSC 8 patched in), the
// GridStore that mirrors its cells and scrollback, the cursor and mode state
// the renderer and the input path read, and the scrollback viewport. UI thread
// only. Platform-neutral so tools/grid-test builds the same code.
#pragma once
#include "grid_store.h"
// rpcndr.h (through windows.h) defines `small`, a field name in vterm.h.
#pragma push_macro("small")
#undef small
#include <vterm.h>
#pragma pop_macro("small")
#include <functional>
#include <string>
#include <vector>

class Grid {
public:
  Grid(const std::string& paneId, int cols, int rows, int scrollback);
  ~Grid();
  Grid(const Grid&) = delete;
  Grid& operator=(const Grid&) = delete;

  const std::string& paneId() const { return paneId_; }
  void feed(const char* bytes, size_t n);       // vterm_input_write; coalesced: App posts WM_APP_PTY_FEED once per batch
  void resize(int cols, int rows);              // vterm_set_size with reflow on
  void setOutput(std::function<void(const std::string&)> fn);   // vterm output (keys, mouse, paste, query replies) to pty:write
  GridStore& store() { return store_; }
  const GridStore& store() const { return store_; }
  VTermPos cursor() const { return cursor_; }
  bool cursorVisible() const { return cursorVisible_; }
  int cursorShape() const { return cursorShape_; }   // VTERM_PROP_CURSORSHAPE_BLOCK, _UNDERLINE, _BAR_LEFT
  bool cursorBlink() const { return cursorBlink_; }
  bool altScreen() const { return altScreen_; }
  int mouseMode() const { return mouseMode_; }        // VTERM_PROP_MOUSE_NONE, _CLICK, _DRAG, _MOVE
  bool bracketedPaste() const;
  long viewTop() const { return viewTop_; }           // absolute row at the top of the viewport; 0 = following output
  void scrollView(long deltaRows);                    // negative scrolls back
  void scrollToBottom() { viewTop_ = 0; }
  std::vector<VTermRect> takeDamage();                // dirty rects since the last call, in screen coords
  std::function<void(const std::string& title)> onTitle;   // OSC 0/2 (settermprop TITLE)
  std::function<void(const std::string& uri)> onCwd;       // OSC 7, raw uri
  std::function<void()> onBell;
  // The OSC 8 target under an absolute row (as GridStore numbers them) and
  // column; "" when none.
  std::string uriAt(int row, int col) const;

  // input (Task 13 drives these)
  void key(VTermKey k, VTermModifier m);
  void unichar(uint32_t cp, VTermModifier m);
  void paste(const std::string& utf8);          // start_paste, bytes, end_paste
  void mouseMove(int row, int col, VTermModifier m);
  void mouseButton(int button, bool pressed, VTermModifier m);

private:
  static int cbDamage(VTermRect r, void* u);
  static int cbMoveRect(VTermRect dest, VTermRect src, void* u);
  static int cbMoveCursor(VTermPos pos, VTermPos old, int visible, void* u);
  static int cbSetTermProp(VTermProp prop, VTermValue* val, void* u);
  static int cbBell(void* u);
  static int cbResize(int rows, int cols, void* u);
  static int cbPushLine4(int cols, const VTermScreenCell* cells, bool continuation, void* u);
  static int cbPopLine(int cols, VTermScreenCell* cells, void* u);
  static int cbSbClear(void* u);
  static int cbOsc(int command, VTermStringFragment frag, void* u);
  static void cbOutput(const char* s, size_t len, void* u);

  void addDamage(VTermRect r);
  void readRow(int r, int startCol, int endCol);      // libvterm's cells into the store's screen row
  void readScreen();
  void refreshWrapped();
  void toCell(const VTermScreenCell& vc, Cell& out);
  void fromCell(const Cell& c, VTermScreenCell& out) const;
  uint32_t toColor(const VTermColor& c) const;
  VTermColor fromColor(uint32_t c, bool fg) const;

  std::string paneId_;
  VTerm* vt_ = nullptr;
  VTermScreen* screen_ = nullptr;
  VTermState* state_ = nullptr;
  GridStore store_;
  std::function<void(const std::string&)> output_;
  std::vector<VTermRect> damage_;
  VTermPos cursor_{ 0, 0 };
  bool cursorVisible_ = true, cursorBlink_ = true, altScreen_ = false;
  int cursorShape_ = VTERM_PROP_CURSORSHAPE_BLOCK;
  int mouseMode_ = VTERM_PROP_MOUSE_NONE;
  long viewTop_ = 0;
  std::string title_, osc_;   // fragments being collected
  int oscCommand_ = -1;
};
