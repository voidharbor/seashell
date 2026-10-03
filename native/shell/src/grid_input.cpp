#include "grid_input.h"
#include "app.h"
#include "driver.h"
#include "grid_view.h"
#include "inputline.h"
#include "paths.h"
#include "window.h"
#include <windowsx.h>
#include <algorithm>
#include <cmath>
#include <cstring>

using nlohmann::json;

namespace {
const int kPageNotches = 5;          // app-scroll.ts PAGE_NOTCHES
const UINT kRepeatDelayMs = 350;     // app-scrollbar.ts REPEAT_DELAY_MS
const UINT kRepeatEveryMs = 90;      // app-scrollbar.ts REPEAT_EVERY_MS
const UINT kEdgeScrollMs = 50;       // a drag past the grid's edge scrolls a row this often
const float kDblSlopPx = 4;          // terminal.ts claimDoubleClick: 4 px

bool held(int vk) { return Driver::keyDown(vk); }

json modsJson() { return { { "ctrl", held(VK_CONTROL) }, { "alt", held(VK_MENU) }, { "shift", held(VK_SHIFT) } }; }

// CF_UNICODETEXT as UTF-8; nullopt when the clipboard holds no text (or stays
// locked by another program for 100 ms).
std::optional<std::string> readClipboard(HWND owner) {
  bool open = false;
  for (int i = 0; i < 10 && !(open = OpenClipboard(owner) != FALSE); i++) Sleep(10);
  if (!open) { App::log("error: OpenClipboard %lu", GetLastError()); return std::nullopt; }
  std::optional<std::string> out;
  if (HANDLE d = GetClipboardData(CF_UNICODETEXT)) {
    if (auto* p = static_cast<const wchar_t*>(GlobalLock(d))) {
      std::string s = toUtf8(std::wstring(p));
      GlobalUnlock(d);
      if (!s.empty()) out = std::move(s);
    }
  }
  CloseClipboard();
  return out;
}

bool writeClipboard(HWND owner, const std::string& utf8) {
  std::wstring w;
  for (wchar_t c : fromUtf8(utf8)) {   // CRLF, the Windows text convention
    if (c == L'\n') w += L'\r';
    w += c;
  }
  bool open = false;
  for (int i = 0; i < 10 && !(open = OpenClipboard(owner) != FALSE); i++) Sleep(10);
  if (!open) { App::log("error: OpenClipboard %lu", GetLastError()); return false; }
  EmptyClipboard();
  bool ok = false;
  if (HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, (w.size() + 1) * sizeof(wchar_t))) {
    if (void* p = GlobalLock(g)) {
      memcpy(p, w.c_str(), (w.size() + 1) * sizeof(wchar_t));
      GlobalUnlock(g);
      ok = SetClipboardData(CF_UNICODETEXT, g) != nullptr;
    }
    if (!ok) GlobalFree(g);   // the clipboard owns it only once SetClipboardData succeeds
  }
  CloseClipboard();
  if (!ok) App::log("error: SetClipboardData %lu", GetLastError());
  return ok;
}

VTermKey vtermKey(UINT vk) {
  switch (vk) {
    case VK_RETURN: return VTERM_KEY_ENTER;
    case VK_TAB: return VTERM_KEY_TAB;
    case VK_BACK: return VTERM_KEY_BACKSPACE;
    case VK_ESCAPE: return VTERM_KEY_ESCAPE;
    case VK_UP: return VTERM_KEY_UP;
    case VK_DOWN: return VTERM_KEY_DOWN;
    case VK_LEFT: return VTERM_KEY_LEFT;
    case VK_RIGHT: return VTERM_KEY_RIGHT;
    case VK_INSERT: return VTERM_KEY_INS;
    case VK_DELETE: return VTERM_KEY_DEL;
    case VK_HOME: return VTERM_KEY_HOME;
    case VK_END: return VTERM_KEY_END;
    case VK_PRIOR: return VTERM_KEY_PAGEUP;
    case VK_NEXT: return VTERM_KEY_PAGEDOWN;
    default:
      if (vk >= VK_F1 && vk <= VK_F12) return (VTermKey)VTERM_KEY_FUNCTION(vk - VK_F1 + 1);
      return VTERM_KEY_NONE;
  }
}

