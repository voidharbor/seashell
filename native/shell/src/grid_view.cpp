#include "grid_view.h"
#include "app.h"
#include "boxdraw.h"
#include "fonts.h"
#include "gfx.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#if __has_include("selection.h")
#include "selection.h"
#define SEASHELL_HAS_SELECTION 1
#endif
#if __has_include("find.h")
#include "find.h"
#define SEASHELL_HAS_FIND 1
#endif

using Microsoft::WRL::ComPtr;

namespace {
// Distinct brush colors kept per view; truecolor gradients past this start over.
const size_t kMaxBrushes = 512;

D2D1_COLOR_F rgbF(uint32_t c, float a = 1.f) {
  return D2D1::ColorF(((c >> 16) & 0xFF) / 255.f, ((c >> 8) & 0xFF) / 255.f, (c & 0xFF) / 255.f, a);
}

void appendUtf16(std::wstring& s, uint32_t cp) {
  if (cp >= 0x10000) {
    cp -= 0x10000;
    s.push_back((wchar_t)(0xD800 + (cp >> 10)));
    s.push_back((wchar_t)(0xDC00 + (cp & 0x3FF)));
  } else {
    s.push_back((wchar_t)cp);
  }
}

// A cell Consolas draws at exactly one advance, so a run of them is one layout
// whose columns line up. Anything wider, combined or likely to fall back to
// another font is laid out alone at its own column.
bool plainCell(const Cell& c) {
  return c.nchars == 0 || (c.nchars == 1 && c.width == 1 && c.chars[0] < 0x0500);
}

// app-scroll.ts thumbGeometry (VIEW_NOTCHES 6, MIN_THUMB_PX 24), in DIPs.
void thumbGeometry(int offset, int range, float trackPx, float* top, float* height) {
  if (trackPx <= 0) { *top = *height = 0; return; }
  float h = std::min(trackPx, std::max(24.f, std::round(trackPx * 6 / (range + 6))));
  float travel = trackPx - h;
  float fromBottom = std::min(1.f, (float)offset / (float)range);
  *top = std::round(travel * (1 - fromBottom));
  *height = h;
}
}  // namespace

GridView::GridView(Grid& g, float fontPx) : grid_(g), fontPx_(0) { setFontPx(fontPx); }

void GridView::setFontPx(float px) {
  if (!(px > 0)) px = 13;
  if (px == fontPx_) return;
  fontPx_ = px;
  FontMetrics m = Fonts::metrics(px);
  cellW_ = m.cellW;
  cellH_ = m.cellH;
  baseline_ = m.baseline;
  invalidateAll();
}

void GridView::setRect(D2D1_RECT_F r) { rect_ = r; }

void GridView::setPalette(const TermPalette& p) {
  if (memcmp(&p, &pal_, sizeof p) == 0) return;
  pal_ = p;
  invalidateAll();
}

void GridView::invalidateAll() {
  for (RowCache& rc : cache_) rc.stale = true;
}

float GridView::originX() const { return std::round(rect_.left); }
float GridView::originY() const { return std::round(rect_.top); }

bool GridView::wantsBlink(bool focused) const {
  return focused && !exited_ && grid_.cursorBlink() && grid_.cursorVisible();
}

GridView::Colors GridView::resolve(const CellAttrs& a) const {
  auto one = [&](uint32_t c, bool fg) -> uint32_t {
    if (c == kColorDefault) return fg ? pal_.fg : pal_.bg;
    if (colorIsPalette(c)) {
      int i = (int)(c & 0xFF);
      if (fg && a.bold && i < 8) i += 8;   // xterm.js drawBoldTextInBrightColors, on by default
      return xterm256(i, pal_);
    }
    return c & 0xFFFFFF;
  };
  Colors out{ one(a.fg, true), one(a.bg, false) };
  if (a.reverse) std::swap(out.fg, out.bg);
  return out;
}

