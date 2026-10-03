#include "ui/scrollbar.h"
#include <algorithm>
#include <cmath>

namespace {
const float kMinThumbDip = 18;
bool endsWith(const std::string& s, const char* p) {
  size_t n = strlen(p);
  return s.size() >= n && s.compare(s.size() - n, n, p) == 0;
}
D2D1_COLOR_F c(uint32_t v) { return D2D1::ColorF(((v >> 16) & 0xFF) / 255.f, ((v >> 8) & 0xFF) / 255.f, (v & 0xFF) / 255.f, 1.f); }
}  // namespace

float ScrollBar::clampOffset(float offset, float content, float viewport) {
  float max = std::max(0.f, content - viewport);
  if (!(offset > 0)) return 0;   // NaN too
  return std::min(offset, max);
}

void ScrollBar::layout(D2D1_RECT_F track, float scale) {
  bar_ = track;
  scale_ = scale > 0 ? scale : 1;
  float w = bar_.right - bar_.left, h = bar_.bottom - bar_.top;
  side_ = std::max(0.f, std::min(w, std::floor(h / 2)));
}

D2D1_RECT_F ScrollBar::thumb(const ScrollState& s) const {
  float len = std::max(0.f, trackBottom() - trackTop());
  if (s.content <= 0 || len <= 0) return D2D1::RectF(bar_.left, trackTop(), bar_.right, trackTop());
  float th = std::min(len, std::max(kMinThumbDip * scale_, len * s.viewport / s.content));
  float range = std::max(0.f, s.content - s.viewport);
  float t = range > 0 ? std::clamp(s.offset / range, 0.f, 1.f) : 0;
  float top = std::round(trackTop() + (len - th) * t);
  return D2D1::RectF(bar_.left, top, bar_.right, std::round(top + th));
}

void ScrollBar::draw(Painter& p, const ScrollState& s, const std::string& hoverTarget, const std::string& base) {
  if (bar_.right <= bar_.left || bar_.bottom <= bar_.top) return;
  D2D1_RECT_F up = D2D1::RectF(bar_.left, bar_.top, bar_.right, bar_.top + side_);
  D2D1_RECT_F down = D2D1::RectF(bar_.left, bar_.bottom - side_, bar_.right, bar_.bottom);
  D2D1_RECT_F track = D2D1::RectF(bar_.left, up.bottom, bar_.right, down.top);
  D2D1_RECT_F th = thumb(s);
  if (hit) {
    hit(track, base + ":track");
    hit(th, base + ":thumb");
    hit(up, base + ":up");
    hit(down, base + ":down");
  }
  if (!p.live()) return;
  float one = std::max(1.f, std::round(p.dpiScale()));
  // The track and its 1 px inset line.
  p.fillRect(bar_, 0xF0F0F0);
  p.strokeRect(track, 0xE3E3E3);
  // The arrows: 6.3's button face under the pointer, the face's top colour otherwise.
  auto button = [&](D2D1_RECT_F r, const std::string& id, Painter::Dir dir) {
    bool hover = hoverTarget == id;
    if (hover) p.win7Button(r, BtnState::Hover);
    else p.win7Button(r, BtnState::Normal);
    float a = std::round(std::min(r.right - r.left, r.bottom - r.top) * 0.42f);
    float x = std::round((r.left + r.right - a) / 2), y = std::round((r.top + r.bottom - a) / 2);
    p.arrow(D2D1::RectF(x, y, x + a, y + a), dir, hover ? 0x1C4E7C : 0x4D4D4D);
  };
  button(up, base + ":up", Painter::Dir::Up);
  button(down, base + ":down", Painter::Dir::Down);
  if (th.bottom - th.top < 2 * one) return;
  bool hot = s.dragging || hoverTarget == base + ":thumb";
  D2D1_RECT_F tr = inset(th, one, 0);
  if (hot) {
    p.roundedRect(tr, 2, 0xDCEBFC, 1, 0x7DA2CE, 1);
  } else {
    D2D1_GRADIENT_STOP stops[] = { { 0.f, c(0xF0F0F0) }, { 1.f, c(0xE3E3E3) } };
    p.gradientH(tr, stops, 2, 2);
    p.roundedRect(tr, 2, 0, 0, 0xA0A0A0, 1);
  }
  // Three grip lines across the middle, each with a light line under it.
  if (th.bottom - th.top >= 14 * scale_) {
    float cy = std::round((th.top + th.bottom) / 2), half = std::round(3.5f * scale_);
    float cx = std::round((th.left + th.right) / 2);
    for (int i = -1; i <= 1; i++) {
      float y = cy + i * 2 * one - one;
      p.fillRect(D2D1::RectF(cx - half, y, cx + half, y + one), hot ? 0x5B7FA6 : 0x8A8A8A);
      p.fillRect(D2D1::RectF(cx - half, y + one, cx + half, y + 2 * one), 0xFFFFFF, 0.8f);
    }
  }
}

bool ScrollBar::mouse(UINT msg, float x, float y, ScrollState& s, float lineDip, const std::string& target) {
  (void)x;
  float range = std::max(0.f, s.content - s.viewport);
  if (msg == WM_MOUSEMOVE) {
    if (!s.dragging) return false;
    D2D1_RECT_F th = thumb(s);
    float len = (trackBottom() - trackTop()) - (th.bottom - th.top);
    float top = y - s.grab;
    s.offset = len > 0 ? clampOffset((top - trackTop()) / len * range, s.content, s.viewport) : 0;
    return true;
  }
  if (msg == WM_LBUTTONUP) {
    if (!s.dragging) return false;
    s.dragging = false;
    return true;
  }
  if (msg != WM_LBUTTONDOWN && msg != WM_LBUTTONDBLCLK) return false;
  if (endsWith(target, ":up")) {
    s.offset = clampOffset(s.offset - lineDip, s.content, s.viewport);
  } else if (endsWith(target, ":down")) {
    s.offset = clampOffset(s.offset + lineDip, s.content, s.viewport);
  } else if (endsWith(target, ":thumb")) {
    s.dragging = true;
    s.grab = y - thumb(s).top;
  } else if (endsWith(target, ":track")) {
    // A page toward the press, one line kept in view.
    float page = std::max(lineDip, s.viewport - lineDip);
    s.offset = clampOffset(s.offset + (y < thumb(s).top ? -page : page), s.content, s.viewport);
  } else {
    return false;
  }
  return true;
}
