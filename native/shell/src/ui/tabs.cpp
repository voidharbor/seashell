// The tab strip: the menu button, the tabs, new tab, new web preview, the zoom
// badge, sleep and settings. The DWM caption buttons own the right 138 DIP;
// nothing is drawn there. Everything not under a control is strip:empty, which
// drags the window.
#include "ui/ui.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cmath>

namespace {
const float kCaptionDip = 138;   // the DWM minimize, maximize and close buttons
const float kTabMinDip = 100, kTabMaxDip = 220;
const float kTabHDip = 30;       // the tab row sits at the strip's bottom edge
const float kBtnDip = 28;
// The dark strip (Task 12b): the inactive tabs' highlight and the tab edge.
const uint32_t kDarkSheen = 0x3A3A3A;
const uint32_t kDarkTabEdge = 0x0A0A0A;

// A glyph button on glass: a frosted face under the pointer, fainter on the
// dark strip so its light glyph still reads.
void glassButton(Painter& p, D2D1_RECT_F r, bool hover, bool down, bool dark) {
  if (!hover && !down) return;
  if (dark) p.roundedRect(r, 3, 0xFFFFFF, down ? 0.24f : 0.14f, 0xFFFFFF, 0.3f);
  else p.roundedRect(r, 3, 0xFFFFFF, down ? 0.55f : 0.35f, 0xFFFFFF, 0.7f);
}

// A chrome glyph in frameText. On glass it sits on the Win7 caption glow, as
// the caption text does, so it reads over any wallpaper; the opaque strip
// needs none, and neither does the dark strip, whose black wash carries its
// light glyphs (a white glow would wash them out).
void stripGlyph(Painter& p, bool glass, D2D1_RECT_F r, uint32_t cp, uint32_t ink, float dip, float alpha = 1) {
  if (glass && p.live()) {
    float cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, h = p.px(dip) * 0.5f;
    p.glow(D2D1::RectF(cx - h, cy - h, cx + h, cy + h), 4, 0.85f * alpha);
  }
  p.glyph(r, cp, ink, dip, alpha);
}
}  // namespace

