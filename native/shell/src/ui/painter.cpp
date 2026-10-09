#include "ui/painter.h"
#include "gfx.h"
#include <d2d1effects.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <tuple>

using Microsoft::WRL::ComPtr;

namespace {
D2D1_COLOR_F color(uint32_t rgb, float a) {
  return D2D1::ColorF(((rgb >> 16) & 0xFF) / 255.f, ((rgb >> 8) & 0xFF) / 255.f, (rgb & 0xFF) / 255.f, a);
}

std::wstring utf16(uint32_t cp) {
  std::wstring s;
  if (cp >= 0x10000) {
    cp -= 0x10000;
    s.push_back((wchar_t)(0xD800 + (cp >> 10)));
    s.push_back((wchar_t)(0xDC00 + (cp & 0x3FF)));
  } else {
    s.push_back((wchar_t)cp);
  }
  return s;
}

// 6.3 button faces: top, upper middle, lower middle, bottom; the border.
struct Face { uint32_t c0, c1, c2, c3, border; };
Face faceOf(const Tokens& t, BtnState state) {
  switch (state) {
    case BtnState::Hover: return Face{ t.btnHover0, t.btnHover1, t.btnHover2, t.btnHover3, t.btnHoverBorder };
    case BtnState::Pressed: return Face{ t.btnPress0, t.btnPress1, t.btnPress2, t.btnPress3, t.btnPressBorder };
    case BtnState::Disabled: return Face{ t.btnDisabled, t.btnDisabled, t.btnDisabled, t.btnDisabled, t.btnDisabledBorder };
    default: return Face{ t.btn0, t.btn1, t.btn2, t.btn3, t.btnBorder };
  }
}

// The row icons and arrows: factory resources built once in their own unit
// box (icons.tsx's 16 by 16 viewBox; 10 by 10 for the triangles) and mapped
// onto the target rect with a transform when drawn.
using P = D2D1_POINT_2F;
ComPtr<ID2D1PathGeometry> buildPath(void (*fn)(ID2D1GeometrySink*)) {
  ComPtr<ID2D1PathGeometry> g;
  ID2D1Factory1* f = Gfx::instance().d2d();
  if (!f || FAILED(f->CreatePathGeometry(g.GetAddressOf()))) return nullptr;
  ComPtr<ID2D1GeometrySink> sk;
  if (FAILED(g->Open(sk.GetAddressOf()))) return nullptr;
  fn(sk.Get());
  if (FAILED(sk->Close())) return nullptr;
  return g;
}
void bez(ID2D1GeometrySink* s, P a, P b, P c) { s->AddBezier(D2D1::BezierSegment(a, b, c)); }
P pt(float x, float y) { return D2D1::Point2F(x, y); }

// icons.tsx FolderIcon, first path (the back and tab), in absolute coordinates.
void folderBack(ID2D1GeometrySink* s) {
  s->BeginFigure(pt(1.5f, 4.2f), D2D1_FIGURE_BEGIN_FILLED);
  bez(s, pt(1.5f, 3.54f), pt(2.04f, 3.0f), pt(2.7f, 3.0f));
  s->AddLine(pt(5.8f, 3.0f));
  bez(s, pt(6.2f, 3.0f), pt(6.58f, 3.2f), pt(6.8f, 3.54f));
  s->AddLine(pt(7.4f, 4.44f));
  s->AddLine(pt(13.4f, 4.44f));
  bez(s, pt(14.06f, 4.44f), pt(14.6f, 4.98f), pt(14.6f, 5.64f));
  s->AddLine(pt(14.6f, 11.8f));
  bez(s, pt(14.6f, 12.46f), pt(14.06f, 13.0f), pt(13.4f, 13.0f));
  s->AddLine(pt(2.7f, 13.0f));
  bez(s, pt(2.04f, 13.0f), pt(1.5f, 12.46f), pt(1.5f, 11.8f));
  s->EndFigure(D2D1_FIGURE_END_CLOSED);
}
// Its second path (the front).
void folderFront(ID2D1GeometrySink* s) {
  s->BeginFigure(pt(1.5f, 6.6f), D2D1_FIGURE_BEGIN_FILLED);
  s->AddLine(pt(14.6f, 6.6f));
  s->AddLine(pt(14.6f, 11.8f));
  bez(s, pt(14.6f, 12.46f), pt(14.06f, 13.0f), pt(13.4f, 13.0f));
  s->AddLine(pt(2.7f, 13.0f));
  bez(s, pt(2.04f, 13.0f), pt(1.5f, 12.46f), pt(1.5f, 11.8f));
  s->EndFigure(D2D1_FIGURE_END_CLOSED);
}
// icons.tsx FileIcon: the page and its folded corner.
void filePage(ID2D1GeometrySink* s) {
  s->BeginFigure(pt(3.6f, 1.6f), D2D1_FIGURE_BEGIN_FILLED);
  s->AddLine(pt(8.9f, 1.6f));
  s->AddLine(pt(12.4f, 5.1f));
  s->AddLine(pt(12.4f, 14.4f));
  bez(s, pt(12.4f, 14.9f), pt(12.0f, 15.3f), pt(11.5f, 15.3f));
  s->AddLine(pt(3.6f, 15.3f));
  bez(s, pt(3.1f, 15.3f), pt(2.7f, 14.9f), pt(2.7f, 14.4f));
  s->AddLine(pt(2.7f, 2.5f));
  bez(s, pt(2.7f, 2.0f), pt(3.1f, 1.6f), pt(3.6f, 1.6f));
  s->EndFigure(D2D1_FIGURE_END_CLOSED);
}
void fileFold(ID2D1GeometrySink* s) {
  s->BeginFigure(pt(8.9f, 1.6f), D2D1_FIGURE_BEGIN_FILLED);
  s->AddLine(pt(12.4f, 5.1f));
  s->AddLine(pt(9.5f, 5.1f));
  s->AddArc(D2D1::ArcSegment(pt(8.9f, 4.5f), D2D1::SizeF(0.6f, 0.6f), 0, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
  s->EndFigure(D2D1_FIGURE_END_CLOSED);
}
void triangle(ID2D1GeometrySink* s, P a, P b, P c) {
  s->BeginFigure(a, D2D1_FIGURE_BEGIN_FILLED);
  s->AddLine(b);
  s->AddLine(c);
  s->EndFigure(D2D1_FIGURE_END_CLOSED);
}
void triRight(ID2D1GeometrySink* s) { triangle(s, pt(2.5f, 1), pt(7.5f, 5), pt(2.5f, 9)); }
void triDown(ID2D1GeometrySink* s) { triangle(s, pt(1, 2.5f), pt(9, 2.5f), pt(5, 7.5f)); }
void triLeft(ID2D1GeometrySink* s) { triangle(s, pt(7.5f, 1), pt(2.5f, 5), pt(7.5f, 9)); }
void triUp(ID2D1GeometrySink* s) { triangle(s, pt(1, 7.5f), pt(9, 7.5f), pt(5, 2.5f)); }

struct Shapes {
  ComPtr<ID2D1PathGeometry> folderBack, folderFront, filePage, fileFold, tri[4];
};
const Shapes& shapes() {
  static Shapes s = [] {
    Shapes x;
    x.folderBack = buildPath(folderBack);
    x.folderFront = buildPath(folderFront);
    x.filePage = buildPath(filePage);
    x.fileFold = buildPath(fileFold);
    x.tri[0] = buildPath(triRight);
    x.tri[1] = buildPath(triDown);
    x.tri[2] = buildPath(triLeft);
    x.tri[3] = buildPath(triUp);
    return x;
  }();
  return s;
}
}  // namespace

uint32_t mixRgb(uint32_t rgb, uint32_t base, float w) {
  auto ch = [&](int sh) {
    float a = (float)((rgb >> sh) & 0xFF), b = (float)((base >> sh) & 0xFF);
    return (uint32_t)std::lround(std::clamp(a * w + b * (1 - w), 0.f, 255.f)) << sh;
  };
  return ch(16) | ch(8) | ch(0);
}

Painter::Painter(ID2D1RenderTarget* rt, float dpiScale, float uiScale, const Tokens* tokens)
    : rt_(rt), dpi_(dpiScale > 0 ? dpiScale : 1), ui_(uiScale > 0 ? uiScale : 1), tokens_(tokens) {
  if (rt_) rt_->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1), brush_.GetAddressOf());
  if (!brush_) rt_ = nullptr;
}

