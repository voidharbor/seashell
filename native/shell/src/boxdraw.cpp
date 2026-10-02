#include "boxdraw.h"
#include "gfx.h"
#include <algorithm>
#include <cmath>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {
// Which segments each of U+2500..U+257F lights, four digits per codepoint in
// the order up, right, down, left: 0 none, 1 light, 2 heavy, 3 double.
// 'd' marks a dashed line, 'a' an arc, 'x' a diagonal (drawn in code below).
// clang-format off
const char* kLines =
  "0101" "0202" "1010" "2020" "dddd" "dddd" "dddd" "dddd"   // 2500 - 2507
  "dddd" "dddd" "dddd" "dddd" "0110" "0210" "0120" "0220"   // 2508 - 250F
  "0011" "0012" "0021" "0022" "1100" "1200" "2100" "2200"   // 2510 - 2517
  "1001" "1002" "2001" "2002" "1110" "1210" "2110" "1120"   // 2518 - 251F
  "2120" "2210" "1220" "2220" "1011" "1012" "2011" "1021"   // 2520 - 2527
  "2021" "2012" "1022" "2022" "0111" "0112" "0211" "0212"   // 2528 - 252F
  "0121" "0122" "0221" "0222" "1101" "1102" "1201" "1202"   // 2530 - 2537
  "2101" "2102" "2201" "2202" "1111" "1112" "1211" "1212"   // 2538 - 253F
  "2111" "1121" "2121" "2112" "2211" "1122" "1221" "2212"   // 2540 - 2547
  "1222" "2122" "2221" "2222" "dddd" "dddd" "dddd" "dddd"   // 2548 - 254F
  "0303" "3030" "0310" "0130" "0330" "0013" "0031" "0033"   // 2550 - 2557
  "1300" "3100" "3300" "1003" "3001" "3003" "1310" "3130"   // 2558 - 255F
  "3330" "1013" "3031" "3033" "0313" "0131" "0333" "1303"   // 2560 - 2567
  "3101" "3303" "1313" "3131" "3333" "aaaa" "aaaa" "aaaa"   // 2568 - 256F
  "aaaa" "xxxx" "xxxx" "xxxx" "0001" "1000" "0100" "0010"   // 2570 - 2577
  "0002" "2000" "0200" "0020" "0201" "1020" "0102" "2010";  // 2578 - 257F
// clang-format on

enum { U, R, D, L };

struct Box {
  float x0, y0, x1, y1;   // the cell snapped to whole pixels
  float cx, cy;           // the line centre
  float t;                // light thickness
};

void fill(ID2D1RenderTarget* rt, ID2D1Brush* b, float l, float t, float r, float bo) {
  if (r > l && bo > t) rt->FillRectangle(D2D1::RectF(l, t, r, bo), b);
}

float thick(const Box& bx, int w) { return w == 2 ? bx.t * 2 : bx.t; }

// A horizontal stroke of thickness th centred on y, from x a to x b.
void hline(ID2D1RenderTarget* rt, ID2D1Brush* br, float a, float b, float y, float th) {
  float top = std::floor(y - th / 2);
  fill(rt, br, std::min(a, b), top, std::max(a, b), top + th);
}
void vline(ID2D1RenderTarget* rt, ID2D1Brush* br, float a, float b, float x, float th) {
  float left = std::floor(x - th / 2);
  fill(rt, br, left, std::min(a, b), left + th, std::max(a, b));
}