void Ui::viewTabs(Painter& p) {
  Window& win = Window::instance();
  RECT rc{};
  if (win.hwnd()) GetClientRect(win.hwnd(), &rc);
  float W = (float)rc.right, H = (float)win.stripHeightPx();
  float s = p.scale(), d = dpi();
  hit(true, D2D1::RectF(0, 0, W, H), "strip:empty");
  float tabTop = std::max(2.f * d, H - kTabHDip * s);
  float btnTop = tabTop + 2 * s, btnBottom = H - 3 * s;
  uint32_t ink = t_.frameText;
  bool dark = stripDark();
  bool glass = onGlass();
  bool glow = glass && !dark;
  float one = std::max(1.f, std::round(d));

  // The menu button (Phase 2 opens the menu; Phase 1 toasts).
  float x = 6 * s;
  D2D1_RECT_F menu = D2D1::RectF(x, btnTop, x + kBtnDip * s, btnBottom);
  hit(true, menu, "menu");
  glassButton(p, menu, hovered("menu"), pressed("menu"), dark);
  stripGlyph(p, glow, menu, 0x2261, ink, 14);
  x = menu.right + 6 * s;

  // Right to left from the caption buttons: settings, sleep, the zoom badge.
  float rx = W - kCaptionDip * d - 6 * s;
  D2D1_RECT_F gear = D2D1::RectF(rx - kBtnDip * s, btnTop, rx, btnBottom);
  hit(true, gear, "settings");
  glassButton(p, gear, hovered("settings"), pressed("settings"), dark);
  stripGlyph(p, glow, gear, 0x2699, ink, 13);
  rx = gear.left - 2 * s;
  D2D1_RECT_F moon = D2D1::RectF(rx - kBtnDip * s, btnTop, rx, btnBottom);
  hit(true, moon, "sleep");
  glassButton(p, moon, hovered("sleep"), pressed("sleep"), dark);
  stripGlyph(p, glow, moon, m_.sleep ? 0x263E : 0x263D, ink, 13);
  rx = moon.left - 4 * s;
  if (m_.zoomBadge) {
    std::wstring z = fromUtf8(*m_.zoomBadge);
    float zw = p.textWidth(z, UiFont{ 11 }) + 14 * s;
    D2D1_RECT_F badge = D2D1::RectF(rx - zw, btnTop + 4 * s, rx, btnBottom - 4 * s);
    hit(true, badge, "zoom:badge");
    uint32_t badgeHover = dark ? mixRgb(0xFFFFFF, t_.badge, 0.15f) : 0xFFFFFF;
    p.roundedRect(badge, 8, hovered("zoom:badge") ? badgeHover : t_.badge, 0.9f, t_.panelBorder, 0.8f);
    p.text(badge, z, UiFont{ 11 }, t_.badgeText, Align::Center, false);
    rx = badge.left - 6 * s;
  }

  // The tabs, 100 to 220 DIP each, then + and the web preview button.
  float tabsRight = rx - 2 * (kBtnDip + 2) * s - 6 * s;
  size_t n = m_.tabs.size();
  float tw = n ? std::clamp((tabsRight - x) / (float)n - 2 * s, kTabMinDip * s, kTabMaxDip * s) : 0;
  for (const TabModel& t : m_.tabs) {
    if (x + tw > tabsRight + 1) break;   // no room: the rest stay off the strip (Phase 2 scrolls)
    D2D1_RECT_F r = D2D1::RectF(std::round(x), tabTop, std::round(x + tw), H);
    std::string id = "tab:" + t.id;
    hit(true, r, id);
    D2D1_RECT_F close = D2D1::RectF(r.right - 22 * s, (r.top + r.bottom) / 2 - 8 * s, r.right - 6 * s, (r.top + r.bottom) / 2 + 8 * s);
    bool hover = hovered(id) || hovered(id + ":close") || hovered(id + ":rename");
    if (!t.renaming) hit(true, close, id + ":close");
    if (dark) {
      // The dark face runs to the strip's bottom, where a 1 DIP body-coloured
      // seam joins the active tab to the light body: a hard edge, no border.
      p.win7Tab(r, t.active, hover, t_.tabActive, t_.tabInactive, t_.tabActive, kDarkSheen, kDarkTabEdge);
      if (t.active && p.live()) p.fillRect(D2D1::RectF(r.left + one, r.bottom - one, r.right - one, r.bottom), t_.body);
    } else {
      p.win7Tab(r, t.active, hover, t_.tabActive, t_.tabInactive, t_.body);
    }
    if (t.active && p.live()) {
      // --tabOnMark, the accent line, along the top inside the radii.
      p.fillRect(D2D1::RectF(r.left + 6 * s, r.top + std::round(d), r.right - 6 * s, r.top + std::round(d) + std::round(2 * d)), t_.accent);
    }
    if (t.renaming) {
      D2D1_RECT_F er = D2D1::RectF(r.left + 6 * s, r.top + 5 * s, r.right - 6 * s, r.bottom - 4 * s);
      hit(true, er, id + ":rename");
      // The rename box keeps its white Win7 face, so its text stays dark on the dark strip.
      rename_.draw(p, er, UiFont{ 12 }, dark ? t_.toastText : t_.tabText, false, caretOn_);
    } else {
      bool showClose = hover;
      D2D1_RECT_F label = D2D1::RectF(r.left + 10 * s, r.top + 1 * s, (showClose ? close.left : r.right - 8 * s) - 2 * s, r.bottom);
      p.text(label, fromUtf8(t.name), UiFont{ 12, t.active }, t_.tabText, Align::Left, true);
      if (showClose) {
        bool hc = hovered(id + ":close");
        if (hc) p.roundedRect(close, 3, 0xC75050, 1, 0x8C2C2C, 1);   // the Win7 close red
        p.glyph(close, 0x2715, hc ? 0xFFFFFF : t_.tabText, 9);
      }
    }
    x = r.right + 2 * s;
  }
  D2D1_RECT_F plus = D2D1::RectF(x + 2 * s, btnTop, x + 2 * s + kBtnDip * s, btnBottom);
  hit(true, plus, "tab:new");
  glassButton(p, plus, hovered("tab:new"), pressed("tab:new"), dark);
  stripGlyph(p, glow, plus, '+', ink, 16);
  D2D1_RECT_F web = D2D1::RectF(plus.right + 2 * s, btnTop, plus.right + 2 * s + kBtnDip * s, btnBottom);
  hit(true, web, "web:new");
  glassButton(p, web, hovered("web:new") && !m_.tabFull, pressed("web:new") && !m_.tabFull, dark);
  stripGlyph(p, glow, web, 0x25CD, ink, 13, m_.tabFull ? 0.35f : 1.f);
}