bool isModifierKey(UINT vk) {
  switch (vk) {
    case VK_SHIFT: case VK_CONTROL: case VK_MENU: case VK_LSHIFT: case VK_RSHIFT: case VK_LCONTROL:
    case VK_RCONTROL: case VK_LMENU: case VK_RMENU: case VK_LWIN: case VK_RWIN: case VK_CAPITAL:
    case VK_NUMLOCK: case VK_SCROLL: return true;
    default: return false;
  }
}

// app-scroll.ts thumbGeometry's height and dragNotches, in DIPs.
float thumbHeight(int range, float trackPx) {
  return std::min(trackPx, std::max(24.f, std::round(trackPx * 6 / (range + 6))));
}

// The visible terminal panes, drawn in this order (App::paintBody's rule).
bool paneVisible(const UiModel& m, const PaneModel& p) {
  if (m.zoomedPaneId && *m.zoomedPaneId != p.id) return false;
  return p.kind == "term";
}

void invalidate() { Window::instance().invalidateBody(); }
}  // namespace

VTermModifier GridInput::mods() const {
  int m = VTERM_MOD_NONE;
  if (held(VK_SHIFT)) m |= VTERM_MOD_SHIFT;
  if (held(VK_CONTROL)) m |= VTERM_MOD_CTRL;
  if (held(VK_MENU)) m |= VTERM_MOD_ALT;
  return (VTermModifier)m;
}

void GridInput::write(Grid& g, const std::string& bytes) {
  App::instance().wire().ptyWrite(g.paneId(), bytes);
}

void GridInput::afterTyped(Grid& g, bool submit) {
  g.scrollToBottom();   // xterm.js scrollOnUserInput
  auto it = sel_.find(g.paneId());
  if (it != sel_.end() && it->second.active) it->second.clear();
  if (submit) {
    // A submitted line puts a program's own scrollback back at its bottom.
    if (GridView* v = App::instance().view(g.paneId()); v && v->appOffset() > 0) {
      v->setAppScrollbar(false);
      v->setAppScrollbar(true);
    }
  }
  invalidate();
}

void GridInput::selectInputLine(Grid& g) {
  const GridStore& st = g.store();
  long first = -(long)st.scrollbackLen();
  auto line = inputLineSelection(g.cursor().row, g.cursor().col, st.cols(), first,
                                 [&](long r) { return st.row(r - 1).wrapped; });
  Selection& s = sel_[g.paneId()];
  if (line) {
    s.startRow = line->row;
    s.startCol = 0;
    s.endRow = line->row + (line->length / st.cols());
    s.endCol = (int)(line->length % st.cols());
    s.active = true;
  } else {
    s.selectAll(st);   // nothing typed yet: the whole buffer, so select-all never does nothing
  }
  for (auto& [id, other] : sel_)
    if (id != g.paneId()) other.clear();
  inputLineSelected_ = true;
  inputLinePane_ = g.paneId();
  invalidate();
}

