#include "grid.h"
#include "width.h"
#include <algorithm>

namespace {
// More dirty rects than this between two frames is a full repaint anyway.
const size_t kMaxDamageRects = 32;
// The OSC 7 uri is a path; anything longer is not one.
const size_t kMaxOscBytes = 8192;
}  // namespace

Grid::Grid(const std::string& paneId, int cols, int rows, int scrollback)
    : paneId_(paneId), store_((size_t)std::max(0, scrollback)) {
  seashell_install_width_hooks();   // idempotent; before the first vterm_input_write
  cols = std::max(1, cols);
  rows = std::max(1, rows);
  vt_ = vterm_new(rows, cols);
  vterm_set_utf8(vt_, 1);
  screen_ = vterm_obtain_screen(vt_);
  state_ = vterm_obtain_state(vt_);
  store_.setSize(cols, rows);
  static VTermScreenCallbacks cbs = [] {
    VTermScreenCallbacks c{};
    c.damage = &Grid::cbDamage;
    c.moverect = &Grid::cbMoveRect;
    c.movecursor = &Grid::cbMoveCursor;
    c.settermprop = &Grid::cbSetTermProp;
    c.bell = &Grid::cbBell;
    c.resize = &Grid::cbResize;
    c.sb_popline = &Grid::cbPopLine;
    c.sb_clear = &Grid::cbSbClear;
    c.sb_pushline4 = &Grid::cbPushLine4;
    return c;
  }();
  static VTermStateFallbacks fbs = [] {
    VTermStateFallbacks f{};
    f.osc = &Grid::cbOsc;
    return f;
  }();
  vterm_screen_set_callbacks(screen_, &cbs, this);
  vterm_screen_callbacks_has_pushline4(screen_);
  vterm_screen_set_unrecognised_fallbacks(screen_, &fbs, this);
  vterm_screen_enable_reflow(screen_, true);
  vterm_screen_enable_altscreen(screen_, 1);
  vterm_screen_set_damage_merge(screen_, VTERM_DAMAGE_SCROLL);
  vterm_output_set_callback(vt_, &Grid::cbOutput, this);
  vterm_screen_reset(screen_, 1);
  readScreen();
  addDamage({ 0, rows, 0, cols });
}

Grid::~Grid() {
  if (vt_) vterm_free(vt_);
}

void Grid::setOutput(std::function<void(const std::string&)> fn) { output_ = std::move(fn); }

void Grid::feed(const char* bytes, size_t n) {
  if (n) vterm_input_write(vt_, bytes, n);
  vterm_screen_flush_damage(screen_);
  refreshWrapped();
}

void Grid::resize(int cols, int rows) {
  cols = std::max(1, cols);
  rows = std::max(1, rows);
  if (cols == store_.cols() && rows == store_.rows()) return;
  bool newCols = cols != store_.cols();
  vterm_set_size(vt_, rows, cols);
  vterm_screen_flush_damage(screen_);
  store_.setSize(cols, rows);   // cbResize did it already; a no-op unless libvterm skipped the callback
  if (newCols) store_.reflowScrollback(cols);
  readScreen();
  refreshWrapped();
  viewTop_ = std::max(viewTop_, -(long)store_.scrollbackLen());
  damage_.clear();
  addDamage({ 0, rows, 0, cols });
}

bool Grid::bracketedPaste() const { return vterm_screen_get_bracketpaste(screen_) != 0; }

void Grid::scrollView(long deltaRows) {
  viewTop_ = std::min(0L, std::max(-(long)store_.scrollbackLen(), viewTop_ + deltaRows));
}

std::vector<VTermRect> Grid::takeDamage() {
  std::vector<VTermRect> out;
  out.swap(damage_);
  return out;
}

void Grid::addDamage(VTermRect r) {
  if (damage_.size() == 1 && damage_[0].start_row == 0 && damage_[0].start_col == 0 &&
      damage_[0].end_row >= store_.rows() && damage_[0].end_col >= store_.cols())
    return;   // already a full repaint
  if (damage_.size() >= kMaxDamageRects) {
    damage_.clear();
    damage_.push_back({ 0, store_.rows(), 0, store_.cols() });
    return;
  }
  damage_.push_back(r);
}

