// Draws one pane's Grid with Direct2D and DirectWrite (native design spec
// section 5). Each viewport row keeps its text layouts until the grid's damage,
// a font change or a resize makes them stale; backgrounds, selection, find
// matches, box characters and the cursor are drawn every frame. UI thread only.
#pragma once
#include "grid.h"
#include "palette.h"
#include <d2d1_1.h>
#include <dwrite.h>
#include <wrl/client.h>
#include <climits>
#include <map>
#include <vector>

struct Selection;   // selection.h (Task 13)
struct FindDecor;   // find.h (Task 14)

class GridView {
public:
  GridView(Grid& g, float fontPx);
  void setFontPx(float px);                  // device pixels
  float fontPx() const { return fontPx_; }
  void setRect(D2D1_RECT_F r);               // the pane's gridRect in device pixels
  void setDpiScale(float s) { dpiScale_ = s > 0 ? s : 1; }   // the app scrollbar's DIP sizes
  void setPalette(const TermPalette& p);
  void setExited(bool exited) { exited_ = exited; }          // no blink after the pane exited
  void setBlinkPhase(bool on) { blinkOn_ = on; }             // App's 530 ms timer
  bool wantsBlink(bool focused) const;       // a focused, blinking, live cursor
  void draw(ID2D1RenderTarget* rt, bool focused, const Selection* sel, const FindDecor* find, uint32_t hoverUri);
  void invalidateAll();
  // geometry for input and path click
  bool cellAt(float x, float y, long* absRow, int* col) const;   // body coordinates to a cell
  D2D1_RECT_F cellRect(long absRow, int col) const;
  // the overlay app scrollbar (term/app-scrollbar.ts), shown when altScreen && mouseMode
  void setAppScrollbar(bool on); bool appScrollbarHit(float x, float y, int* part) const;
  void appScrollNotches(int notches);        // app-scroll.ts applyNotches: positive is up
  enum { kBarNone = 0, kBarAbove = 1, kBarThumb = 2, kBarBelow = 3 };

private:
  struct Seg { int col = 0; int ncols = 0; Microsoft::WRL::ComPtr<IDWriteTextLayout> layout; };
  struct BoxCell { int col; int ncols; uint32_t cp; uint32_t fg; };
  struct Run { int col; int ncols; uint32_t color; };
  struct RowCache {
    long abs = LONG_MIN;        // the absolute row this was built from
    bool stale = true;
    std::vector<Seg> segs;      // text: runs of plain cells, and each wide or unusual cluster alone
    std::vector<BoxCell> boxes; // U+2500..U+259F, drawn by boxdraw
    std::vector<Run> bgs;       // backgrounds that differ from the theme's
    std::vector<Run> links;     // OSC 8 cells, as (col, ncols, uri id)
  };
  struct Colors { uint32_t fg, bg; };

  Colors resolve(const CellAttrs& a) const;
  ID2D1SolidColorBrush* brush(uint32_t rgb);
  void build(RowCache& rc, long abs);
  void drawCursor(ID2D1RenderTarget* rt, bool focused, float ox, float oy);
  void drawAppScrollbar(ID2D1RenderTarget* rt);
  float originX() const;
  float originY() const;

  Grid& grid_;
  float fontPx_;
  float cellW_ = 7, cellH_ = 15, baseline_ = 12;
  float dpiScale_ = 1;
  D2D1_RECT_F rect_{};
  TermPalette pal_ = kHomebrew;
  bool exited_ = false, blinkOn_ = true;
  int cols_ = 0, rows_ = 0;
  long viewTop_ = 0;
  std::vector<RowCache> cache_;
  ID2D1RenderTarget* rt_ = nullptr;          // the target the brushes and drawing effects belong to
  std::map<uint32_t, Microsoft::WRL::ComPtr<ID2D1SolidColorBrush>> brushes_;
  bool appBar_ = false;
  int appOffset_ = 0, appRange_ = 24;        // app-scroll.ts AppScrollState, MIN_RANGE
};
