// The tab strip: the menu button, the tabs, new tab, new web preview, the zoom
// badge, sleep and settings. The DWM caption buttons own the right 138 DIP;
// nothing is drawn there, except on the flat frame (Graphite), where the
// shell draws its own three there. Everything not under a control is
// strip:empty, which drags the window. A tab being dragged (drag.cpp) is
// drawn under the pointer, its slot in the row left empty.
//
// Overflow (Phase 2 Task 16): when the tabs at their 100 DIP minimum do not
// fit, the tab row scrolls (stripScroll_, the shell's own view state) between
// `◂` (strip:left) and `▸` (strip:right), which step a tab at a time and
// repeat on hold; the wheel over the strip scrolls it, and a model whose
// active tab changed scrolls that tab into view. The menu button, +, the web
// button, the badge, sleep and settings stay where they are.
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
const float kArrowDip = 18;      // the overflow arrows
const UINT kRepeatDelayMs = 350; // app-scrollbar.ts REPEAT_DELAY_MS
const UINT kRepeatEveryMs = 90;  // app-scrollbar.ts REPEAT_EVERY_MS
// The dark strip (Task 12b): the inactive tabs' highlight and the tab edge are
// the tabSheen and tabEdge tokens. The zoom badge on the dark strip is the
// sheen with stripBadgeText on it; the badge and badgeText tokens belong to
// the pane titles, sheets and sidebar below the strip, light under Aero.
const float kDarkTopSheen = 0.4f;   // the dark inactive face's top keeps its 40 percent sheen

// A glyph button on glass: a frosted face under the pointer, fainter on the
// dark strip so its light glyph still reads.
void glassButton(Painter& p, D2D1_RECT_F r, bool hover, bool down, bool dark) {
  if (!hover && !down) return;
  if (dark) p.roundedRect(r, 3, 0xFFFFFF, down ? 0.24f : 0.14f, 0xFFFFFF, 0.3f);
  else p.roundedRect(r, 3, 0xFFFFFF, down ? 0.55f : 0.35f, 0xFFFFFF, 0.7f);
}

// A chrome glyph in frameText. On glass it sits on the Win7 caption glow, as
// the caption text does, so it reads over any wallpaper; glow is the tokens'
// glyphGlow (0.65: the old full-white glow was too bright behind every glyph). The opaque
// strip needs none, and neither does a dark strip, whose dark wash carries its
// light glyphs (a white glow would wash them out): viewTabs passes 0 for both.
void stripGlyph(Painter& p, float glow, D2D1_RECT_F r, uint32_t cp, uint32_t ink, float dip, float alpha = 1) {
  if (glow > 0 && p.live()) {
    float cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2, h = p.px(dip) * 0.5f;
    p.glow(D2D1::RectF(cx - h, cy - h, cx + h, cy + h), 4, glow * alpha);
  }
  p.glyph(r, cp, ink, dip, alpha);
}
}  // namespace

// The flat frame's minimize, maximize (restore while maximized) and close,
// 46 DIP each across the strip's full height in the DWM buttons' 138, with
// Windows 11's faces: a faint lift under the pointer, close red.
void Ui::viewCaption(Painter& p, float W, float H) {
  float d = dpi();
  float bw = std::round(kCaptionDip / 3 * d);
  float one = std::max(1.f, std::round(d));
  bool zoomed = IsZoomed(Window::instance().hwnd()) != FALSE;
  const char* ids[3] = { "caption:min", "caption:max", "caption:close" };
  for (int i = 0; i < 3; i++) {
    D2D1_RECT_F b = D2D1::RectF(W - (float)(3 - i) * bw, 0, W - (float)(2 - i) * bw, H);
    hit(true, b, ids[i]);
    if (!p.live()) continue;
    bool hot = hovered(ids[i]), down = pressed(ids[i]);
    bool red = i == 2 && (hot || down);
    if (red) p.fillRect(b, 0xC42B1C, down ? 0.8f : 1.f);
    else if (hot || down) p.fillRect(b, 0xFFFFFF, down ? 0.06f : 0.1f);
    uint32_t ink = red ? 0xFFFFFF : t_.frameText;
    // The glyphs on whole pixels: a 10 DIP box at the button's centre.
    float g = std::round(5 * d);
    float cx = std::round((b.left + b.right) / 2), cy = std::round((b.top + b.bottom) / 2);
    if (i == 0) {
      p.fillRect(D2D1::RectF(cx - g, cy, cx + g, cy + one), ink);
    } else if (i == 1 && !zoomed) {
      p.strokeRect(D2D1::RectF(cx - g, cy - g, cx + g, cy + g), ink);
    } else if (i == 1) {
      float o = std::round(2 * d);   // the back window, up and to the right
      p.fillRect(D2D1::RectF(cx - g + o, cy - g, cx + g, cy - g + one), ink);
      p.fillRect(D2D1::RectF(cx + g - one, cy - g, cx + g, cy + g - o), ink);
      p.strokeRect(D2D1::RectF(cx - g, cy - g + o, cx + g - o, cy + g), ink);
    } else if (p.rt()) {
      ID2D1SolidColorBrush* br = nullptr;
      p.rt()->CreateSolidColorBrush(D2D1::ColorF(((ink >> 16) & 0xFF) / 255.f, ((ink >> 8) & 0xFF) / 255.f, (ink & 0xFF) / 255.f, 1.f), &br);
      if (br) {
        p.rt()->DrawLine(D2D1::Point2F(cx - g, cy - g), D2D1::Point2F(cx + g, cy + g), br, one);
        p.rt()->DrawLine(D2D1::Point2F(cx + g, cy - g), D2D1::Point2F(cx - g, cy + g), br, one);
        br->Release();
      }
    }
  }
}