std::string Grid::uriAt(int row, int col) const {
  const Row& r = store_.row(row);
  if (col < 0 || col >= (int)r.cells.size()) return {};
  if (r.cells[(size_t)col].width == 0 && col > 0) col--;
  const char* uri = vterm_screen_get_uri(screen_, r.cells[(size_t)col].a.uri);
  return uri ? uri : "";
}

// Newlines go to the pty as CR, as xterm.js's paste does; a pasted end marker
// cannot close bracketed paste early.
void Grid::paste(const std::string& utf8) {
  std::string body;
  body.reserve(utf8.size());
  for (size_t i = 0; i < utf8.size(); i++) {
    char c = utf8[i];
    if (c == '\r' && i + 1 < utf8.size() && utf8[i + 1] == '\n') continue;
    body += c == '\n' ? '\r' : c;
  }
  if (bracketedPaste()) {
    const std::string end = "\x1b[201~";
    for (size_t at; (at = body.find(end)) != std::string::npos;) body.erase(at, end.size());
  }
  vterm_keyboard_start_paste(vt_);
  if (output_ && !body.empty()) output_(body);
  vterm_keyboard_end_paste(vt_);
}

void Grid::key(VTermKey k, VTermModifier m) { vterm_keyboard_key(vt_, k, m); }
void Grid::unichar(uint32_t cp, VTermModifier m) { vterm_keyboard_unichar(vt_, cp, m); }
void Grid::mouseMove(int row, int col, VTermModifier m) { vterm_mouse_move(vt_, row, col, m); }
void Grid::mouseButton(int button, bool pressed, VTermModifier m) { vterm_mouse_button(vt_, button, pressed, m); }

// ---- the store mirror

uint32_t Grid::toColor(const VTermColor& c) const {
  if (c.type & VTERM_COLOR_DEFAULT_MASK) return kColorDefault;
  if (VTERM_COLOR_IS_INDEXED(&c)) return kColorPalette | c.indexed.idx;
  return ((uint32_t)c.rgb.red << 16) | ((uint32_t)c.rgb.green << 8) | c.rgb.blue;
}