bool GridInput::key(Grid* g, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_KEYUP || msg == WM_SYSKEYUP) {
    swallowChar_ = false;
    // A lone Alt or F10 release would enter the (absent) menu bar's mode and
    // eat the next key.
    return msg == WM_SYSKEYUP && (w == VK_MENU || w == VK_F10) && g;
  }
  if (msg == WM_CHAR || msg == WM_SYSCHAR) {
    if (swallowChar_) return true;
    if (!g) return false;
    wchar_t ch = (wchar_t)w;
    if (ch >= 0xD800 && ch <= 0xDBFF) { highSurrogate_ = ch; return true; }
    uint32_t cp = ch;
    if (ch >= 0xDC00 && ch <= 0xDFFF) {
      if (!highSurrogate_) return true;   // a stray low half
      cp = 0x10000 + (((uint32_t)highSurrogate_ - 0xD800) << 10) + (ch - 0xDC00);
    }
    highSurrogate_ = 0;
    if (msg == WM_SYSCHAR) {
      if (cp == ' ') return false;   // Alt+Space stays the window menu
      g->unichar(cp, VTERM_MOD_ALT);
    } else {
      g->unichar(cp, VTERM_MOD_NONE);   // already composed with Shift or AltGr
    }
    inputLineSelected_ = false;
    afterTyped(*g, cp == '\r');
    return true;
  }
  if (msg != WM_KEYDOWN && msg != WM_SYSKEYDOWN) return false;

  swallowChar_ = false;
  UINT vk = (UINT)w;
  if (isModifierKey(vk)) return false;
  bool ctrl = held(VK_CONTROL), alt = held(VK_MENU), shift = held(VK_SHIFT);
  InputChord chord = chordFromMessage(w, l, ctrl, alt, shift);
  if (auto cmd = chords_.command(chord)) {
    swallowChar_ = true;
    if (*cmd == "edit.paste") {
      std::optional<std::string> text = readClipboard(Window::instance().hwnd());
      App::instance().wire().sendCommand(*cmd, { { "text", text ? json(*text) : json(nullptr) } });
    } else {
      App::instance().wire().sendCommand(*cmd);
    }
    App::log("chord %s -> %s", chordText(chord).c_str(), cmd->c_str());
    return true;
  }
  if (!g) return false;
  if (alt && !ctrl && vk == VK_F4) return false;   // the system closes the window

  // Shift+Enter: ESC CR, the newline agents and zsh's continuation read.
  if (vk == VK_RETURN && shift && !ctrl && !alt) {
    write(*g, "\x1b\r");
    swallowChar_ = true;
    inputLineSelected_ = false;
    afterTyped(*g, false);
    return true;
  }
  // Ctrl+A in an agent's prompt selects the line being typed (inputline.ts shouldSelectInputLine).
  if (vk == 'A' && ctrl && !alt && !shift) {
    std::string badge;
    for (const PaneModel& p : App::instance().model().panes)
      if (p.id == g->paneId()) badge = p.badge;
    if (isAgentForeground(badge)) {
      selectInputLine(*g);
      swallowChar_ = true;
      return true;
    }
  }
  // Backspace or Delete right after that select clears exactly what it covered (shouldKillLine).
  if ((vk == VK_BACK || vk == VK_DELETE) && inputLineSelected_ && inputLinePane_ == g->paneId() && !ctrl && !alt) {
    write(*g, kLineErase);
    inputLineSelected_ = false;
    swallowChar_ = true;
    afterTyped(*g, false);
    return true;
  }
  inputLineSelected_ = false;

  // Shift+PageUp / Shift+PageDown page the viewport (xterm.js keyboard rules).
  if ((vk == VK_PRIOR || vk == VK_NEXT) && shift && !ctrl && !alt && !g->altScreen()) {
    int page = std::max(1, g->store().rows() - 1);
    g->scrollView(vk == VK_PRIOR ? -page : page);
    invalidate();
    return true;
  }

  VTermModifier m = mods();
  if (VTermKey k = vtermKey(vk); k != VTERM_KEY_NONE) {
    if (vk == VK_BACK && ctrl && !alt) {
      write(*g, "\x08");   // xterm.js: Ctrl+Backspace is BS
    } else {
      int mm = m;
      // xterm.js sends these bare whatever Ctrl or Shift says; libvterm would
      // spell them as CSI u sequences programs do not expect.
      if (k == VTERM_KEY_ENTER || k == VTERM_KEY_BACKSPACE || k == VTERM_KEY_ESCAPE) mm &= VTERM_MOD_ALT;
      if (k == VTERM_KEY_TAB) mm &= VTERM_MOD_ALT | VTERM_MOD_SHIFT;
      g->key(k, (VTermModifier)mm);
    }
    swallowChar_ = true;
    afterTyped(*g, k == VTERM_KEY_ENTER);
    return true;
  }
  // Ctrl+letter as a control code. AltGr (Right Alt, which Windows reports as
  // Ctrl+Alt) composes a character instead, which WM_CHAR delivers.
  if (ctrl && !held(VK_RMENU) && vk >= 'A' && vk <= 'Z') {
    char letter = (char)(vk - 'A' + 'a');
    if (letter == 'i' || letter == 'j' || letter == 'm') {
      // libvterm spells Ctrl+I, J and M as CSI u; xterm.js sends the C0 byte.
      write(*g, std::string(alt ? "\x1b" : "") + (char)(letter & 0x1f));
    } else {
      g->unichar((uint32_t)letter, (VTermModifier)(VTERM_MOD_CTRL | (alt ? VTERM_MOD_ALT : 0)));
    }
    swallowChar_ = true;
    afterTyped(*g, false);
    return true;
  }
  if (ctrl && !alt && (vk == VK_SPACE || (vk >= '2' && vk <= '8'))) {
    // xterm.js's Ctrl+Space and Ctrl+2..8 (NUL, ESC, FS, GS, RS, US, DEL).
    static const char kDigit[] = { 0x00, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f };
    char b = vk == VK_SPACE ? 0 : kDigit[vk - '2'];
    write(*g, std::string(1, b));
    swallowChar_ = true;
    afterTyped(*g, false);
    return true;
  }
  return false;   // TranslateMessage's WM_CHAR carries the character
}