const Tokens& Painter::tokens() const {
  static const Tokens kAero{};
  return tokens_ ? *tokens_ : kAero;
}

ID2D1SolidColorBrush* Painter::brush(uint32_t rgb, float alpha) {
  brush_->SetColor(color(rgb, alpha));
  return brush_.Get();
}

namespace {
// A text format and its ellipsis sign, made the first time either is asked for.
struct FormatEntry {
  ComPtr<IDWriteTextFormat> tf;
  ComPtr<IDWriteInlineObject> sign;
  bool signTried = false;
};

FormatEntry* formatEntry(UiFont f, float px) {
  using Key = std::tuple<bool, bool, int>;
  static std::map<Key, FormatEntry> cache;
  Key k{ f.symbol, f.bold, (int)std::lround(px * 4) };
  auto it = cache.find(k);
  if (it != cache.end()) return &it->second;
  ComPtr<IDWriteTextFormat> tf;
  IDWriteFactory* dw = Gfx::instance().dwrite();
  if (!dw) return nullptr;
  dw->CreateTextFormat(f.symbol ? L"Segoe UI Symbol" : L"Segoe UI", nullptr,
                       f.bold ? DWRITE_FONT_WEIGHT_SEMI_BOLD : DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL,
                       DWRITE_FONT_STRETCH_NORMAL, std::max(1.f, px), L"en-us", tf.GetAddressOf());
  if (!tf) return nullptr;
  tf->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
  tf->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
  if (cache.size() > 64) cache.clear();   // zoom levels times DPIs; never grows without bound
  FormatEntry& e = cache[k];
  e.tf = tf;
  return &e;
}
}  // namespace

