#include "ui/popup.h"
#include <algorithm>
#include <cmath>

namespace {
const float kItemDip = 22, kSepDip = 7, kPadDip = 3, kGutterDip = 28, kTextDip = 33, kRightDip = 24, kMinWidthDip = 180;
const uint32_t kFace = 0xF0F0F0, kBorder = 0x979797, kHi = 0xDCEBFC, kHiBorder = 0x7DA2CE, kSep = 0xE0E0E0;
const uint32_t kText = 0x1E1E1E, kGray = 0x6D6D6D;   // Win7 menu text and GrayText

nlohmann::json modsJson(Mods m) { return { { "ctrl", m.ctrl }, { "alt", m.alt }, { "shift", m.shift } }; }
}  // namespace

void Popup::set(const std::string& prefix, const std::vector<PopupItem>& items, float xDip, float yDip) {
  bool same = prefix == prefix_ && items == items_ && xDip == xDip_ && yDip == yDip_;
  prefix_ = prefix;
  items_ = items;
  xDip_ = xDip;
  yDip_ = yDip;
  if (!same) kb_ = -1;
}

void Popup::close() {
  prefix_.clear();
  items_.clear();
  kb_ = -1;
  // swallowChar_ stays: the model that closes the menu after Escape can land
  // before that key's WM_CHAR does.
}

bool Popup::owns(const std::string& target) const {
  if (prefix_.empty()) return false;
  return target == base() || target.rfind(prefix_, 0) == 0;
}

bool Popup::enabled(const std::string& target) const {
  if (prefix_.empty() || target.rfind(prefix_, 0) != 0) return false;
  std::string id = target.substr(prefix_.size());
  for (const PopupItem& it : items_)
    if (!it.separator && it.id == id) return it.enabled;
  return false;
}

void Popup::draw(Painter& p, D2D1_RECT_F body, float bodyTop, const std::string& hoverTarget) {
  if (prefix_.empty() || items_.empty()) return;
  float s = p.scale(), d = p.dpiScale();
  float one = std::max(1.f, std::round(d));
  UiFont f{ 12 };
  float labelW = 0;
  for (const PopupItem& it : items_)
    if (!it.separator) labelW = std::max(labelW, p.textWidth(it.label, f));
  float w = std::ceil(std::max(kMinWidthDip * s, kTextDip * s + labelW + kRightDip * s));
  float h = 2 * kPadDip * s;
  for (const PopupItem& it : items_) h += (it.separator ? kSepDip : kItemDip) * s;
  h = std::ceil(h);
  float x = std::round(xDip_ * d), y = std::round(yDip_ * d - bodyTop);
  x = std::max(body.left, std::min(x, body.right - w));
  y = std::max(body.top, std::min(y, body.bottom - h));
  D2D1_RECT_F r = D2D1::RectF(x, y, x + w, y + h);
  if (hit) hit(r, base());
  // The 2 px drop shadow, then the face and its border.
  p.fillRect(D2D1::RectF(r.left + 2 * one, r.top + 2 * one, r.right + 2 * one, r.bottom + 2 * one), 0x000000, 0.12f);
  p.fillRect(D2D1::RectF(r.left + one, r.top + one, r.right + one, r.bottom + one), 0x000000, 0.14f);
  p.fillRect(r, kFace);
  p.strokeRect(r, kBorder);
  // The icon gutter's edge, as Win7 menus draw it.
  float gx = std::round(r.left + kPadDip * s + kGutterDip * s);
  p.fillRect(D2D1::RectF(gx, r.top + one, gx + one, r.bottom - one), kSep);
  p.fillRect(D2D1::RectF(gx + one, r.top + one, gx + 2 * one, r.bottom - one), 0xFFFFFF);
  float iy = r.top + kPadDip * s;
  for (size_t i = 0; i < items_.size(); i++) {
    const PopupItem& it = items_[i];
    float ih = (it.separator ? kSepDip : kItemDip) * s;
    D2D1_RECT_F ir = D2D1::RectF(r.left + kPadDip * s, std::round(iy), r.right - kPadDip * s, std::round(iy + ih));
    iy += ih;
    if (it.separator) {
      float sy = std::round((ir.top + ir.bottom) / 2 - one);
      p.fillRect(D2D1::RectF(gx + 2 * one + 3 * s, sy, ir.right, sy + one), kSep);
      p.fillRect(D2D1::RectF(gx + 2 * one + 3 * s, sy + one, ir.right, sy + 2 * one), 0xFFFFFF);
      continue;
    }
    std::string target = prefix_ + it.id;
    if (hit) hit(ir, target);
    bool hot = it.enabled && (hoverTarget == target || (hoverTarget.rfind(prefix_, 0) != 0 && kb_ == (int)i));
    if (hot) p.roundedRect(ir, 3, kHi, 1, kHiBorder, 1);
    p.text(D2D1::RectF(r.left + kTextDip * s, ir.top, ir.right - 4 * s, ir.bottom), it.label, f, it.enabled ? kText : kGray, Align::Left, true);
  }
}

void Popup::step(int dir) {
  int n = (int)items_.size();
  if (n == 0) return;
  int i = kb_;
  for (int k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (!items_[(size_t)i].separator && items_[(size_t)i].enabled) { kb_ = i; return; }
  }
}

bool Popup::key(UINT msg, WPARAM w, Mods m) {
  if (msg == WM_CHAR) {
    if (!swallowChar_) return false;
    swallowChar_ = false;
    return true;
  }
  if (prefix_.empty()) return false;
  bool ours = w == VK_UP || w == VK_DOWN || w == VK_RETURN || w == VK_ESCAPE;
  if (msg == WM_KEYUP) return ours;
  if (msg != WM_KEYDOWN || !ours) return false;
  swallowChar_ = w == VK_RETURN || w == VK_ESCAPE;   // their WM_CHAR would reach the grid as \r or ESC
  if (w == VK_DOWN) step(1);
  else if (w == VK_UP) step(-1);
  else if (w == VK_ESCAPE) {
    if (emit) emit({ { "type", "key" }, { "target", base() }, { "key", "Escape" }, { "mods", modsJson(m) } });
  } else if (kb_ >= 0 && (size_t)kb_ < items_.size() && items_[(size_t)kb_].enabled) {
    if (emit) emit({ { "type", "click" }, { "target", prefix_ + items_[(size_t)kb_].id }, { "x", xDip_ }, { "y", yDip_ }, { "button", 0 },
                     { "mods", modsJson(m) } });
  }
  return true;
}
