// Each pane's frame, its 24 DIP title bar, the attention border and the exit
// overlay. The grids themselves are drawn by App before this runs.
#include "ui/ui.h"
#include "paths.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace {
const uint32_t kWaiting = 0xE0A030;   // attention 'waiting', amber
const uint32_t kDone = 0x28FE14;      // attention 'done', the Homebrew green

uint32_t hexColor(const std::optional<std::string>& s, uint32_t fallback) {
  if (!s || s->size() != 7 || (*s)[0] != '#') return fallback;
  char* end = nullptr;
  unsigned long v = strtoul(s->c_str() + 1, &end, 16);
  return end && *end == 0 ? (uint32_t)v : fallback;
}
}  // namespace

void Ui::viewPanes(Painter& p) {
  float s = p.scale(), d = dpi();
  ULONGLONG now = GetTickCount64();
  for (const PaneModel& pm : m_.panes) {
    if (!paneVisible(pm)) continue;
    D2D1_RECT_F r = dev(pm.rect), g = dev(pm.gridRect);
    if (r.right <= r.left || r.bottom <= r.top) continue;
    std::string id = "pane:" + pm.id;
    D2D1_RECT_F title = D2D1::RectF(r.left, r.top, r.right, std::max(r.top, g.top));
    float th = title.bottom - title.top;
    uint32_t edge = hexColor(pm.color, t_.panelBorder);

    // The title bar: 6.2's glass gradient, brighter (toward titleSheen) on the focused pane.
    hit(false, title, id + ":title");
    if (p.live() && th > 0) {
      uint32_t top = pm.focused ? mixRgb(t_.titleSheen, t_.titleBar, 0.5f) : t_.titleBar;
      uint32_t bottom = pm.focused ? mixRgb(t_.titleSheen, t_.titleBar, 0.2f) : mixRgb(t_.titleBar, t_.panelBorder, 0.85f);
      auto c = [](uint32_t v) { return D2D1::ColorF(((v >> 16) & 0xFF) / 255.f, ((v >> 8) & 0xFF) / 255.f, (v & 0xFF) / 255.f, 1.f); };
      D2D1_GRADIENT_STOP stops[] = { { 0.f, c(top) }, { 1.f, c(bottom) } };
      p.gradientV(title, stops, 2);
      p.fillRect(D2D1::RectF(title.left, title.bottom - std::round(d), title.right, title.bottom), edge, pm.focused ? 1.f : 0.55f);
    }
    float x = title.left + 6 * s;
    // The index, then the color dot (pane:<id>:color; Phase 2 opens the picker).
    std::wstring idx = std::to_wstring(pm.index);
    float iw = std::max(10 * s, p.textWidth(idx, UiFont{ 11, true }));
    p.text(D2D1::RectF(x, title.top, x + iw, title.bottom), idx, UiFont{ 11, true }, t_.titleText, Align::Left, false);
    x += iw + 4 * s;
    D2D1_RECT_F dot = D2D1::RectF(x, title.top + (th - 16 * s) / 2, x + 16 * s, title.top + (th + 16 * s) / 2);
    hit(false, dot, id + ":color");
    if (p.live()) {
      D2D1_ELLIPSE e = D2D1::Ellipse(D2D1::Point2F((dot.left + dot.right) / 2, (dot.top + dot.bottom) / 2), 4.5f * s, 4.5f * s);
      ID2D1SolidColorBrush* b = nullptr;
      p.rt()->CreateSolidColorBrush(D2D1::ColorF(0, 0, 0, 1), &b);
      if (b) {
        auto set = [&](uint32_t v, float a) { b->SetColor(D2D1::ColorF(((v >> 16) & 0xFF) / 255.f, ((v >> 8) & 0xFF) / 255.f, (v & 0xFF) / 255.f, a)); };
        if (pm.color) { set(edge, 1); p.rt()->FillEllipse(e, b); }
        set(hovered(id + ":color") ? t_.accent : t_.badgeText, pm.color ? 0.5f : 0.8f);
        p.rt()->DrawEllipse(e, b, std::max(1.f, std::round(d)));
        b->Release();
      }
    }
    x = dot.right + 6 * s;

    // Right to left: close, memory, zoom percent, the badge, the link toggle.
    float rx = title.right - 4 * s;
    D2D1_RECT_F close = D2D1::RectF(rx - 20 * s, title.top + (th - 18 * s) / 2, rx, title.top + (th + 18 * s) / 2);
    hit(false, close, id + ":close");
    if (hovered(id + ":close")) p.roundedRect(close, 3, 0xC75050, 1, 0x8C2C2C, 1);
    p.glyph(close, 0x2715, hovered(id + ":close") ? 0xFFFFFF : t_.titleText, 9);
    rx = close.left - 4 * s;
    UiFont tiny{ 11 };
    if (pm.memBadge) {
      std::wstring mb = fromUtf8(*pm.memBadge);
      float w = p.textWidth(mb, tiny) + 4 * s;
      p.text(D2D1::RectF(rx - w, title.top, rx, title.bottom), mb, tiny, pm.memHigh ? t_.danger : t_.badgeText, Align::Right, false);
      rx -= w + 4 * s;
    }
    if (pm.zoomPercent) {
      std::wstring zp = std::to_wstring((int)std::lround(*pm.zoomPercent)) + L"%";
      float w = p.textWidth(zp, tiny) + 4 * s;
      p.text(D2D1::RectF(rx - w, title.top, rx, title.bottom), zp, tiny, t_.badgeText, Align::Right, false);
      rx -= w + 4 * s;
    }
    if (!pm.badge.empty()) {
      std::wstring bd = fromUtf8(pm.badge);
      float w = std::min(p.textWidth(bd, tiny) + 12 * s, 120 * s);
      D2D1_RECT_F pill = D2D1::RectF(rx - w, title.top + (th - 16 * s) / 2, rx, title.top + (th + 16 * s) / 2);
      p.roundedRect(pill, 8, t_.badge, 1, t_.panelBorder, 0.6f);
      p.text(inset(pill, 5 * s, 0), bd, tiny, t_.badgeText, Align::Center, true);
      rx = pill.left - 4 * s;
    }
    // The changes column's toggle, on the zoomed agent pane (changes.cpp draws the column).
    if (pm.changes != "none") {
      D2D1_RECT_F ch = D2D1::RectF(rx - 18 * s, title.top + (th - 18 * s) / 2, rx, title.top + (th + 18 * s) / 2);
      std::string target = id + ":changes";
      hit(false, ch, target);
      bool on = pm.changes == "on";
      if (on) p.roundedRect(ch, 3, t_.accent, hovered(target) ? 0.35f : 0.22f, t_.accent, 0.8f);
      else if (hovered(target)) p.roundedRect(ch, 3, t_.hoverFace, 0.6f, t_.panelBorder, 0.6f);
      p.glyph(ch, 0x00B1, on ? t_.accent : t_.badgeText, 12);   // the plus-minus of a diff
      rx = ch.left - 4 * s;
    }
    if (pm.linkEnabled) {
      D2D1_RECT_F link = D2D1::RectF(rx - 18 * s, title.top + (th - 18 * s) / 2, rx, title.top + (th + 18 * s) / 2);
      hit(false, link, id + ":link");
      if (hovered(id + ":link")) p.roundedRect(link, 3, t_.hoverFace, 0.6f, t_.panelBorder, 0.6f);
      p.glyph(link, 0x21C4, pm.linked ? t_.accent : t_.badgeText, 11);
      rx = link.left - 4 * s;
    }
    p.text(D2D1::RectF(x, title.top, std::max(x, rx - 4 * s), title.bottom), fromUtf8(pm.label), UiFont{ 12, pm.focused }, t_.titleText,
           Align::Left, true);

    // The body: the grid is App's; a restored file or web pane is a placeholder.
    if (pm.kind == "term") {
      hit(false, g, id + ":grid");
    } else {
      hit(false, g, id + ":view");
      p.fillRect(g, t_.panel);
      p.text(g, L"Previews are not in this build", UiFont{ 12 }, t_.badgeText,
             Align::Center, true);
    }

    if (pm.kind == "term" && (coreDead_ || pm.exit)) viewExitOverlay(p, pm, g);

    // The frame, rounded by the theme's radius: the corners outside it take
    // the body colour over whatever the grid drew there, then the edge (the
    // pane's color or panelBorder, full strength when focused).
    p.cornerMask(r, t_.radius, t_.body);
    p.roundedStroke(r, t_.radius, edge, 1, pm.focused ? 1.f : 0.55f);
    bool on = false;
    float level = attentionLevel(pm, now, &on);
    if (on && p.live()) {
      uint32_t c = hexColor(pm.color, pm.attention == "waiting" ? kWaiting : kDone);
      p.roundedStroke(r, t_.radius, c, 2, 0.25f + 0.75f * level);
    }
  }
}