// The cell under (x, y) in the visible grid there (or in onlyPane, with the
// point clamped into its grid when clamp is set). The open drawer floats over
// the panes, so its grid is asked first, and a point on the rest of its panel
// is no pane's.
bool GridInput::hitTest(float x, float y, bool clamp, const std::string& onlyPane, Hit* out) const {
  App& a = App::instance();
  const UiModel& m = a.model();
  const DrawerModel& dm = m.drawer;
  if (dm.open && dm.ptyId && (onlyPane.empty() || onlyPane == *dm.ptyId)) {
    if (cellHit(*dm.ptyId, x, y, clamp, out)) return true;
    if (!onlyPane.empty()) return false;
    float s = Window::instance().dpi().scale(), top = (float)Window::instance().bodyRect().top;
    const Rect& r = dm.rect;
    if (x >= r.x * s && x < (r.x + r.w) * s && y >= r.y * s - top && y < (r.y + r.h) * s - top) return false;
  }
  for (const PaneModel& p : m.panes) {
    if (!paneVisible(m, p) || (!onlyPane.empty() && p.id != onlyPane)) continue;
    if (cellHit(p.id, x, y, clamp, out)) return true;
  }
  return false;
}

bool GridInput::cellHit(const std::string& id, float x, float y, bool clamp, Hit* out) const {
  App& a = App::instance();
  Grid* g = a.grid(id);
  GridView* v = a.view(id);
  if (!g || !v) return false;
  D2D1_RECT_F r = v->rect();
  float px = x, py = y;
  if (clamp) {
    px = std::min(std::max(px, r.left), r.right - 0.5f);
    py = std::min(std::max(py, r.top), r.bottom - 0.5f);
  }
  if (px < r.left || px >= r.right || py < r.top || py >= r.bottom) return false;
  D2D1_RECT_F c00 = v->cellRect(0, 0), c11 = v->cellRect(1, 1);
  float cw = c11.left - c00.left, ch = c11.top - c00.top;
  if (cw <= 0 || ch <= 0) return false;
  const GridStore& st = g->store();
  float ox = c00.left, oy = std::round(r.top);
  int col = std::min(std::max(0, (int)std::floor((px - ox) / cw)), st.cols() - 1);
  int vr = std::min(std::max(0, (int)std::floor((py - oy) / ch)), st.rows() - 1);
  out->paneId = id;
  out->g = g;
  out->v = v;
  out->absRow = g->viewTop() + vr;
  out->col = col;
  float cx = ox + col * cw;
  out->boundary = std::min(st.cols(), col + ((px - cx) >= cw / 2 ? 1 : 0));
  return true;
}

void GridInput::sendPathClick(const Hit& h) {
  const GridStore& st = h.g->store();
  long first = 0;
  std::vector<int> idx;
  std::string line = st.logicalLine(h.absRow, &first, &idx);
  int col = h.col;
  const Row& row = st.row(h.absRow);
  while (col > 0 && col < (int)row.cells.size() && row.cells[col].width == 0) col--;
  int cell = (int)(h.absRow - first) * st.cols() + col;
  auto it = std::find(idx.begin(), idx.end(), cell);
  if (it == idx.end()) return;
  App::instance().wire().sendTerm({ { "type", "pathclick" }, { "paneId", h.paneId }, { "line", line },
                                    { "index", (int)(it - idx.begin()) }, { "mods", modsJson() } });
}