IDWriteTextFormat* Painter::format(UiFont f, float px) {
  FormatEntry* e = formatEntry(f, px);
  return e ? e->tf.Get() : nullptr;
}

IDWriteInlineObject* Painter::ellipsisSign(UiFont f, float px) {
  FormatEntry* e = formatEntry(f, px);
  if (!e) return nullptr;
  if (!e->signTried) {
    e->signTried = true;
    if (IDWriteFactory* dw = Gfx::instance().dwrite()) dw->CreateEllipsisTrimmingSign(e->tf.Get(), e->sign.GetAddressOf());
  }
  return e->sign.Get();
}

ComPtr<IDWriteTextLayout> Painter::layout(const std::wstring& s, UiFont f, float maxW, float maxH) const {
  ComPtr<IDWriteTextLayout> tl;
  IDWriteTextFormat* tf = format(f, f.dip * scale());
  IDWriteFactory* dw = Gfx::instance().dwrite();
  if (!tf || !dw) return tl;
  dw->CreateTextLayout(s.data(), (UINT32)s.size(), tf, std::max(0.f, maxW), std::max(0.f, maxH), tl.GetAddressOf());
  return tl;
}

void Painter::fillRect(D2D1_RECT_F r, uint32_t rgb, float alpha) {
  if (!rt_ || r.right <= r.left || r.bottom <= r.top) return;
  rt_->FillRectangle(r, brush(rgb, alpha));
}

void Painter::strokeRect(D2D1_RECT_F r, uint32_t rgb, float widthDip, float alpha) {
  if (!rt_) return;
  float w = std::max(1.f, std::round(widthDip * dpi_));
  rt_->DrawRectangle(inset(r, w / 2, w / 2), brush(rgb, alpha), w);
}

void Painter::roundedRect(D2D1_RECT_F r, float radiusDip, uint32_t fill, float fillAlpha, uint32_t stroke, float strokeAlpha) {
  if (!rt_) return;
  float rad = radiusDip * scale();
  if (fillAlpha > 0) rt_->FillRoundedRectangle(D2D1::RoundedRect(r, rad, rad), brush(fill, fillAlpha));
  if (strokeAlpha > 0) {
    float w = std::max(1.f, std::round(dpi_));
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, w / 2, w / 2), rad, rad), brush(stroke, strokeAlpha), w);
  }
}