// A dimmed panel over the grid: the exit text (red when it failed) and Restart.
void Ui::viewExitOverlay(Painter& p, const PaneModel& pm, D2D1_RECT_F g) {
  float s = p.scale();
  if (g.right - g.left < 40 * s || g.bottom - g.top < 40 * s) return;
  p.fillRect(g, t_.shadow, 0.55f);
  float w = std::min(300 * s, g.right - g.left - 16 * s), h = std::min(88 * s, g.bottom - g.top - 8 * s);
  float cx = (g.left + g.right) / 2, cy = (g.top + g.bottom) / 2;
  D2D1_RECT_F card = D2D1::RectF(std::round(cx - w / 2), std::round(cy - h / 2), std::round(cx + w / 2), std::round(cy + h / 2));
  p.roundedRect(card, t_.radius, t_.toastBg, 1, t_.cardBorder, 1);
  bool failed = coreDead_ || (pm.exit && pm.exit->failed);
  std::wstring msg = coreDead_ ? L"core exited" : fromUtf8(pm.exit->text);
  p.text(D2D1::RectF(card.left + 10 * s, card.top + 8 * s, card.right - 10 * s, card.top + 36 * s), msg, UiFont{ 12, true },
         failed ? t_.dangerText : t_.toastText, Align::Center, true);
  D2D1_RECT_F btnR = D2D1::RectF(std::round(cx - 44 * s), card.bottom - 36 * s, std::round(cx + 44 * s), card.bottom - 12 * s);
  std::string target = "pane:" + pm.id + ":restart";
  hit(false, btnR, target);
  p.win7Button(btnR, btn(target), L"Restart");
}