void GridInput::appBarSend(Grid& g, GridView& v, int notches) {
  if (notches == 0) return;
  g.mouseMove(g.store().rows() / 2, g.store().cols() / 2, VTERM_MOD_NONE);
  for (int i = 0; i < std::abs(notches); i++) g.mouseButton(notches > 0 ? 4 : 5, true, VTERM_MOD_NONE);
  v.appScrollNotches(notches);
  invalidate();
}

void GridInput::appBarDown(const Hit& h, int part, float y) {
  SetCapture(Window::instance().body());
  dragPane_ = h.paneId;
  if (part == GridView::kBarThumb) {
    drag_ = Drag::AppThumb;
    thumbStartY_ = y;
    thumbStartOffset_ = h.v->appOffset();
    thumbStartRange_ = h.v->appRange();
    return;
  }
  // Page toward the press, then keep paging while it is held until the thumb
  // reaches the pointer: the Windows track behaviour.
  drag_ = Drag::AppTrack;
  trackPart_ = part;
  trackY_ = y;
  appBarSend(*h.g, *h.v, part == GridView::kBarAbove ? kPageNotches : -kPageNotches);
  repeatTimer_ = SetTimer(nullptr, 0, kRepeatDelayMs, repeatTick);
}

void CALLBACK GridInput::repeatTick(HWND, UINT, UINT_PTR id, DWORD) {
  GridInput& in = App::instance().input();
  KillTimer(nullptr, id);
  in.repeatTimer_ = 0;
  if (in.drag_ != Drag::AppTrack) return;
  Grid* g = App::instance().grid(in.dragPane_);
  GridView* v = App::instance().view(in.dragPane_);
  if (!g || !v) return;
  int part = GridView::kBarNone;
  v->appScrollbarHit(v->rect().right - 1, in.trackY_, &part);
  if (part != in.trackPart_) return;
  in.appBarSend(*g, *v, part == GridView::kBarAbove ? kPageNotches : -kPageNotches);
  in.repeatTimer_ = SetTimer(nullptr, 0, kRepeatEveryMs, repeatTick);
}

void CALLBACK GridInput::edgeTick(HWND, UINT, UINT_PTR, DWORD) {
  GridInput& in = App::instance().input();
  if (in.drag_ != Drag::Select) { in.stopTimers(); return; }
  Grid* g = App::instance().grid(in.dragPane_);
  GridView* v = App::instance().view(in.dragPane_);
  if (!g || !v) { in.stopTimers(); return; }
  D2D1_RECT_F r = v->rect();
  if (in.lastY_ < r.top) g->scrollView(-1);
  else if (in.lastY_ >= r.bottom) g->scrollView(1);
  in.extendTo(in.lastX_, in.lastY_);
}

void GridInput::stopTimers() {
  if (repeatTimer_) { KillTimer(nullptr, repeatTimer_); repeatTimer_ = 0; }
  if (edgeTimer_) { KillTimer(nullptr, edgeTimer_); edgeTimer_ = 0; }
}

void GridInput::extendTo(float x, float y) {
  Hit h;
  if (!hitTest(x, y, true, dragPane_, &h)) return;
  Selection& s = sel_[dragPane_];
  s.endRow = h.absRow;
  s.endCol = h.boundary;
  // Past the top or bottom edge the selection runs to that row's start or end.
  D2D1_RECT_F r = h.v->rect();
  if (y < r.top) s.endCol = 0;
  else if (y >= r.bottom) s.endCol = h.g->store().cols();
  invalidate();
}