void Painter::gradientV(D2D1_RECT_F r, const D2D1_GRADIENT_STOP* stops, UINT n, float radiusDip) {
  if (!rt_ || r.bottom <= r.top) return;
  ComPtr<ID2D1GradientStopCollection> coll;
  if (FAILED(rt_->CreateGradientStopCollection(stops, n, coll.GetAddressOf()))) return;
  ComPtr<ID2D1LinearGradientBrush> g;
  if (FAILED(rt_->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(0, r.top), D2D1::Point2F(0, r.bottom)),
                                            coll.Get(), g.GetAddressOf())))
    return;
  if (radiusDip > 0) {
    float rad = radiusDip * scale();
    rt_->FillRoundedRectangle(D2D1::RoundedRect(r, rad, rad), g.Get());
  } else {
    rt_->FillRectangle(r, g.Get());
  }
}

void Painter::gradientH(D2D1_RECT_F r, const D2D1_GRADIENT_STOP* stops, UINT n, float radiusDip) {
  if (!rt_ || r.right <= r.left) return;
  ComPtr<ID2D1GradientStopCollection> coll;
  if (FAILED(rt_->CreateGradientStopCollection(stops, n, coll.GetAddressOf()))) return;
  ComPtr<ID2D1LinearGradientBrush> g;
  if (FAILED(rt_->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(r.left, 0), D2D1::Point2F(r.right, 0)),
                                            coll.Get(), g.GetAddressOf())))
    return;
  if (radiusDip > 0) {
    float rad = radiusDip * scale();
    rt_->FillRoundedRectangle(D2D1::RoundedRect(r, rad, rad), g.Get());
  } else {
    rt_->FillRectangle(r, g.Get());
  }
}

void Painter::fillShape(ID2D1Geometry* g, D2D1_RECT_F box, float units, uint32_t rgb, float alpha) {
  if (!rt_ || !g) return;
  D2D1_MATRIX_3X2_F old;
  rt_->GetTransform(&old);
  float sx = (box.right - box.left) / units, sy = (box.bottom - box.top) / units;
  rt_->SetTransform(D2D1::Matrix3x2F::Scale(sx, sy) * D2D1::Matrix3x2F::Translation(box.left, box.top) * old);
  rt_->FillGeometry(g, brush(rgb, alpha));
  rt_->SetTransform(old);
}

void Painter::strokeShape(ID2D1Geometry* g, D2D1_RECT_F box, float units, uint32_t rgb, float alpha) {
  if (!rt_ || !g) return;
  D2D1_MATRIX_3X2_F old;
  rt_->GetTransform(&old);
  float sx = (box.right - box.left) / units, sy = (box.bottom - box.top) / units;
  rt_->SetTransform(D2D1::Matrix3x2F::Scale(sx, sy) * D2D1::Matrix3x2F::Translation(box.left, box.top) * old);
  // One device pixel whatever the box's size.
  rt_->DrawGeometry(g, brush(rgb, alpha), std::max(1.f, std::round(dpi_)) / std::max(0.01f, sx));
  rt_->SetTransform(old);
}

namespace {
// The 16 DIP icon box at r's centre, on whole pixels.
D2D1_RECT_F iconBox(D2D1_RECT_F r, float side) {
  float x = std::round((r.left + r.right - side) / 2), y = std::round((r.top + r.bottom - side) / 2);
  return D2D1::RectF(x, y, x + side, y + side);
}
}  // namespace

void Painter::folderGlyph(D2D1_RECT_F r, bool open, float alpha) {
  if (!rt_) return;
  const Shapes& sh = shapes();
  D2D1_RECT_F b = iconBox(r, px(16));
  fillShape(sh.folderBack.Get(), b, 16, open ? 0x6FB1F0 : 0x5A9BE0, alpha);
  fillShape(sh.folderFront.Get(), b, 16, open ? 0x9CCBF7 : 0x7FB6EC, alpha);
}