ID2D1SolidColorBrush* GridView::brush(uint32_t rgb) {
  auto it = brushes_.find(rgb);
  if (it != brushes_.end()) return it->second.Get();
  if (!rt_) return nullptr;
  if (brushes_.size() >= kMaxBrushes) {
    // Layouts hold brushes as drawing effects: rebuild them with the new set.
    brushes_.clear();
    invalidateAll();
  }
  ComPtr<ID2D1SolidColorBrush> b;
  if (FAILED(rt_->CreateSolidColorBrush(rgbF(rgb), b.GetAddressOf()))) return nullptr;
  brushes_[rgb] = b;
  return b.Get();
}

void GridView::build(RowCache& rc, long abs) {
  rc.abs = abs;
  rc.stale = false;
  rc.segs.clear();
  rc.boxes.clear();
  rc.bgs.clear();
  rc.links.clear();
  IDWriteFactory* dw = Gfx::instance().dwrite();
  IDWriteTextFormat* fmt = Fonts::format(fontPx_);
  if (!dw || !fmt) return;
  const GridStore& st = grid_.store();
  // Copied: a scrollback row's reference lives only for the next few row() calls.
  const std::vector<Cell> cells = st.row(abs).cells;
  int n = std::min((int)cells.size(), cols_);

  struct Attr { int pos, len; Colors c; CellAttrs a; };
  std::wstring text;
  std::vector<Attr> attrs;
  int segCol = -1;
  auto styleRange = [&](IDWriteTextLayout* lay, UINT32 pos, UINT32 len, const Colors& c, const CellAttrs& a) {
    DWRITE_TEXT_RANGE r{ pos, len };
    if (a.bold) lay->SetFontWeight(DWRITE_FONT_WEIGHT_BOLD, r);
    if (a.italic) lay->SetFontStyle(DWRITE_FONT_STYLE_ITALIC, r);
    if (a.underline) lay->SetUnderline(TRUE, r);
    if (a.strike) lay->SetStrikethrough(TRUE, r);
    if (ID2D1SolidColorBrush* b = brush(c.fg)) lay->SetDrawingEffect(b, r);
  };
  auto flush = [&] {
    if (segCol < 0) return;
    // Trailing unstyled blanks draw nothing.
    while (!text.empty() && text.back() == L' ' && (attrs.empty() || attrs.back().pos + attrs.back().len < (int)text.size()))
      text.pop_back();
    if (!text.empty()) {
      Seg s;
      s.col = segCol;
      s.ncols = (int)text.size();
      if (SUCCEEDED(dw->CreateTextLayout(text.data(), (UINT32)text.size(), fmt, (s.ncols + 1) * cellW_, cellH_, s.layout.GetAddressOf()))) {
        for (const Attr& at : attrs) styleRange(s.layout.Get(), at.pos, at.len, at.c, at.a);
        rc.segs.push_back(std::move(s));
      }
    }
    text.clear();
    attrs.clear();
    segCol = -1;
  };

  Run bg{ -1, 0, 0 };
  auto pushBg = [&] { if (bg.col >= 0) rc.bgs.push_back(bg); bg.col = -1; };
  for (int col = 0; col < n; col++) {
    const Cell& c = cells[col];
    if (c.width == 0) continue;   // the right half of a wide cell
    int w = std::min<int>(c.width, cols_ - col);
    Colors cl = resolve(c.a);
    if (cl.bg != pal_.bg) {
      if (bg.col >= 0 && bg.color == cl.bg && bg.col + bg.ncols == col) bg.ncols += w;
      else { pushBg(); bg = Run{ col, w, cl.bg }; }
    } else {
      pushBg();
    }
    if (c.a.uri) rc.links.push_back(Run{ col, w, c.a.uri });
    uint32_t cps[8];
    int k = st.chars(c, cps, 8);
    if (k == 1 && boxdrawHandles(cps[0])) {
      rc.boxes.push_back(BoxCell{ col, w, cps[0], cl.fg });
      if (segCol >= 0) {   // keep the run's columns: a space stands in
        text.push_back(L' ');
      }
      continue;
    }
    if (plainCell(c)) {
      if (segCol < 0) segCol = col;
      int pos = (int)text.size();
      text.push_back(k ? (wchar_t)cps[0] : L' ');
      if (k == 0 && !c.a.underline && !c.a.strike) continue;   // a blank needs no style
      if (!attrs.empty() && attrs.back().pos + attrs.back().len == pos && attrs.back().a == c.a && attrs.back().c.fg == cl.fg)
        attrs.back().len++;
      else
        attrs.push_back(Attr{ pos, 1, cl, c.a });
      continue;
    }
    flush();
    std::wstring one;
    for (int i = 0; i < k; i++) appendUtf16(one, cps[i]);
    Seg s;
    s.col = col;
    s.ncols = w;
    if (SUCCEEDED(dw->CreateTextLayout(one.data(), (UINT32)one.size(), fmt, (w + 1) * cellW_, cellH_, s.layout.GetAddressOf()))) {
      styleRange(s.layout.Get(), 0, (UINT32)one.size(), cl, c.a);
      rc.segs.push_back(std::move(s));
    }
  }
  pushBg();
  flush();
}