bool GridInput::mouse(UINT msg, WPARAM w, LPARAM l) {
  HWND body = Window::instance().body();
  float x = (float)GET_X_LPARAM(l), y = (float)GET_Y_LPARAM(l);
  if (msg == WM_MOUSEWHEEL) {
    POINT pt{ GET_X_LPARAM(l), GET_Y_LPARAM(l) };
    ScreenToClient(body, &pt);
    x = (float)pt.x; y = (float)pt.y;
  }
  bool alt = held(VK_MENU), shift = held(VK_SHIFT);
  VTermModifier m = mods();
  Hit h;

  switch (msg) {
    case WM_LBUTTONDOWN: {
      if (!hitTest(x, y, false, "", &h)) return false;
      int part = GridView::kBarNone;
      if (h.v->appScrollbarHit(x, y, &part)) { appBarDown(h, part, y); return true; }
      // The core focuses the pane first (a press in the drawer's grid gives
      // the drawer the keys); the selection logic runs on it here.
      float scale = Window::instance().dpi().scale();
      float top = (float)Window::instance().bodyRect().top;
      const DrawerModel& dm = App::instance().model().drawer;
      bool inDrawer = dm.ptyId && h.paneId == *dm.ptyId;
      App::instance().wire().sendEvent({ { "type", inDrawer ? "down" : "click" }, { "target", inDrawer ? std::string("drawer:grid") : "pane:" + h.paneId + ":grid" },
                                         { "x", x / scale }, { "y", (y + top) / scale }, { "button", 0 }, { "mods", modsJson() } });
      bool reporting = h.g->mouseMode() != VTERM_PROP_MOUSE_NONE && !alt;
      ULONGLONG now = GetTickCount64();
      bool triple = !reporting && lastDbl_.paneId == h.paneId && now - lastDbl_.at <= GetDoubleClickTime() &&
                    std::fabs(x - lastDbl_.x) < kDblSlopPx && std::fabs(y - lastDbl_.y) < kDblSlopPx;
      lastX_ = x; lastY_ = y;
      for (auto& [id, s] : sel_)
        if (id != h.paneId) s.clear();
      inputLineSelected_ = false;
      if (triple) {
        lastDbl_.at = 0;
        sel_[h.paneId].selectLine(h.g->store(), h.absRow);
        invalidate();
        return true;
      }
      SetCapture(body);
      dragPane_ = h.paneId;
      if (reporting) {
        sel_[h.paneId].clear();
        int row = (int)std::max(0L, std::min(h.absRow, (long)h.g->store().rows() - 1));
        h.g->mouseMove(row, h.col, m);
        h.g->mouseButton(1, true, m);
        reportButton_ = 1;
        drag_ = Drag::Report;
      } else {
        Selection& s = sel_[h.paneId];
        if (shift && s.active) {
          s.endRow = h.absRow;
          s.endCol = h.boundary;
        } else {
          s.startRow = s.endRow = h.absRow;
          s.startCol = s.endCol = h.boundary;
          s.active = true;   // empty until the pointer moves
        }
        drag_ = Drag::Select;
      }
      invalidate();
      return true;
    }
    case WM_LBUTTONDBLCLK: {
      if (!hitTest(x, y, false, "", &h)) return false;
      int part = GridView::kBarNone;
      if (h.v->appScrollbarHit(x, y, &part)) { appBarDown(h, part, y); return true; }
      lastX_ = x; lastY_ = y;
      if (h.g->mouseMode() != VTERM_PROP_MOUSE_NONE && !alt) {
        // The program is entitled to the second press; the path still resolves.
        SetCapture(body);
        dragPane_ = h.paneId;
        int row = (int)std::max(0L, std::min(h.absRow, (long)h.g->store().rows() - 1));
        h.g->mouseMove(row, h.col, m);
        h.g->mouseButton(1, true, m);
        reportButton_ = 1;
        drag_ = Drag::Report;
        sendPathClick(h);
        return true;
      }
      // Without reporting, or with Alt under it (the second press is swallowed):
      // select the word and resolve the path.
      for (auto& [id, s] : sel_)
        if (id != h.paneId) s.clear();
      sel_[h.paneId].selectWord(h.g->store(), h.absRow, h.col);
      lastDbl_ = Click{ x, y, GetTickCount64(), h.paneId };
      drag_ = Drag::None;
      sendPathClick(h);
      invalidate();
      return true;
    }
    case WM_MOUSEMOVE: {
      lastX_ = x; lastY_ = y;
      switch (drag_) {
        case Drag::Select: {
          extendTo(x, y);
          GridView* v = App::instance().view(dragPane_);
          bool outside = v && (y < v->rect().top || y >= v->rect().bottom);
          if (outside && !edgeTimer_) edgeTimer_ = SetTimer(nullptr, 0, kEdgeScrollMs, edgeTick);
          if (!outside && edgeTimer_) { KillTimer(nullptr, edgeTimer_); edgeTimer_ = 0; }
          return true;
        }
        case Drag::Report:
          if (hitTest(x, y, true, dragPane_, &h)) {
            int row = (int)std::max(0L, std::min(h.absRow, (long)h.g->store().rows() - 1));
            h.g->mouseMove(row, h.col, m);
          }
          return true;
        case Drag::AppThumb: {
          Grid* g = App::instance().grid(dragPane_);
          GridView* v = App::instance().view(dragPane_);
          if (!g || !v) return true;
          float scale = Window::instance().dpi().scale();
          float trackPx = (v->rect().bottom - v->rect().top) / scale;
          float travel = trackPx - thumbHeight(thumbStartRange_, trackPx);
          if (travel <= 0) return true;
          float dy = (y - thumbStartY_) / scale;
          int target = std::max(0, (int)std::lround(thumbStartOffset_ - (dy / travel) * thumbStartRange_));
          appBarSend(*g, *v, target - v->appOffset());
          return true;
        }
        case Drag::AppTrack:
          return true;
        case Drag::None:
          break;
      }
      // Hover: libvterm reports it only in any-event mode (or drag mode with a button held).
      if (!alt && hitTest(x, y, false, "", &h) && h.g->mouseMode() != VTERM_PROP_MOUSE_NONE) {
        int row = (int)std::max(0L, std::min(h.absRow, (long)h.g->store().rows() - 1));
        h.g->mouseMove(row, h.col, m);
      }
      return false;
    }
    case WM_LBUTTONUP: {
      Drag d = drag_;
      drag_ = Drag::None;
      stopTimers();
      if (GetCapture() == body) ReleaseCapture();
      if (d == Drag::Report) {
        if (Grid* g = App::instance().grid(dragPane_)) {
          if (hitTest(x, y, true, dragPane_, &h)) {
            int row = (int)std::max(0L, std::min(h.absRow, (long)g->store().rows() - 1));
            g->mouseMove(row, h.col, m);
          }
          g->mouseButton(reportButton_, false, m);
        }
      } else if (d == Drag::Select) {
        auto it = sel_.find(dragPane_);
        if (it != sel_.end() && it->second.empty()) it->second.clear();
        invalidate();
      }
      return d != Drag::None || hitTest(x, y, false, "", &h);
    }
    case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_MBUTTONDOWN: case WM_MBUTTONUP: {
      if (!hitTest(x, y, false, "", &h) || h.g->mouseMode() == VTERM_PROP_MOUSE_NONE || alt) return false;
      int button = (msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP) ? 3 : 2;
      bool down = msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN;
      int row = (int)std::max(0L, std::min(h.absRow, (long)h.g->store().rows() - 1));
      h.g->mouseMove(row, h.col, m);
      h.g->mouseButton(button, down, m);
      return true;
    }
    case WM_MOUSEWHEEL: {
      if (!hitTest(x, y, false, "", &h)) return false;
      float notches = GET_WHEEL_DELTA_WPARAM(w) / (float)WHEEL_DELTA;   // positive: away from the user
      Grid& g = *h.g;
      if (g.mouseMode() != VTERM_PROP_MOUSE_NONE) {
        // Under mouse tracking every notch is a button 4 (up) or 5 (down) report.
        if ((notches < 0) != (wheelCarry_ < 0)) wheelCarry_ = 0;
        wheelCarry_ += notches;
        int n = (int)wheelCarry_;
        wheelCarry_ -= (float)n;
        if (n) {
          int row = (int)std::max(0L, std::min(h.absRow, (long)g.store().rows() - 1));
          g.mouseMove(row, h.col, m);
          for (int i = 0; i < std::abs(n); i++) g.mouseButton(n > 0 ? 4 : 5, true, m);
          h.v->appScrollNotches(n > 0 ? std::abs(n) : -std::abs(n));
          invalidate();
        }
        return true;
      }
      // The system's lines per notch (3 by default) at 1x; the ramp speeds a flick up.
      UINT lines = 3;
      SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
      if (lines == WHEEL_PAGESCROLL || lines == 0) lines = (UINT)std::max(1, g.store().rows() - 1);
      D2D1_RECT_F c00 = h.v->cellRect(0, 0), c11 = h.v->cellRect(1, 1);
      ramp_.rowPx = std::max(1.f, c11.top - c00.top);
      ramp_.forced1x = g.altScreen();
      float dyPx = -notches * (float)lines * ramp_.rowPx;   // positive scrolls toward the newest output
      int rows = ramp_.rows(dyPx, (double)GetTickCount64());
      if (rows == 0) return true;
      if (g.altScreen()) {
        // xterm.js in the alternate screen without tracking: arrow keys.
        for (int i = 0; i < std::abs(rows); i++) g.key(rows < 0 ? VTERM_KEY_UP : VTERM_KEY_DOWN, VTERM_MOD_NONE);
      } else {
        g.scrollView(rows);
      }
      invalidate();
      return true;
    }
    default:
      return false;
  }
}

