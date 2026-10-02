// The status bar along the bottom (the model's statusH): the pane count, the
// memory figures and the swap line on the left, the shortcut hint on the right,
// in 6.3's Win7 status bar face.
#include "ui/ui.h"
#include "paths.h"
#include "window.h"
#include <cmath>

namespace {
const uint32_t kWarn = 0xA86400;   // styles.css --warn #e5a83c, darkened to read on the light bar
}

void Ui::viewStatus(Painter& p) {
  Window& win = Window::instance();
  if (!win.body() || m_.window.statusH <= 0) return;
  RECT rc{};
  GetClientRect(win.body(), &rc);
  float s = p.scale(), d = dpi();
  float h = std::round((float)m_.window.statusH * d);
  D2D1_RECT_F bar = D2D1::RectF(0, (float)rc.bottom - h, (float)rc.right, (float)rc.bottom);
  if (bar.top < 0) return;
  hit(false, bar, "status");
  if (!p.live()) return;
  auto c = [](uint32_t v) { return D2D1::ColorF(((v >> 16) & 0xFF) / 255.f, ((v >> 8) & 0xFF) / 255.f, (v & 0xFF) / 255.f, 1.f); };
  D2D1_GRADIENT_STOP stops[] = { { 0.f, c(mixRgb(0xFFFFFF, t_.statusBg, 0.45f)) }, { 1.f, c(t_.statusBg) } };
  p.gradientV(bar, stops, 2);
  p.fillRect(D2D1::RectF(bar.left, bar.top, bar.right, bar.top + std::max(1.f, std::round(d))), 0xA0A0A0);
  UiFont f{ 12 };
  float x = bar.left + 10 * s;
  std::wstring hint = fromUtf8(m_.status.hint);
  float hw = p.textWidth(hint, f);
  float right = bar.right - 10 * s - hw - 16 * s;
  auto part = [&](const std::string& text, uint32_t color) {
    if (text.empty() || x >= right) return;
    std::wstring w = fromUtf8(text);
    float tw = p.textWidth(w, f);
    p.text(D2D1::RectF(x, bar.top, std::min(right, x + tw + 2), bar.bottom), w, f, color, Align::Left, true);
    x += tw + 8 * s;
    if (x < right) p.fillRect(D2D1::RectF(x, bar.top + 6 * s, x + std::round(d), bar.bottom - 6 * s), 0xC0C0C0);
    x += 9 * s;
  };
  part(m_.status.panes, t_.statusText);
  part(m_.status.inPanes, t_.statusText);
  uint32_t used = m_.status.usedLevel == "crit" ? t_.danger : m_.status.usedLevel == "warn" ? kWarn : t_.statusText;
  part(m_.status.used, used);
  if (m_.status.compressed) part(*m_.status.compressed, t_.statusText);
  if (m_.status.swap) part(*m_.status.swap, m_.status.swapWarn ? kWarn : t_.statusText);
  p.text(D2D1::RectF(bar.right - 10 * s - hw - 2, bar.top, bar.right - 10 * s, bar.bottom), hint, f, mixRgb(t_.statusText, 0xFFFFFF, 0.7f),
         Align::Right, false);
}