// The solid and double lines of one codepoint. A single or heavy line meets
// a double one at its near stroke when it ends there, and at the far stroke
// when it turns a corner or crosses; a double stroke stops at the stroke of
// the double line it meets, so corners and tees close like xterm's.
void lines(ID2D1RenderTarget* rt, ID2D1Brush* br, const Box& bx, const int w[4]) {
  float g = bx.t;   // a double line's strokes sit g either side of the centre
  auto solid = [](int v) { return v == 1 || v == 2; };
  bool dblH = w[L] == 3 || w[R] == 3, dblV = w[U] == 3 || w[D] == 3;
  // The centre line a crossing solid line covers: [edge, edge + th).
  float thV = std::max(solid(w[U]) ? thick(bx, w[U]) : 0.f, solid(w[D]) ? thick(bx, w[D]) : 0.f);
  float thH = std::max(solid(w[L]) ? thick(bx, w[L]) : 0.f, solid(w[R]) ? thick(bx, w[R]) : 0.f);
  float edgeV = thV > 0 ? std::floor(bx.cx - thV / 2) : bx.cx, edgeH = thH > 0 ? std::floor(bx.cy - thH / 2) : bx.cy;
  bool throughV = w[U] && w[D], throughH = w[L] && w[R];
  // A stroke "at" x covers [lo(x), hi(x)) (hline and vline floor the same way).
  auto lo = [&](float x) { return std::floor(x - bx.t / 2); };
  auto hi = [&](float x) { return std::floor(x - bx.t / 2) + bx.t; };
  if (solid(w[R])) hline(rt, br, dblV ? lo(w[L] || !throughV ? bx.cx - g : bx.cx + g) : edgeV, bx.x1, bx.cy, thick(bx, w[R]));
  if (solid(w[L])) hline(rt, br, bx.x0, dblV ? hi(w[R] || !throughV ? bx.cx + g : bx.cx - g) : edgeV + thV, bx.cy, thick(bx, w[L]));
  if (solid(w[D])) vline(rt, br, dblH ? lo(w[U] || !throughH ? bx.cy - g : bx.cy + g) : edgeH, bx.y1, bx.cx, thick(bx, w[D]));
  if (solid(w[U])) vline(rt, br, bx.y0, dblH ? hi(w[D] || !throughH ? bx.cy + g : bx.cy - g) : edgeH + thH, bx.cx, thick(bx, w[U]));

  // Where a double stroke on side `same` of the perpendicular pair starts,
  // outward from the centre: -g reaches the far stroke of a double
  // perpendicular (an outer corner), +g stops at its near stroke.
  auto start = [&](int same, int other) -> float {
    if (same == 3) return g;
    if (same) return 0;
    if (other == 3) return -g;
    return 0;
  };
  for (int s = -1; s <= 1; s += 2) {   // s = -1: the top (or left) stroke
    int vs = s < 0 ? w[U] : w[D], vo = s < 0 ? w[D] : w[U];
    int hs = s < 0 ? w[L] : w[R], ho = s < 0 ? w[R] : w[L];
    if (w[R] == 3) hline(rt, br, lo(bx.cx + start(vs, vo)), bx.x1, bx.cy + s * g, bx.t);
    if (w[L] == 3) hline(rt, br, bx.x0, hi(bx.cx - start(vs, vo)), bx.cy + s * g, bx.t);
    if (w[D] == 3) vline(rt, br, lo(bx.cy + start(hs, ho)), bx.y1, bx.cx + s * g, bx.t);
    if (w[U] == 3) vline(rt, br, bx.y0, hi(bx.cy - start(hs, ho)), bx.cx + s * g, bx.t);
  }
}

// ┄┅┆┇ (3 dashes), ┈┉┊┋ (4), ╌╍╎╏ (2).
void dashes(ID2D1RenderTarget* rt, ID2D1Brush* br, const Box& bx, uint32_t cp) {
  int n, k;
  if (cp >= 0x2504 && cp <= 0x2507) { n = 3; k = cp - 0x2504; }
  else if (cp >= 0x2508 && cp <= 0x250B) { n = 4; k = cp - 0x2508; }
  else { n = 2; k = cp - 0x254C; }
  bool vertical = k >= 2;
  float th = (k % 2) ? bx.t * 2 : bx.t;
  float a = vertical ? bx.y0 : bx.x0, b = vertical ? bx.y1 : bx.x1;
  float seg = (b - a) / n, gap = std::max(1.f, std::round(seg * 0.35f));
  for (int i = 0; i < n; i++) {
    float s = std::round(a + i * seg + gap / 2), e = std::round(a + (i + 1) * seg - gap / 2);
    if (vertical) vline(rt, br, s, e, bx.cx, th);
    else hline(rt, br, s, e, bx.cy, th);
  }
}

void stroke(ID2D1RenderTarget* rt, ID2D1Brush* br, ID2D1Geometry* geo, float th) {
  D2D1_ANTIALIAS_MODE old = rt->GetAntialiasMode();
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
  rt->DrawGeometry(geo, br, th);
  rt->SetAntialiasMode(old);
}

// ╭╮╯╰: a straight run from each edge into a quarter circle at the centre.
void arc(ID2D1RenderTarget* rt, ID2D1Brush* br, const Box& bx, uint32_t cp) {
  ID2D1Factory1* f = Gfx::instance().d2d();
  ComPtr<ID2D1PathGeometry> geo;
  ComPtr<ID2D1GeometrySink> sink;
  if (!f || FAILED(f->CreatePathGeometry(geo.GetAddressOf())) || FAILED(geo->Open(sink.GetAddressOf()))) return;
  // The same centre the straight lines stroke around (hline and vline).
  float cx = std::floor(bx.cx - bx.t / 2) + bx.t / 2, cy = std::floor(bx.cy - bx.t / 2) + bx.t / 2;
  float r = std::min(bx.x1 - bx.x0, bx.y1 - bx.y0) / 2;
  bool down = cp == 0x256D || cp == 0x256E, right = cp == 0x256D || cp == 0x2570;
  float ey = down ? bx.y1 : bx.y0, ex = right ? bx.x1 : bx.x0;
  float sy = down ? 1.f : -1.f, sx = right ? 1.f : -1.f;
  sink->BeginFigure(D2D1::Point2F(cx, ey), D2D1_FIGURE_BEGIN_HOLLOW);
  sink->AddLine(D2D1::Point2F(cx, cy + sy * r));
  D2D1_SWEEP_DIRECTION dir = (down == right) ? D2D1_SWEEP_DIRECTION_CLOCKWISE : D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE;
  sink->AddArc(D2D1::ArcSegment(D2D1::Point2F(cx + sx * r, cy), D2D1::SizeF(r, r), 0, dir, D2D1_ARC_SIZE_SMALL));
  sink->AddLine(D2D1::Point2F(ex, cy));
  sink->EndFigure(D2D1_FIGURE_END_OPEN);
  if (FAILED(sink->Close())) return;
  stroke(rt, br, geo.Get(), bx.t);
}