void Painter::fileGlyph(D2D1_RECT_F r, const uint32_t* chip, float alpha) {
  if (!rt_) return;
  const Shapes& sh = shapes();
  D2D1_RECT_F b = iconBox(r, px(16));
  fillShape(sh.filePage.Get(), b, 16, 0xE8EDF2, alpha);
  // The page's own #e8edf2 hardly shows on the light panel: a 1 px edge.
  strokeShape(sh.filePage.Get(), b, 16, 0x8D9BA8, alpha);
  fillShape(sh.fileFold.Get(), b, 16, 0xB9C6D2, alpha);
  if (chip) {
    float u = (b.right - b.left) / 16;
    D2D1_RECT_F c = D2D1::RectF(std::round(b.left + 4.55f * u), std::round(b.top + 8.4f * u), 0, 0);
    c.right = c.left + std::round(6 * u);
    c.bottom = c.top + std::round(6 * u);
    roundedRect(c, 1, *chip, alpha, 0, 0);
  }
}

void Painter::arrow(D2D1_RECT_F box, Dir dir, uint32_t rgb, float alpha) {
  if (!rt_) return;
  fillShape(shapes().tri[(int)dir].Get(), box, 10, rgb, alpha);
}

void Painter::twisty(D2D1_RECT_F r, bool open, uint32_t rgb, float alpha) {
  if (!rt_) return;
  float side = px(9);
  float x = (r.left + r.right - side) / 2, y = (r.top + r.bottom - side) / 2;
  arrow(D2D1::RectF(x, y, x + side, y + side), open ? Dir::Down : Dir::Right, rgb, alpha);
}

void Painter::win7Button(D2D1_RECT_F r, BtnState state, const std::wstring& label, float labelDip) {
  if (!rt_) return;
  const Tokens& t = tokens();
  const Face f = faceOf(t, state);
  float one = std::max(1.f, std::round(dpi_));
  if (state == BtnState::Default) {
    // The default button's #3399ff glow ring, just outside the border.
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, -one, -one), 4 * scale(), 4 * scale()), brush(0x3399FF, 0.55f), 2 * one);
  }
  D2D1_GRADIENT_STOP stops[] = { { 0.f, color(f.c0, 1) }, { 0.5f, color(f.c1, 1) }, { 0.5f, color(f.c2, 1) }, { 1.f, color(f.c3, 1) } };
  gradientV(r, stops, 4, 3);
  float rad = 3 * scale();
  // The inner highlight; pressed buttons show an inset shadow instead.
  if (state == BtnState::Pressed)
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one * 1.5f, one * 1.5f), rad, rad), brush(t.shadow, 0.18f), one);
  else if (state != BtnState::Disabled)
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one * 1.5f, one * 1.5f), rad, rad), brush(t.btnShine, 0.8f), one);
  // 6.3: the default button keeps the 1 px btnBorder; only the glow ring marks it.
  rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one / 2, one / 2), rad, rad), brush(f.border, 1), one);
  if (!label.empty())
    text(r, label, UiFont{ labelDip }, state == BtnState::Disabled ? t.btnDisabledText : t.btnText, Align::Center, true);
}