void GridInput::focus(bool on) {
  if (on) return;
  ramp_.reset();
  wheelCarry_ = 0;
  highSurrogate_ = 0;
  swallowChar_ = false;
  if (drag_ != Drag::None) {
    if (drag_ == Drag::Report)
      if (Grid* g = App::instance().grid(dragPane_)) g->mouseButton(reportButton_, false, VTERM_MOD_NONE);
    drag_ = Drag::None;
    stopTimers();
  }
}

bool GridInput::gridCmd(const std::string& op, const std::string& paneId, const json& cmd) {
  Grid* g = App::instance().grid(paneId);
  if (op == "paste") {
    if (!g) return true;
    std::string text = cmd.contains("text") && cmd["text"].is_string() ? cmd["text"].get<std::string>() : std::string();
    if (text.empty()) return true;
    g->paste(text);   // bracketed when the program asked for it
    inputLineSelected_ = false;
    afterTyped(*g, false);
    return true;
  }
  if (op == "copy") {
    std::string text = selectionText(paneId);
    if (text.empty()) return true;   // nothing selected: the clipboard keeps what it had
    writeClipboard(Window::instance().hwnd(), text);
    App::log("copy %zu bytes from %s", text.size(), paneId.c_str());
    return true;
  }
  if (op == "selectAll") {
    if (g) selectInputLine(*g);
    return true;
  }
  if (op == "clear") {
    if (!g) return true;
    // term.clear(): the cursor's line becomes the first line and everything
    // else goes, scrollback included, so a half-typed prompt stays in view.
    // Scroll it to the top (SU, then the cursor up), blank the rows below it,
    // then drop the scrollback (ED 3 and the store's own copy).
    int n = g->cursor().row;
    std::string seq;
    if (n > 0) seq += "\x1b[" + std::to_string(n) + "S\x1b[" + std::to_string(n) + "A";
    if (g->store().rows() > 1) seq += "\x1b" "7\x1b[2;1H\x1b[J\x1b" "8";
    seq += "\x1b[3J";
    g->feed(seq.data(), seq.size());
    g->store().clearScrollback();
    g->scrollToBottom();
    sel_.erase(paneId);
    invalidate();
    return true;
  }
  return false;
}