VTermColor Grid::fromColor(uint32_t c, bool fg) const {
  VTermColor out;
  if (c == kColorDefault) {
    VTermColor dfg, dbg;
    vterm_state_get_default_colors(state_, &dfg, &dbg);
    out = fg ? dfg : dbg;
    out.type = (uint8_t)((out.type & ~VTERM_COLOR_DEFAULT_MASK) | (fg ? VTERM_COLOR_DEFAULT_FG : VTERM_COLOR_DEFAULT_BG));
  } else if (colorIsPalette(c)) {
    vterm_color_indexed(&out, (uint8_t)(c & 0xFF));
  } else {
    vterm_color_rgb(&out, (uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c);
  }
  return out;
}

void Grid::toCell(const VTermScreenCell& vc, Cell& out) {
  if (vc.chars[0] == (uint32_t)-1) {
    store_.setChars(out, nullptr, 0);
    out.width = 0;
  } else {
    int n = 0;
    while (n < VTERM_MAX_CHARS_PER_CELL && vc.chars[n]) n++;
    store_.setChars(out, vc.chars, n);
    out.width = (uint8_t)std::max(1, (int)vc.width);
  }
  out.a.fg = toColor(vc.fg);
  out.a.bg = toColor(vc.bg);
  out.a.bold = vc.attrs.bold;
  out.a.italic = vc.attrs.italic;
  out.a.underline = vc.attrs.underline;
  out.a.strike = vc.attrs.strike;
  out.a.reverse = vc.attrs.reverse;
  out.a.blink = vc.attrs.blink;
  out.a.dim = 0;
  out.a.uri = vc.uri_id;
}

void Grid::fromCell(const Cell& c, VTermScreenCell& out) const {
  out = VTermScreenCell{};
  if (c.width == 0) {
    out.chars[0] = (uint32_t)-1;
    out.width = 1;
  } else {
    uint32_t cps[VTERM_MAX_CHARS_PER_CELL];
    int n = store_.chars(c, cps, VTERM_MAX_CHARS_PER_CELL);
    for (int i = 0; i < n; i++) out.chars[i] = cps[i];
    if (n < VTERM_MAX_CHARS_PER_CELL) out.chars[n] = 0;
    out.width = (char)std::max<int>(1, c.width);
  }
  out.fg = fromColor(c.a.fg, true);
  out.bg = fromColor(c.a.bg, false);
  out.attrs.bold = c.a.bold;
  out.attrs.italic = c.a.italic;
  out.attrs.underline = c.a.underline;
  out.attrs.strike = c.a.strike;
  out.attrs.reverse = c.a.reverse;
  out.attrs.blink = c.a.blink;
  out.uri_id = c.a.uri;
}

void Grid::readRow(int r, int startCol, int endCol) {
  if (r < 0 || r >= store_.rows()) return;
  Row& row = store_.screenRow(r);
  startCol = std::max(0, startCol);
  endCol = std::min(endCol, store_.cols());
  for (int c = startCol; c < endCol; c++) {
    VTermScreenCell vc;
    if (!vterm_screen_get_cell(screen_, VTermPos{ r, c }, &vc)) continue;
    toCell(vc, row.cells[(size_t)c]);
    // A wide cell's continuation carries its head's link.
    if (row.cells[(size_t)c].width == 0 && c > 0) row.cells[(size_t)c].a.uri = row.cells[(size_t)c - 1].a.uri;
  }
}

void Grid::readScreen() {
  for (int r = 0; r < store_.rows(); r++) readRow(r, 0, store_.cols());
}

// A row is wrapped when libvterm marks the next one as its continuation; the
// newest scrollback row is wrapped when screen row 0 continues it.
void Grid::refreshWrapped() {
  int rows = store_.rows();
  for (int r = 0; r < rows; r++)
    store_.screenRow(r).wrapped = r + 1 < rows && vterm_state_get_lineinfo(state_, r + 1)->continuation;
  if (!altScreen_) store_.setNewestScrollbackWrapped(vterm_state_get_lineinfo(state_, 0)->continuation);
}

// ---- libvterm callbacks

int Grid::cbDamage(VTermRect r, void* u) {
  Grid* g = static_cast<Grid*>(u);
  for (int row = r.start_row; row < r.end_row; row++) g->readRow(row, r.start_col, r.end_col);
  g->addDamage(r);
  return 1;
}

// libvterm already moved its own cells; move the mirror the same way so only
// the rows it then erases and damages are read again.
int Grid::cbMoveRect(VTermRect dest, VTermRect src, void* u) {
  Grid* g = static_cast<Grid*>(u);
  GridStore& s = g->store_;
  int rows = dest.end_row - dest.start_row;
  int down = src.start_row - dest.start_row;
  bool fullWidth = src.start_col == 0 && src.end_col >= s.cols() && dest.start_col == 0;
  auto moveRow = [&](int i) {
    int d = dest.start_row + i, from = src.start_row + i;
    if (d < 0 || d >= s.rows() || from < 0 || from >= s.rows()) return;
    if (fullWidth) {
      std::swap(s.screenRow(d).cells, s.screenRow(from).cells);
      return;
    }
    std::vector<Cell> tmp(s.screenRow(from).cells.begin() + src.start_col, s.screenRow(from).cells.begin() + src.end_col);
    std::copy(tmp.begin(), tmp.end(), s.screenRow(d).cells.begin() + dest.start_col);
  };
  if (down > 0 || (down == 0 && dest.start_col <= src.start_col))
    for (int i = 0; i < rows; i++) moveRow(i);
  else
    for (int i = rows - 1; i >= 0; i--) moveRow(i);
  g->addDamage(dest);
  return 1;
}

int Grid::cbMoveCursor(VTermPos pos, VTermPos, int visible, void* u) {
  Grid* g = static_cast<Grid*>(u);
  g->cursor_ = pos;
  g->cursorVisible_ = visible != 0;
  return 1;
}

int Grid::cbSetTermProp(VTermProp prop, VTermValue* val, void* u) {
  Grid* g = static_cast<Grid*>(u);
  switch (prop) {
    case VTERM_PROP_TITLE:
      if (val->string.initial) g->title_.clear();
      if (g->title_.size() + val->string.len <= kMaxOscBytes) g->title_.append(val->string.str, val->string.len);
      if (val->string.final && g->onTitle) g->onTitle(g->title_);
      return 1;
    case VTERM_PROP_CURSORVISIBLE: g->cursorVisible_ = val->boolean != 0; return 1;
    case VTERM_PROP_CURSORBLINK: g->cursorBlink_ = val->boolean != 0; return 1;
    case VTERM_PROP_CURSORSHAPE: g->cursorShape_ = val->number; return 1;
    case VTERM_PROP_ALTSCREEN:
      g->altScreen_ = val->boolean != 0;
      g->viewTop_ = 0;
      return 1;
    case VTERM_PROP_MOUSE: g->mouseMode_ = val->number; return 1;
    default: return 0;
  }
}

int Grid::cbBell(void* u) {
  Grid* g = static_cast<Grid*>(u);
  if (g->onBell) g->onBell();
  return 1;
}

int Grid::cbResize(int rows, int cols, void* u) {
  static_cast<Grid*>(u)->store_.setSize(cols, rows);
  return 1;
}

int Grid::cbPushLine4(int cols, const VTermScreenCell* cells, bool continuation, void* u) {
  Grid* g = static_cast<Grid*>(u);
  Row r;
  r.cells.resize((size_t)std::max(0, cols));
  for (int c = 0; c < cols; c++) {
    g->toCell(cells[c], r.cells[(size_t)c]);
    if (r.cells[(size_t)c].width == 0 && c > 0) r.cells[(size_t)c].a.uri = r.cells[(size_t)c - 1].a.uri;
  }
  g->store_.pushScrollback(std::move(r), continuation);
  // Scrolled back: the viewport stays on the same text while output arrives.
  if (g->viewTop_ < 0) g->viewTop_ = std::max(g->viewTop_ - 1, -(long)g->store_.scrollbackLen());
  return 1;
}

int Grid::cbPopLine(int cols, VTermScreenCell* cells, void* u) {
  Grid* g = static_cast<Grid*>(u);
  Row r;
  if (!g->store_.popScrollback(r)) return 0;
  Cell blank;
  for (int c = 0; c < cols; c++) g->fromCell(c < (int)r.cells.size() ? r.cells[(size_t)c] : blank, cells[c]);
  // A wide cell cut by the last column cannot come back whole.
  if (cols > 0 && cells[cols - 1].width == 2) g->fromCell(blank, cells[cols - 1]);
  g->viewTop_ = std::max(g->viewTop_, -(long)g->store_.scrollbackLen());
  return 1;
}

int Grid::cbSbClear(void* u) {
  Grid* g = static_cast<Grid*>(u);
  g->store_.clearScrollback();
  g->viewTop_ = 0;
  return 1;
}

// OSC 7 (cwd) goes up raw; the core parses it with osc7.ts. OSC 8 is handled
// inside the patched screen.c and never reaches here.
int Grid::cbOsc(int command, VTermStringFragment frag, void* u) {
  Grid* g = static_cast<Grid*>(u);
  if (command != 7) return 0;
  if (frag.initial) g->osc_.clear();
  if (g->osc_.size() + frag.len <= kMaxOscBytes) g->osc_.append(frag.str, frag.len);
  if (frag.final && g->onCwd) g->onCwd(g->osc_);
  return 1;
}

void Grid::cbOutput(const char* s, size_t len, void* u) {
  Grid* g = static_cast<Grid*>(u);
  if (g->output_ && len) g->output_(std::string(s, len));
}