void Painter::win7Tab(D2D1_RECT_F r, bool active, bool hover, uint32_t activeFace, uint32_t inactiveFace, uint32_t joinColor,
                      uint32_t sheen, uint32_t border, float topSheen) {
  if (!rt_) return;
  ID2D1Factory* fac = nullptr;
  rt_->GetFactory(&fac);
  if (!fac) return;
  float rad = std::min(5 * scale(), (r.right - r.left) / 2);
  float one = std::max(1.f, std::round(dpi_));
  auto shape = [&](bool closed, ComPtr<ID2D1PathGeometry>& out) {
    if (FAILED(fac->CreatePathGeometry(out.GetAddressOf()))) return false;
    ComPtr<ID2D1GeometrySink> sk;
    if (FAILED(out->Open(sk.GetAddressOf()))) return false;
    float l = r.left + one / 2, t = r.top + one / 2, rr = r.right - one / 2, b = r.bottom + (closed ? 0 : one);
    sk->BeginFigure(D2D1::Point2F(l, b), closed ? D2D1_FIGURE_BEGIN_FILLED : D2D1_FIGURE_BEGIN_HOLLOW);
    sk->AddLine(D2D1::Point2F(l, t + rad));
    sk->AddArc(D2D1::ArcSegment(D2D1::Point2F(l + rad, t), D2D1::SizeF(rad, rad), 0, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sk->AddLine(D2D1::Point2F(rr - rad, t));
    sk->AddArc(D2D1::ArcSegment(D2D1::Point2F(rr, t + rad), D2D1::SizeF(rad, rad), 0, D2D1_SWEEP_DIRECTION_CLOCKWISE, D2D1_ARC_SIZE_SMALL));
    sk->AddLine(D2D1::Point2F(rr, b));
    sk->EndFigure(closed ? D2D1_FIGURE_END_CLOSED : D2D1_FIGURE_END_OPEN);
    return SUCCEEDED(sk->Close());
  };
  ComPtr<ID2D1PathGeometry> fill, edge;
  if (!shape(true, fill) || !shape(false, edge)) { fac->Release(); return; }
  fac->Release();
  // Active: tabActive into the body color below it, so it joins the content.
  // Inactive: 6.3's #f2f2f2 to #dcdcdc, lighter under the pointer.
  uint32_t top = active ? activeFace : mixRgb(sheen, inactiveFace, hover ? 0.75f : topSheen);
  uint32_t bottom = active ? joinColor : (hover ? mixRgb(sheen, inactiveFace, 0.4f) : inactiveFace);
  D2D1_GRADIENT_STOP stops[] = { { 0.f, color(top, 1) }, { 1.f, color(bottom, 1) } };
  ComPtr<ID2D1GradientStopCollection> coll;
  ComPtr<ID2D1LinearGradientBrush> g;
  if (SUCCEEDED(rt_->CreateGradientStopCollection(stops, 2, coll.GetAddressOf())) &&
      SUCCEEDED(rt_->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(0, r.top), D2D1::Point2F(0, r.bottom)),
                                               coll.Get(), g.GetAddressOf())))
    rt_->FillGeometry(fill.Get(), g.Get());
  // 6.3: a 1 px #8e8f8f border on three sides; the active tab has no bottom edge.
  rt_->DrawGeometry(edge.Get(), brush(border, 1), one);
  if (!active) rt_->FillRectangle(D2D1::RectF(r.left, r.bottom - one, r.right, r.bottom), brush(border, 1));
}

void Painter::text(D2D1_RECT_F r, const std::wstring& s, UiFont f, uint32_t rgb, Align a, bool ellipsis, float alpha) {
  if (!rt_ || s.empty() || r.right <= r.left) return;
  ComPtr<IDWriteTextLayout> tl = textLayout(s, f, r.right - r.left, r.bottom - r.top, a, ellipsis);
  drawLayout(r, tl.Get(), rgb, alpha);
}

ComPtr<IDWriteTextLayout> Painter::textLayout(const std::wstring& s, UiFont f, float w, float h, Align a, bool ellipsis) const {
  ComPtr<IDWriteTextLayout> tl = layout(s, f, w, h);
  if (!tl) return tl;
  tl->SetTextAlignment(a == Align::Center ? DWRITE_TEXT_ALIGNMENT_CENTER : a == Align::Right ? DWRITE_TEXT_ALIGNMENT_TRAILING
                                                                                           : DWRITE_TEXT_ALIGNMENT_LEADING);
  if (ellipsis) {
    if (IDWriteInlineObject* sign = ellipsisSign(f, f.dip * scale())) {
      DWRITE_TRIMMING trim{ DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0 };
      tl->SetTrimming(&trim, sign);
    }
  }
  return tl;
}

void Painter::drawLayout(D2D1_RECT_F r, IDWriteTextLayout* tl, uint32_t rgb, float alpha) {
  if (!rt_ || !tl || r.right <= r.left) return;
  rt_->PushAxisAlignedClip(r, D2D1_ANTIALIAS_MODE_ALIASED);
  rt_->DrawTextLayout(D2D1::Point2F(r.left, r.top), tl, brush(rgb, alpha), D2D1_DRAW_TEXT_OPTIONS_NONE);
  rt_->PopAxisAlignedClip();
}

