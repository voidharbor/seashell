#include "ui/painter.h"
#include "gfx.h"
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
const Face kNormal{ 0xF2F2F2, 0xEBEBEB, 0xDDDDDD, 0xCFCFCF, 0x707070 };
const Face kHover{ 0xEAF6FD, 0xD9F0FC, 0xBEE6FD, 0xA7D9F5, 0x3C7FB1 };
const Face kPressed{ 0xE5F4FC, 0xC4E5F6, 0x98D1EF, 0x68B3DB, 0x2C628B };
const Face kDisabled{ 0xF4F4F4, 0xF4F4F4, 0xF4F4F4, 0xF4F4F4, 0xADB2B5 };
}  // namespace

uint32_t mixRgb(uint32_t rgb, uint32_t base, float w) {
  auto ch = [&](int sh) {
    float a = (float)((rgb >> sh) & 0xFF), b = (float)((base >> sh) & 0xFF);
    return (uint32_t)std::lround(std::clamp(a * w + b * (1 - w), 0.f, 255.f)) << sh;
  };
  return ch(16) | ch(8) | ch(0);
}

Painter::Painter(ID2D1RenderTarget* rt, float dpiScale, float uiScale)
    : rt_(rt), dpi_(dpiScale > 0 ? dpiScale : 1), ui_(uiScale > 0 ? uiScale : 1) {
  if (rt_) rt_->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1), brush_.GetAddressOf());
  if (!brush_) rt_ = nullptr;
}

ID2D1SolidColorBrush* Painter::brush(uint32_t rgb, float alpha) {
  brush_->SetColor(color(rgb, alpha));
  return brush_.Get();
}

IDWriteTextFormat* Painter::format(UiFont f, float px) {
  using Key = std::tuple<bool, bool, int>;
  static std::map<Key, ComPtr<IDWriteTextFormat>> cache;
  Key k{ f.symbol, f.bold, (int)std::lround(px * 4) };
  auto it = cache.find(k);
  if (it != cache.end()) return it->second.Get();
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
  cache[k] = tf;
  return tf.Get();
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

void Painter::win7Button(D2D1_RECT_F r, BtnState state, const std::wstring& label, float labelDip) {
  if (!rt_) return;
  const Face& f = state == BtnState::Hover ? kHover : state == BtnState::Pressed ? kPressed
                : state == BtnState::Disabled ? kDisabled : kNormal;
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
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one * 1.5f, one * 1.5f), rad, rad), brush(0x000000, 0.18f), one);
  else if (state != BtnState::Disabled)
    rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one * 1.5f, one * 1.5f), rad, rad), brush(0xFFFFFF, 0.8f), one);
  uint32_t border = state == BtnState::Default ? 0x3C7FB1 : f.border;
  rt_->DrawRoundedRectangle(D2D1::RoundedRect(inset(r, one / 2, one / 2), rad, rad), brush(border, 1), one);
  if (!label.empty())
    text(r, label, UiFont{ labelDip }, state == BtnState::Disabled ? 0x838383 : 0x1E1E1E, Align::Center, true);
}

void Painter::win7Tab(D2D1_RECT_F r, bool active, bool hover, uint32_t activeFace, uint32_t inactiveFace, uint32_t joinColor) {
  if (!rt_) return;
  ID2D1Factory* fac = nullptr;
  rt_->GetFactory(&fac);
  if (!fac) return;
  float rad = std::min(6 * scale(), (r.right - r.left) / 2);
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
  uint32_t top = active ? activeFace : mixRgb(0xFFFFFF, inactiveFace, hover ? 0.75f : 0.4f);
  uint32_t bottom = active ? joinColor : (hover ? mixRgb(0xFFFFFF, inactiveFace, 0.4f) : inactiveFace);
  D2D1_GRADIENT_STOP stops[] = { { 0.f, color(top, 1) }, { 1.f, color(bottom, 1) } };
  ComPtr<ID2D1GradientStopCollection> coll;
  ComPtr<ID2D1LinearGradientBrush> g;
  if (SUCCEEDED(rt_->CreateGradientStopCollection(stops, 2, coll.GetAddressOf())) &&
      SUCCEEDED(rt_->CreateLinearGradientBrush(D2D1::LinearGradientBrushProperties(D2D1::Point2F(0, r.top), D2D1::Point2F(0, r.bottom)),
                                               coll.Get(), g.GetAddressOf())))
    rt_->FillGeometry(fill.Get(), g.Get());
  // 6.3: a 1 px #8e8f8f border on three sides; the active tab has no bottom edge.
  rt_->DrawGeometry(edge.Get(), brush(0x8E8F8F, 1), one);
  if (!active) rt_->FillRectangle(D2D1::RectF(r.left, r.bottom - one, r.right, r.bottom), brush(0x8E8F8F, 1));
}

void Painter::text(D2D1_RECT_F r, const std::wstring& s, UiFont f, uint32_t rgb, Align a, bool ellipsis, float alpha) {
  if (!rt_ || s.empty() || r.right <= r.left) return;
  ComPtr<IDWriteTextLayout> tl = layout(s, f, r.right - r.left, r.bottom - r.top);
  if (!tl) return;
  tl->SetTextAlignment(a == Align::Center ? DWRITE_TEXT_ALIGNMENT_CENTER : a == Align::Right ? DWRITE_TEXT_ALIGNMENT_TRAILING
                                                                                           : DWRITE_TEXT_ALIGNMENT_LEADING);
  if (ellipsis) {
    ComPtr<IDWriteInlineObject> sign;
    IDWriteTextFormat* tf = format(f, f.dip * scale());
    if (tf && SUCCEEDED(Gfx::instance().dwrite()->CreateEllipsisTrimmingSign(tf, sign.GetAddressOf()))) {
      DWRITE_TRIMMING trim{ DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0 };
      tl->SetTrimming(&trim, sign.Get());
    }
  }
  rt_->PushAxisAlignedClip(r, D2D1_ANTIALIAS_MODE_ALIASED);
  rt_->DrawTextLayout(D2D1::Point2F(r.left, r.top), tl.Get(), brush(rgb, alpha), D2D1_DRAW_TEXT_OPTIONS_NONE);
  rt_->PopAxisAlignedClip();
}

void Painter::glyph(D2D1_RECT_F r, uint32_t codepoint, uint32_t rgb, float dip, float alpha) {
  text(r, utf16(codepoint), UiFont{ dip, false, true }, rgb, Align::Center, false, alpha);
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
