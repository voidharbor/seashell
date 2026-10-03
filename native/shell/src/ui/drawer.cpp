// The shell drawer (DrawerShell.tsx, drawn natively): the panel over the
// bottom of the grid area on `panel` with its 1 px top line and a short shadow
// above it, the grip across that edge, and the 24 DIP header (the label, the
// shell's title or cwd, `cd to pane` while the drawer's cwd differs from the
// pane's, and the close button). Every rect comes from the model; App draws
// the drawer's grid into gridRect after this and before the overlays.
#include "ui/ui.h"
#include "paths.h"
#include <algorithm>
#include <cmath>

void Ui::viewDrawer(Painter& p) {
  const DrawerModel& dm = m_.drawer;
  if (!haveModel_ || !dm.open) return;
  D2D1_RECT_F r = dev(dm.rect), g = dev(dm.gridRect);
  if (r.right <= r.left || r.bottom <= r.top) return;
  float s = p.scale(), d = dpi();
  float one = std::max(1.f, std::round(d));

  // The drawer floats over the panes: a press on the panel outside its parts
  // lands here and goes nowhere (the shell's own target, like find:bar).
  hit(false, r, "drawer:head");
  if (p.live()) {
    // styles.css box-shadow 0 -10px 28px #000a, as a fade above the top edge.
    D2D1_RECT_F above = D2D1::RectF(r.left, std::max(0.f, r.top - std::round(10 * d)), r.right, r.top);
    D2D1_GRADIENT_STOP stops[] = { { 0.f, D2D1::ColorF(0, 0, 0, 0.f) }, { 1.f, D2D1::ColorF(0, 0, 0, 0.22f) } };
    p.gradientV(above, stops, 2);
  }
  p.fillRect(r, t_.panel);
  p.fillRect(D2D1::RectF(r.left, r.top, r.right, std::min(r.bottom, r.top + one)), t_.panelBorder);

  // The header between the top line and the grid, over a 1 px `divider` line.
  D2D1_RECT_F head = D2D1::RectF(r.left, std::min(r.bottom, r.top + one), r.right, std::max(r.top + one, std::min(r.bottom, g.top - one)));
  if (head.bottom < r.bottom) p.fillRect(D2D1::RectF(r.left, head.bottom, r.right, std::min(r.bottom, head.bottom + one)), t_.divider);
  float hh = head.bottom - head.top;
  if (hh > 0) {
    // Right to left: close, then cd to pane.
    float rx = head.right - 6 * s;
    D2D1_RECT_F close = D2D1::RectF(rx - 20 * s, head.top + std::round((hh - 18 * s) / 2), rx, head.top + std::round((hh + 18 * s) / 2));
    hit(false, close, "drawer:close");
    if (hovered("drawer:close")) p.roundedRect(close, 3, 0xC75050, 1, 0x8C2C2C, 1);
    p.glyph(close, 0x2715, hovered("drawer:close") ? 0xFFFFFF : t_.titleText, 9);
    rx = close.left - 6 * s;
    if (dm.header.showCd) {
      std::wstring cd = L"cd to pane";
      float w = std::ceil(p.textWidth(cd, UiFont{ 11 })) + 16 * s;
      D2D1_RECT_F b = D2D1::RectF(std::round(rx - w), head.top + std::round((hh - 18 * s) / 2), std::round(rx),
                                  head.top + std::round((hh + 18 * s) / 2));
      hit(false, b, "drawer:cd");
      p.win7Button(b, btn("drawer:cd"), cd, 11);
      rx = b.left - 6 * s;
    }
    // Left to right: the label in bold, then the title or cwd, which truncates first.
    float x = head.left + 10 * s;
    UiFont lf{ 11, true };
    std::wstring label = fromUtf8(dm.header.label);
    float lw = std::min(std::ceil(p.textWidth(label, lf)) + 1, std::max(0.f, rx - x));
    p.text(D2D1::RectF(x, head.top, x + lw, head.bottom), label, lf, t_.titleText, Align::Left, true);
    x += lw + 8 * s;
    if (x < rx) p.text(D2D1::RectF(x, head.top, rx, head.bottom), fromUtf8(dm.header.title), UiFont{ 11 }, t_.badgeText, Align::Left, true);
  }

  // The terminal; App draws the grid here.
  if (g.bottom > g.top) hit(false, g, "drawer:grid");

  // The grip across the top edge (6 DIP from the model, the accent under the pointer or in a drag).
  D2D1_RECT_F grip = dev(dm.gripRect);
  hit(false, grip, "drawer:grip");
  if (hovered("drawer:grip") || dragDivider_ == "drawer:grip") p.fillRect(grip, t_.accent, 0.6f);
}