void Painter::glyph(D2D1_RECT_F r, uint32_t codepoint, uint32_t rgb, float dip, float alpha) {
  text(r, utf16(codepoint), UiFont{ dip, false, true }, rgb, Align::Center, false, alpha);
}

void Painter::glow(D2D1_RECT_F r, float blurDip, float alpha) {
  if (!rt_ || r.right <= r.left || r.bottom <= r.top) return;
  float blur = px(blurDip);
  ComPtr<ID2D1DeviceContext> dc;
  if (SUCCEEDED(rt_->QueryInterface(IID_PPV_ARGS(dc.GetAddressOf())))) {
    ComPtr<ID2D1Effect> flood, crop, gauss;
    if (SUCCEEDED(dc->CreateEffect(CLSID_D2D1Flood, flood.GetAddressOf())) &&
        SUCCEEDED(dc->CreateEffect(CLSID_D2D1Crop, crop.GetAddressOf())) &&
        SUCCEEDED(dc->CreateEffect(CLSID_D2D1GaussianBlur, gauss.GetAddressOf()))) {
      // Premultiplied: (1, 1, 1, alpha) paints full white whatever the alpha.
      flood->SetValue(D2D1_FLOOD_PROP_COLOR, D2D1::Vector4F(alpha, alpha, alpha, alpha));
      crop->SetInputEffect(0, flood.Get());
      crop->SetValue(D2D1_CROP_PROP_RECT, D2D1::Vector4F(r.left, r.top, r.right, r.bottom));
      gauss->SetInputEffect(0, crop.Get());
      gauss->SetValue(D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION, blur / 2);   // most of the falloff within blurDip
      gauss->SetValue(D2D1_GAUSSIANBLUR_PROP_BORDER_MODE, D2D1_BORDER_MODE_SOFT);
      dc->DrawImage(gauss.Get());
      return;
    }
  }
  // No device context: four widening soft rects build roughly the same falloff.
  for (int i = 4; i >= 1; i--) {
    float g = blur * i / 4;
    roundedRect(inset(r, -g, -g), (g + 2) / scale(), 0xFFFFFF, alpha / 4, 0xFFFFFF, 0);
  }
}

float Painter::textWidth(const std::wstring& s, UiFont f) const {
  if (s.empty()) return 0;
  ComPtr<IDWriteTextLayout> tl = layout(s, f, 100000, 1000);
  DWRITE_TEXT_METRICS m{};
  if (!tl || FAILED(tl->GetMetrics(&m))) return 0;
  return m.widthIncludingTrailingWhitespace;
}

size_t Painter::hitIndex(const std::wstring& s, UiFont f, float x0, float x) const {
  if (s.empty()) return 0;
  ComPtr<IDWriteTextLayout> tl = layout(s, f, 100000, 1000);
  if (!tl) return s.size();
  BOOL trailing = FALSE, inside = FALSE;
  DWRITE_HIT_TEST_METRICS m{};
  tl->HitTestPoint(x - x0, 1, &trailing, &inside, &m);
  size_t i = m.textPosition + (trailing ? m.length : 0);
  return std::min(i, s.size());
}

float Painter::caretX(const std::wstring& s, UiFont f, size_t index) const {
  if (s.empty() || index == 0) return 0;
  ComPtr<IDWriteTextLayout> tl = layout(s, f, 100000, 1000);
  if (!tl) return 0;
  float x = 0, y = 0;
  DWRITE_HIT_TEST_METRICS m{};
  tl->HitTestTextPosition((UINT32)std::min(index, s.size()), FALSE, &x, &y, &m);
  return x;
}

void Painter::pushClip(D2D1_RECT_F r) { if (rt_) rt_->PushAxisAlignedClip(r, D2D1_ANTIALIAS_MODE_ALIASED); }
void Painter::popClip() { if (rt_) rt_->PopAxisAlignedClip(); }