void diagonal(ID2D1RenderTarget* rt, ID2D1Brush* br, const Box& bx, uint32_t cp) {
  D2D1_ANTIALIAS_MODE old = rt->GetAntialiasMode();
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
  if (cp == 0x2571 || cp == 0x2573) rt->DrawLine(D2D1::Point2F(bx.x1, bx.y0), D2D1::Point2F(bx.x0, bx.y1), br, bx.t);
  if (cp == 0x2572 || cp == 0x2573) rt->DrawLine(D2D1::Point2F(bx.x0, bx.y0), D2D1::Point2F(bx.x1, bx.y1), br, bx.t);
  rt->SetAntialiasMode(old);
}

// U+2580..U+259F.
void block(ID2D1RenderTarget* rt, ID2D1SolidColorBrush* br, const Box& bx, uint32_t cp) {
  float w = bx.x1 - bx.x0, h = bx.y1 - bx.y0;
  auto ys = [&](float frac) { return std::round(bx.y0 + h * frac); };
  auto xs = [&](float frac) { return std::round(bx.x0 + w * frac); };
  float mx = xs(0.5f), my = ys(0.5f);
  if (cp == 0x2580) { fill(rt, br, bx.x0, bx.y0, bx.x1, my); return; }
  if (cp >= 0x2581 && cp <= 0x2588) { fill(rt, br, bx.x0, ys(1 - (cp - 0x2580) / 8.f), bx.x1, bx.y1); return; }
  if (cp >= 0x2589 && cp <= 0x258F) { fill(rt, br, bx.x0, bx.y0, xs((0x2590 - cp) / 8.f), bx.y1); return; }
  if (cp == 0x2590) { fill(rt, br, mx, bx.y0, bx.x1, bx.y1); return; }
  if (cp >= 0x2591 && cp <= 0x2593) {
    // Shades as the brush at 25, 50 and 75 percent.
    float a = br->GetOpacity();
    br->SetOpacity(a * (cp - 0x2590) / 4.f);
    fill(rt, br, bx.x0, bx.y0, bx.x1, bx.y1);
    br->SetOpacity(a);
    return;
  }
  if (cp == 0x2594) { fill(rt, br, bx.x0, bx.y0, bx.x1, ys(1 / 8.f)); return; }
  if (cp == 0x2595) { fill(rt, br, xs(7 / 8.f), bx.y0, bx.x1, bx.y1); return; }
  // Quadrants, bits: 1 upper left, 2 upper right, 4 lower left, 8 lower right.
  static const uint8_t q[10] = { 4, 8, 1, 1 | 4 | 8, 1 | 8, 1 | 2 | 4, 1 | 2 | 8, 2, 2 | 4, 2 | 4 | 8 };
  int bits = q[cp - 0x2596];
  if (bits & 1) fill(rt, br, bx.x0, bx.y0, mx, my);
  if (bits & 2) fill(rt, br, mx, bx.y0, bx.x1, my);
  if (bits & 4) fill(rt, br, bx.x0, my, mx, bx.y1);
  if (bits & 8) fill(rt, br, mx, my, bx.x1, bx.y1);
}
}  // namespace

bool boxdrawHandles(uint32_t cp) { return cp >= 0x2500 && cp <= 0x259F; }

void boxdrawDraw(ID2D1RenderTarget* rt, ID2D1SolidColorBrush* brush, uint32_t cp, D2D1_RECT_F cell, float light) {
  if (!boxdrawHandles(cp)) return;
  Box bx;
  bx.x0 = std::round(cell.left); bx.x1 = std::round(cell.right);
  bx.y0 = std::round(cell.top); bx.y1 = std::round(cell.bottom);
  bx.t = std::max(1.f, std::round(light));
  bx.cx = bx.x0 + std::floor((bx.x1 - bx.x0) / 2);
  bx.cy = bx.y0 + std::floor((bx.y1 - bx.y0) / 2);
  D2D1_ANTIALIAS_MODE old = rt->GetAntialiasMode();
  rt->SetAntialiasMode(D2D1_ANTIALIAS_MODE_ALIASED);
  if (cp >= 0x2580) {
    block(rt, brush, bx, cp);
  } else {
    const char* e = kLines + (cp - 0x2500) * 4;
    if (e[0] == 'd') dashes(rt, brush, bx, cp);
    else if (e[0] == 'a') arc(rt, brush, bx, cp);
    else if (e[0] == 'x') diagonal(rt, brush, bx, cp);
    else {
      int w[4] = { e[0] - '0', e[1] - '0', e[2] - '0', e[3] - '0' };
      lines(rt, brush, bx, w);
    }
  }
  rt->SetAntialiasMode(old);
}