void GridInput::noteFed(Grid& g, size_t sbBefore, const std::string& newestBefore, size_t sbCap) {
  size_t after = g.store().scrollbackLen();
  auto it = sel_.find(g.paneId());
  if (after > sbBefore) {
    long d = (long)(after - sbBefore);
    if (it != sel_.end()) it->second.shift(d, g.store());
    // A scrolled-back viewport already stays on its text: Grid::cbPushLine4
    // moves viewTop once per pushed row.
  } else if (after == sbBefore && after >= sbCap && it != sel_.end() && it->second.active &&
             g.store().text(-1) != newestBefore) {
    // At the cap rows leave as fast as they arrive and the count cannot say
    // how many moved: drop the selection rather than let it slide.
    it->second.clear();
  }
}

void GridInput::dropPane(const std::string& paneId) {
  sel_.erase(paneId);
  if (dragPane_ == paneId) { drag_ = Drag::None; stopTimers(); }
  if (inputLinePane_ == paneId) inputLineSelected_ = false;
}

const Selection* GridInput::selection(const std::string& paneId) const {
  auto it = sel_.find(paneId);
  return it == sel_.end() || !it->second.active ? nullptr : &it->second;
}

std::string GridInput::selectionText(const std::string& paneId) const {
  const Selection* s = selection(paneId);
  Grid* g = App::instance().grid(paneId);
  return s && g ? s->text(g->store()) : std::string();
}
