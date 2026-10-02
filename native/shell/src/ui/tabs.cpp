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

// A glyph button on glass: a frosted face under the pointer.
void glassButton(Painter& p, D2D1_RECT_F r, bool hover, bool down) {
  if (!hover && !down) return;
  p.roundedRect(r, 3, 0xFFFFFF, down ? 0.55f : 0.35f, 0xFFFFFF, 0.7f);
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

  // The menu button (Phase 2 opens the menu; Phase 1 toasts).
  float x = 6 * s;
  D2D1_RECT_F menu = D2D1::RectF(x, btnTop, x + kBtnDip * s, btnBottom);
  hit(true, menu, "menu");
  glassButton(p, menu, hovered("menu"), pressed("menu"));
  p.glyph(menu, 0x2261, ink, 14);
  x = menu.right + 6 * s;

  // Right to left from the caption buttons: settings, sleep, the zoom badge.
  float rx = W - kCaptionDip * d - 6 * s;
  D2D1_RECT_F gear = D2D1::RectF(rx - kBtnDip * s, btnTop, rx, btnBottom);
  hit(true, gear, "settings");
  glassButton(p, gear, hovered("settings"), pressed("settings"));
  p.glyph(gear, 0x2699, ink, 13);
  rx = gear.left - 2 * s;
  D2D1_RECT_F moon = D2D1::RectF(rx - kBtnDip * s, btnTop, rx, btnBottom);
  hit(true, moon, "sleep");
  glassButton(p, moon, hovered("sleep"), pressed("sleep"));
  p.glyph(moon, m_.sleep ? 0x263E : 0x263D, ink, 13);
  rx = moon.left - 4 * s;
  if (m_.zoomBadge) {
    std::wstring z = fromUtf8(*m_.zoomBadge);
    float zw = p.textWidth(z, UiFont{ 11 }) + 14 * s;
    D2D1_RECT_F badge = D2D1::RectF(rx - zw, btnTop + 4 * s, rx, btnBottom - 4 * s);
    hit(true, badge, "zoom:badge");
    p.roundedRect(badge, 8, hovered("zoom:badge") ? 0xFFFFFF : t_.badge, 0.9f, t_.panelBorder, 0.8f);
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
    p.win7Tab(r, t.active, hover, t_.tabActive, t_.tabInactive, t_.body);
    if (t.active && p.live()) {
      // --tabOnMark, the accent line, along the top inside the radii.
      p.fillRect(D2D1::RectF(r.left + 6 * s, r.top + std::round(d), r.right - 6 * s, r.top + std::round(d) + std::round(2 * d)), t_.accent);
    }
    if (t.renaming) {
      D2D1_RECT_F er = D2D1::RectF(r.left + 6 * s, r.top + 5 * s, r.right - 6 * s, r.bottom - 4 * s);
      hit(true, er, id + ":rename");
      rename_.draw(p, er, UiFont{ 12 }, t_.tabText, false, caretOn_);
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
  glassButton(p, plus, hovered("tab:new"), pressed("tab:new"));
  p.glyph(plus, '+', ink, 16);
  D2D1_RECT_F web = D2D1::RectF(plus.right + 2 * s, btnTop, plus.right + 2 * s + kBtnDip * s, btnBottom);
  hit(true, web, "web:new");
  glassButton(p, web, hovered("web:new") && !m_.tabFull, pressed("web:new") && !m_.tabFull);
  p.glyph(web, 0x25CD, ink, 13, m_.tabFull ? 0.35f : 1.f);
}