void GridView::draw(ID2D1RenderTarget* rt, bool focused, const Selection* sel, const FindDecor* find, uint32_t hoverUri) {
  if (!rt) return;
  if (rt != rt_) {   // a new target: brushes and the drawing effects in every layout are gone
    rt_ = rt;
    brushes_.clear();
    invalidateAll();
  }
  const GridStore& st = grid_.store();
  if (st.cols() != cols_ || st.rows() != rows_) {
    cols_ = st.cols();
    rows_ = st.rows();
    cache_.assign(rows_, RowCache{});
  }
  // Damage is in screen rows. While scrolled back the visible rows renumber
  // under new output, so any damage rebuilds them all.
  std::vector<VTermRect> dmg = grid_.takeDamage();
  long top = grid_.viewTop();
  if (!dmg.empty()) {
    if (top != 0) {
      invalidateAll();
    } else {
      for (const VTermRect& r : dmg)
        for (int row = std::max(0, r.start_row); row < std::min(rows_, r.end_row); row++) cache_[row].stale = true;
    }
  }
  viewTop_ = top;

  float ox = originX(), oy = originY();
  rt->PushAxisAlignedClip(rect_, D2D1_ANTIALIAS_MODE_ALIASED);
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_ALIASED);
  if (ID2D1SolidColorBrush* b = brush(pal_.bg)) rt->FillRectangle(rect_, b);

  auto cellsRect = [&](int v, int col, int ncols) {
    float x0 = std::round(ox + col * cellW_), x1 = std::round(ox + (col + ncols) * cellW_);
    float y0 = oy + v * cellH_;
    return D2D1::RectF(x0, y0, x1, y0 + cellH_);
  };
  float light = std::max(1.f, std::round(fontPx_ / 13.f));
  for (int v = 0; v < rows_; v++) {
    long abs = top + v;
    RowCache& rc = cache_[v];
    if (rc.stale || rc.abs != abs) build(rc, abs);
    for (const Run& r : rc.bgs)
      if (ID2D1SolidColorBrush* b = brush(r.color)) rt->FillRectangle(cellsRect(v, r.col, r.ncols), b);
#ifdef SEASHELL_HAS_FIND
    if (find) {
      for (size_t i = 0; i < find->matches.size(); i++) {
        const auto& m = find->matches[i];
        if (m.first != abs) continue;
        if (ID2D1SolidColorBrush* b = brush((int)i == find->active ? kFindActive : kFindMatch))
          rt->FillRectangle(cellsRect(v, m.second.first, m.second.second - m.second.first), b);
      }
    }
#else
    (void)find;
#endif
#ifdef SEASHELL_HAS_SELECTION
    if (sel && sel->active) {
      // Ordered start to end; the end column is exclusive.
      long r0 = sel->startRow, r1 = sel->endRow;
      int c0 = sel->startCol, c1 = sel->endCol;
      if (r0 > r1 || (r0 == r1 && c0 > c1)) { std::swap(r0, r1); std::swap(c0, c1); }
      if (abs >= r0 && abs <= r1) {
        int a = abs == r0 ? c0 : 0, e = abs == r1 ? c1 : cols_;
        if (e > a)
          if (ID2D1SolidColorBrush* b = brush(pal_.selection)) rt->FillRectangle(cellsRect(v, a, e - a), b);
      }
    }
#else
    (void)sel;
#endif
    for (const Seg& s : rc.segs) {
      ID2D1SolidColorBrush* def = brush(pal_.fg);
      if (def && s.layout)
        rt->DrawTextLayout(D2D1::Point2F(ox + s.col * cellW_, oy + v * cellH_), s.layout.Get(), def,
                           D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT | D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
    for (const BoxCell& bx : rc.boxes)
      if (ID2D1SolidColorBrush* b = brush(bx.fg)) boxdrawDraw(rt, b, bx.cp, cellsRect(v, bx.col, bx.ncols), light);
    if (hoverUri) {
      // OSC 8 links are underlined while hovered.
      for (const Run& l : rc.links) {
        if (l.color != hoverUri) continue;
        D2D1_RECT_F r = cellsRect(v, l.col, l.ncols);
        float y = std::round(oy + v * cellH_ + baseline_) + light;
        if (ID2D1SolidColorBrush* b = brush(pal_.fg)) rt->FillRectangle(D2D1::RectF(r.left, y, r.right, y + light), b);
      }
    }
  }
  drawCursor(rt, focused, ox, oy);
  if (appBar_) drawAppScrollbar(rt);
  rt->PopAxisAlignedClip();
}

void GridView::drawCursor(ID2D1RenderTarget* rt, bool focused, float ox, float oy) {
  if (!grid_.cursorVisible()) return;
  VTermPos cur = grid_.cursor();
  long v = cur.row - viewTop_;
  if (v < 0 || v >= rows_ || cur.col < 0 || cur.col >= cols_) return;
  if (wantsBlink(focused) && !blinkOn_) return;
  const GridStore& st = grid_.store();
  const Row& row = st.row(cur.row);
  Cell cell = cur.col < (int)row.cells.size() ? row.cells[cur.col] : Cell{};
  int w = std::max(1, std::min<int>(cell.width, cols_ - cur.col));
  float x0 = std::round(ox + cur.col * cellW_), x1 = std::round(ox + (cur.col + w) * cellW_);
  float y0 = oy + v * cellH_, y1 = y0 + cellH_;
  ID2D1SolidColorBrush* cb = brush(pal_.cursor);
  if (!cb) return;
  float px = std::max(1.f, std::round(dpiScale_));
  int shape = grid_.cursorShape();
  if (!focused) {
    // An unfocused grid shows a 1 px outline, whatever the shape.
    rt->DrawRectangle(D2D1::RectF(x0 + 0.5f, y0 + 0.5f, x1 - 0.5f, y1 - 0.5f), cb, 1.f);
    return;
  }
  if (shape == VTERM_PROP_CURSORSHAPE_BAR_LEFT) { rt->FillRectangle(D2D1::RectF(x0, y0, x0 + px, y1), cb); return; }
  if (shape == VTERM_PROP_CURSORSHAPE_UNDERLINE) { rt->FillRectangle(D2D1::RectF(x0, y1 - px, x1, y1), cb); return; }
  rt->FillRectangle(D2D1::RectF(x0, y0, x1, y1), cb);
  // The glyph again, in the cursor accent, over the block.
  uint32_t cps[8];
  int k = st.chars(cell, cps, 8);
  ID2D1SolidColorBrush* ab = brush(pal_.cursorAccent);
  if (!k || !ab) return;
  if (k == 1 && boxdrawHandles(cps[0])) { boxdrawDraw(rt, ab, cps[0], D2D1::RectF(x0, y0, x1, y1), std::max(1.f, std::round(fontPx_ / 13.f))); return; }
  std::wstring s;
  for (int i = 0; i < k; i++) appendUtf16(s, cps[i]);
  IDWriteFactory* dw = Gfx::instance().dwrite();
  IDWriteTextFormat* fmt = cell.a.bold ? Fonts::bold(fontPx_) : cell.a.italic ? Fonts::italic(fontPx_) : Fonts::format(fontPx_);
  ComPtr<IDWriteTextLayout> lay;
  if (dw && fmt && SUCCEEDED(dw->CreateTextLayout(s.data(), (UINT32)s.size(), fmt, (w + 1) * cellW_, cellH_, lay.GetAddressOf()))) {
    rt->PushAxisAlignedClip(D2D1::RectF(x0, y0, x1, y1), D2D1_ANTIALIAS_MODE_ALIASED);
    rt->DrawTextLayout(D2D1::Point2F(ox + cur.col * cellW_, y0), lay.Get(), ab, D2D1_DRAW_TEXT_OPTIONS_NONE);
    rt->PopAxisAlignedClip();
  }
}

bool GridView::cellAt(float x, float y, long* absRow, int* col) const {
  if (x < rect_.left || x >= rect_.right || y < rect_.top || y >= rect_.bottom || cols_ <= 0 || rows_ <= 0) return false;
  int c = (int)std::floor((x - originX()) / cellW_);
  int v = (int)std::floor((y - originY()) / cellH_);
  if (c < 0 || v < 0 || v >= rows_) return false;
  if (absRow) *absRow = viewTop_ + v;
  if (col) *col = std::min(c, cols_ - 1);
  return true;
}

D2D1_RECT_F GridView::cellRect(long absRow, int col) const {
  float x = originX() + col * cellW_, y = originY() + (absRow - viewTop_) * cellH_;
  return D2D1::RectF(x, y, x + cellW_, y + cellH_);
}

// The bar is 14 DIP at the grid's right edge; the thumb is 4 DIP wide, 3 DIP
// in from the edge (styles.css .app-scrollbar and __thumb), 30% of the fg.
void GridView::setAppScrollbar(bool on) {
  if (on == appBar_) return;
  appBar_ = on;
  appOffset_ = 0;
  appRange_ = 24;
}

void GridView::appScrollNotches(int notches) {
  appOffset_ = std::max(0, appOffset_ + notches);
  appRange_ = std::max(appRange_, appOffset_ + 4);   // HEADROOM
}

bool GridView::appScrollbarHit(float x, float y, int* part) const {
  if (part) *part = kBarNone;
  if (!appBar_ || x < rect_.right - 14 * dpiScale_ || x >= rect_.right || y < rect_.top || y >= rect_.bottom) return false;
  float top, h;
  thumbGeometry(appOffset_, appRange_, (rect_.bottom - rect_.top) / dpiScale_, &top, &h);
  float ty = (y - rect_.top) / dpiScale_;
  if (part) *part = ty < top ? kBarAbove : ty > top + h ? kBarBelow : kBarThumb;   // app-scroll.ts trackSide
  return true;
}

void GridView::drawAppScrollbar(ID2D1RenderTarget* rt) {
  float top, h;
  thumbGeometry(appOffset_, appRange_, (rect_.bottom - rect_.top) / dpiScale_, &top, &h);
  ID2D1SolidColorBrush* b = brush(pal_.fg);
  if (!b || h <= 0) return;
  float s = dpiScale_;
  D2D1_RECT_F r = D2D1::RectF(rect_.right - 7 * s, rect_.top + top * s, rect_.right - 3 * s, rect_.top + (top + h) * s);
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
  b->SetOpacity(0.3f);
  rt->FillRoundedRectangle(D2D1::RoundedRect(r, 2 * s, 2 * s), b);
  b->SetOpacity(1.f);
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_ALIASED);
}