void Ui::viewTabs(Painter& p) {
  Window& win = Window::instance();
  RECT rc{};
  if (win.hwnd()) GetClientRect(win.hwnd(), &rc);
  float W = (float)rc.right, H = (float)win.stripHeightPx();
  float s = p.scale(), d = dpi();
  hit(true, D2D1::RectF(0, 0, W, H), "strip:empty");
  bool flat = flatFrame();
  if (flat) viewCaption(p, W, H);
  float tabTop = std::max(2.f * d, H - kTabHDip * s);
  float btnTop = tabTop + 2 * s, btnBottom = H - 3 * s;
  uint32_t ink = t_.frameText;
  bool dark = stripDark();
  bool glass = onGlass();
  float glow = glass && !dark ? t_.glyphGlow : 0.f;
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
    uint32_t badgeFill = dark ? t_.tabSheen : t_.badge;
    uint32_t badgeHover = dark ? mixRgb(0xFFFFFF, badgeFill, 0.15f) : 0xFFFFFF;
    p.roundedRect(badge, 8, hovered("zoom:badge") ? badgeHover : badgeFill, 0.9f, t_.panelBorder, 0.8f);
    p.text(badge, z, UiFont{ 11 }, dark ? t_.stripBadgeText : t_.badgeText, Align::Center, false);
    rx = badge.left - 6 * s;
  }

  // The tabs, 100 to 220 DIP each, then + and the web preview button.
  float tabsRight = rx - 2 * (kBtnDip + 2) * s - 6 * s;
  size_t n = m_.tabs.size();
  float gap = 2 * s;
  float tw = n ? std::clamp((tabsRight - x) / (float)n - gap, kTabMinDip * s, kTabMaxDip * s) : 0;
  float pitch = tw + gap;
  // Overflow: the last tab's right edge would pass the tab area's.
  bool over = n && (float)n * pitch - gap > tabsRight - x + 1;
  float viewL = x, viewR = tabsRight;
  if (over) {
    D2D1_RECT_F left = D2D1::RectF(x, btnTop, x + kArrowDip * s, btnBottom);
    D2D1_RECT_F right = D2D1::RectF(tabsRight - kArrowDip * s, btnTop, tabsRight, btnBottom);
    viewL = left.right + gap;
    viewR = right.left - gap;
    float viewW = std::max(0.f, viewR - viewL);
    stripPitch_ = pitch;
    stripMax_ = std::max(0.f, (float)n * pitch - gap - viewW);
    if (registering_) {
      // A resize, zoom or DPI change that starts the overflow or moves the
      // row's geometry reveals the active tab too, not only a model change.
      if (!stripWasOver_ || std::abs(pitch - stripLastPitch_) > 0.01f || std::abs(viewW - stripLastViewW_) > 0.01f)
        stripReveal_ = true;
      stripWasOver_ = true;
      stripLastPitch_ = pitch;
      stripLastViewW_ = viewW;
    }
    if (registering_ && stripReveal_) {
      for (size_t i = 0; i < n; i++) {
        if (!m_.tabs[i].active) continue;
        float l = (float)i * pitch, r = l + tw;
        if (l < stripScroll_) stripScroll_ = l;
        else if (r > stripScroll_ + viewW) stripScroll_ = r - viewW;
      }
      stripReveal_ = false;
    }
    stripScroll_ = std::clamp(stripScroll_, 0.f, stripMax_);
    bool canLeft = stripScroll_ > 0.5f, canRight = stripScroll_ < stripMax_ - 0.5f;
    hit(true, left, "strip:left");
    hit(true, right, "strip:right");
    glassButton(p, left, hovered("strip:left") && canLeft, pressed("strip:left") && canLeft, dark);
    glassButton(p, right, hovered("strip:right") && canRight, pressed("strip:right") && canRight, dark);
    stripGlyph(p, glow, left, 0x25C2, ink, 12, canLeft ? 1.f : 0.35f);
    stripGlyph(p, glow, right, 0x25B8, ink, 12, canRight ? 1.f : 0.35f);
    x = viewL - stripScroll_;
    p.pushClip(D2D1::RectF(viewL, 0, viewR, H));
  } else {
    stripScroll_ = stripMax_ = 0;
    stripPitch_ = pitch;
    stripReveal_ = false;
    if (registering_) stripWasOver_ = false;
  }
  // A tab scrolled partly out of the row hits only where it shows.
  auto shown = [&](D2D1_RECT_F r) {
    if (over) { r.left = std::max(r.left, viewL); r.right = std::min(r.right, viewR); }
    return r;
  };
  auto closeRect = [&](D2D1_RECT_F r) {
    return D2D1::RectF(r.right - 22 * s, (r.top + r.bottom) / 2 - 8 * s, r.right - 6 * s, (r.top + r.bottom) / 2 + 8 * s);
  };
  stripTabX0_ = x;   // tab 0's left edge, the scroll in: the drag's slots (drag.cpp)
  stripTabW_ = tw;
  // One tab's face, mark, label and close button at r.
  auto drawTab = [&](const TabModel& t, D2D1_RECT_F r, bool hover) {
    std::string id = "tab:" + t.id;
    D2D1_RECT_F close = closeRect(r);
    if (flat) {
      // Graphite: every tab is a hairline outline with its top corners round
      // (the bottom edge runs off under the clip). The active tab's face is
      // the lighter tabActive, joining the pane title below it; the others
      // carry a faint sheen so each still reads as a tab, more under the pointer.
      if (p.live()) {
        p.pushClip(r);
        D2D1_RECT_F face = D2D1::RectF(r.left, r.top, r.right, r.bottom + 8 * s);
        uint32_t line = mixRgb(t_.tabText, t_.frame, t.active ? 0.3f : 0.2f);
        if (t.active) p.roundedRect(face, 6, t_.tabActive, 1, line, 1);
        else p.roundedRect(face, 6, t_.tabSheen, hover ? 0.6f : 0.25f, line, 1);
        p.popClip();
      }
    } else if (dark) {
      // The dark face runs to the strip's bottom, where a 1 DIP body-coloured
      // seam joins the active tab to the body: a hard edge, no border.
      p.win7Tab(r, t.active, hover, t_.tabActive, t_.tabInactive, t_.tabActive, t_.tabSheen, t_.tabEdge, kDarkTopSheen);
      if (t.active && p.live()) p.fillRect(D2D1::RectF(r.left + one, r.bottom - one, r.right - one, r.bottom), t_.body);
    } else {
      p.win7Tab(r, t.active, hover, t_.tabActive, t_.tabInactive, t_.body, t_.tabSheen, t_.tabEdge);
    }
    float labelLeft = r.left + 10 * s;
    if (flat && t.active && p.live()) {
      // The accent as a dot before the label.
      float cy = std::round((r.top + r.bottom) / 2), rr = 3 * s;
      p.roundedRect(D2D1::RectF(labelLeft, cy - rr, labelLeft + 2 * rr, cy + rr), 3, t_.accent, 1, 0, 0);
    }
    if (flat && t.active) labelLeft += 12 * s;
    if (!flat && t.active && p.live()) {
      // --tabOnMark, the accent line, along the top inside the radii.
      p.fillRect(D2D1::RectF(r.left + 6 * s, r.top + std::round(d), r.right - 6 * s, r.top + std::round(d) + std::round(2 * d)), t_.accent);
    }
    if (t.renaming) {
      D2D1_RECT_F er = D2D1::RectF(r.left + 6 * s, r.top + 5 * s, r.right - 6 * s, r.bottom - 4 * s);
      hit(true, shown(er), id + ":rename");
      // The rename box keeps the edit face (white under Aero), so on the dark strip its text is the card's.
      rename_.draw(p, er, UiFont{ 12 }, dark ? t_.toastText : t_.tabText, false, caretOn_);
    } else {
      bool showClose = hover && !movingTab(t.id);
      D2D1_RECT_F label = D2D1::RectF(labelLeft, r.top + 1 * s, (showClose ? close.left : r.right - 8 * s) - 2 * s, r.bottom);
      // The flat strip's inactive tabs read a step quieter than the active one.
      uint32_t ink = flat && !t.active ? mixRgb(t_.tabText, t_.frame, 0.68f) : t_.tabText;
      p.text(label, fromUtf8(t.name), UiFont{ 12, t.active }, ink, Align::Left, true);
      if (showClose) {
        bool hc = hovered(id + ":close");
        if (hc) p.roundedRect(close, 3, 0xC75050, 1, 0x8C2C2C, 1);   // the Win7 close red
        p.glyph(close, 0x2715, hc ? 0xFFFFFF : ink, 9);
      }
    }
  };
  const TabModel* moving = nullptr;
  for (const TabModel& t : m_.tabs) {
    D2D1_RECT_F r = D2D1::RectF(std::round(x), tabTop, std::round(x + tw), H);
    x = r.right + gap;
    if (movingTab(t.id)) moving = &t;   // drawn under the pointer, after the rest
    if (over && (r.right <= viewL || r.left >= viewR)) continue;   // scrolled out of the row
    std::string id = "tab:" + t.id;
    D2D1_RECT_F rh = shown(r);
    hit(true, rh, id);
    bool hover = hovered(id) || hovered(id + ":close") || hovered(id + ":rename");
    D2D1_RECT_F ch = shown(closeRect(r));
    if (!t.renaming && ch.right > ch.left) hit(true, ch, id + ":close");
    if (moving != &t) drawTab(t, r, hover);
  }
  if (moving) {
    float l = std::round(movingTabLeft(viewL, viewR));
    drawTab(*moving, D2D1::RectF(l, tabTop, l + std::round(tw), H), true);
  }
  if (over) {
    p.popClip();
    x = tabsRight + gap;   // + and the web button stay put after the right arrow
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

void Ui::stripStep(int dir) {
  if (stripMax_ <= 0 || stripPitch_ <= 0) return;
  float next = dir < 0 ? std::floor((stripScroll_ - 1) / stripPitch_) * stripPitch_
                       : (std::floor(stripScroll_ / stripPitch_) + 1) * stripPitch_;
  next = std::clamp(next, 0.f, stripMax_);
  if (next == stripScroll_) return;
  stripScroll_ = next;
  layout();
  Window::instance().invalidateStrip();
}

// One tab's pitch per notch, wheel up toward the first tab. Only an
// overflowing strip takes the wheel.
bool Ui::stripWheel(POINT pt, int delta) {
  if (pt.y < 0 || pt.y >= Window::instance().stripHeightPx() || stripMax_ <= 0) return false;
  float next = std::clamp(stripScroll_ - (float)delta / WHEEL_DELTA * stripPitch_, 0.f, stripMax_);
  if (next != stripScroll_) {
    stripScroll_ = next;
    layout();
    Window::instance().invalidateStrip();
  }
  return true;
}

void Ui::stripRepeat(bool start) {
  if (stripTimer_) { KillTimer(nullptr, stripTimer_); stripTimer_ = 0; }
  stripTimerFast_ = false;
  if (start) stripTimer_ = SetTimer(nullptr, 0, kRepeatDelayMs, stripRepeatTick);
}

// The held arrow steps again while the pointer stays on it.
void CALLBACK Ui::stripRepeatTick(HWND, UINT, UINT_PTR, DWORD) {
  Ui& u = instance();
  bool left = u.pressed_ == "strip:left", right = u.pressed_ == "strip:right";
  if ((!left && !right) || u.hover_ != u.pressed_) { u.stripRepeat(false); return; }
  if (!u.stripTimerFast_) {
    KillTimer(nullptr, u.stripTimer_);
    u.stripTimer_ = SetTimer(nullptr, 0, kRepeatEveryMs, stripRepeatTick);
    u.stripTimerFast_ = true;
  }
  u.stripStep(left ? -1 : 1);
}
