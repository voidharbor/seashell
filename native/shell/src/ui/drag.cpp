// Dragging tabs along the strip and panes onto each other. The shell tracks
// the pointer and paints the feedback; the core moves the model. A tab takes
// each slot it crosses into, one `tab:<id>:move:<index>` click per slot, so
// the strip reorders under the pointer while the tab rides along with it. A
// pane dragged by its title shows where it would land over the pane under
// the pointer (the middle swaps the two, an edge docks it on that side) and
// sends one `pane:<id>:moveTo:<targetId>:<where>` on the release. Escape puts
// a tab back and drops no pane.
#include "ui/ui.h"
#include "window.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace {
bool startsWith(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }
bool endsWith(const std::string& s, const char* p) {
  size_t n = strlen(p);
  return s.size() >= n && s.compare(s.size() - n, n, p) == 0;
}
}  // namespace

void Ui::armMove(const std::string& target, POINT pt) {
  move_ = MoveDrag{};
  if (coreDead_) return;
  if (startsWith(target, "tab:") && target != "tab:new" && std::count(target.begin(), target.end(), ':') == 1) {
    if (m_.tabs.size() < 2 || stripPitch_ <= 0) return;   // nowhere to go
    move_.id = target.substr(4);
    for (size_t i = 0; i < m_.tabs.size(); i++)
      if (m_.tabs[i].id == move_.id) move_.origIndex = move_.sentIndex = (int)i;
    if (move_.origIndex < 0) { move_ = MoveDrag{}; return; }
    move_.kind = MoveDrag::Tab;
    move_.grab = (float)pt.x - (stripTabX0_ + (float)move_.origIndex * stripPitch_);
  } else if (startsWith(target, "pane:") && endsWith(target, ":title")) {
    int shown = 0;
    for (const PaneModel& p : m_.panes)
      if (paneVisible(p)) shown++;
    if (shown < 2) return;   // a lone or zoomed pane has nothing to land on
    move_.kind = MoveDrag::Pane;
    move_.id = target.substr(5, target.size() - 5 - strlen(":title"));
  } else {
    return;
  }
  move_.start = pt;
  move_.x = (float)pt.x;
  move_.y = (float)pt.y;
}

bool Ui::moveMouse(UINT msg, POINT pt) {
  if (move_.kind == MoveDrag::None) return false;
  Window& win = Window::instance();
  if (msg == WM_MOUSEMOVE) {
    if (pressed_.empty()) { move_ = MoveDrag{}; return false; }   // the press ended without us
    if (!move_.live) {
      if (std::abs(pt.x - move_.start.x) < GetSystemMetrics(SM_CXDRAG) && std::abs(pt.y - move_.start.y) < GetSystemMetrics(SM_CYDRAG))
        return false;
      move_.live = true;
      tip_.clear();
      tipShown_ = false;
      SetCapture(move_.kind == MoveDrag::Tab ? win.hwnd() : win.body());
    }
    move_.x = (float)pt.x;
    move_.y = (float)pt.y;
    if (move_.kind == MoveDrag::Tab) {
      // The slot whose span holds the dragged tab's centre.
      int n = (int)m_.tabs.size();
      float left = move_.x - move_.grab;
      int idx = (int)std::floor((left + stripTabW_ / 2 - stripTabX0_) / stripPitch_);
      idx = std::clamp(idx, 0, std::max(0, n - 1));
      if (idx != move_.sentIndex) {
        move_.sentIndex = idx;
        send("click", "tab:" + move_.id + ":move:" + std::to_string(idx), move_.x / dpi(), move_.y / dpi(), 0, Mods{});
      }
      win.invalidateStrip();
    } else {
      D2D1_RECT_F zone{};
      move_.dropPane.clear();
      move_.dropWhere.clear();
      dropZone(POINT{ pt.x, pt.y - (LONG)bodyTop() }, &move_.dropPane, &move_.dropWhere, &zone);
      SetCursor(LoadCursorW(nullptr, IDC_SIZEALL));
      win.invalidateBody();
    }
    return true;
  }
  if (msg == WM_LBUTTONUP) {
    if (!move_.live) {   // a click after all: the normal release runs
      move_ = MoveDrag{};
      return false;
    }
    endMove(true, false);
    pressed_.clear();
    pressedButton_ = 0;
    return true;
  }
  return move_.live;   // a live drag keeps the other buttons
}

void Ui::endMove(bool drop, bool revert) {
  MoveDrag m = std::move(move_);
  move_ = MoveDrag{};   // first: the release below sends WM_CAPTURECHANGED, whose cancelDrag finds nothing
  if (!m.live) return;
  float xd = m.x / dpi(), yd = m.y / dpi();
  if (drop && m.kind == MoveDrag::Pane && !m.dropPane.empty())
    send("click", "pane:" + m.id + ":moveTo:" + m.dropPane + ":" + m.dropWhere, xd, yd, 0, Mods{});
  if (revert && m.kind == MoveDrag::Tab && m.sentIndex != m.origIndex)
    send("click", "tab:" + m.id + ":move:" + std::to_string(m.origIndex), xd, yd, 0, Mods{});
  Window& win = Window::instance();
  HWND cap = GetCapture();
  if (cap && (cap == win.hwnd() || cap == win.body())) ReleaseCapture();
  win.invalidateStrip();
  win.invalidateBody();
}

bool Ui::moveKey(UINT msg, WPARAM w) {
  if (!move_.live || msg != WM_KEYDOWN || w != VK_ESCAPE) return false;
  endMove(false, true);
  pressed_.clear();
  pressedButton_ = 0;
  return true;
}

bool Ui::movingTab(const std::string& id) const {
  return move_.live && move_.kind == MoveDrag::Tab && move_.id == id;
}

// Under the pointer, kept inside the tab row.
float Ui::movingTabLeft(float viewL, float viewR) const {
  return std::clamp(move_.x - move_.grab, viewL, std::max(viewL, viewR - stripTabW_));
}

// The pane under a body point and where on it a drop would land: the middle
// half both ways swaps, the rest docks against the nearest edge. False over
// the dragged pane itself or no pane.
bool Ui::dropZone(POINT bp, std::string* pane, std::string* where, D2D1_RECT_F* zone) const {
  for (const PaneModel& pm : m_.panes) {
    if (!paneVisible(pm)) continue;
    D2D1_RECT_F r = dev(pm.rect);
    if ((float)bp.x < r.left || (float)bp.x >= r.right || (float)bp.y < r.top || (float)bp.y >= r.bottom) continue;
    float w = r.right - r.left, h = r.bottom - r.top;
    if (pm.id == move_.id || w <= 0 || h <= 0) return false;
    float fx = ((float)bp.x - r.left) / w, fy = ((float)bp.y - r.top) / h;
    float mx = std::round((r.left + r.right) / 2), my = std::round((r.top + r.bottom) / 2);
    if (fx > 0.25f && fx < 0.75f && fy > 0.25f && fy < 0.75f) {
      *where = "swap";
      *zone = r;
    } else {
      float nearest = std::min({ fx, 1 - fx, fy, 1 - fy });
      if (nearest == fx) { *where = "left"; *zone = D2D1::RectF(r.left, r.top, mx, r.bottom); }
      else if (nearest == 1 - fx) { *where = "right"; *zone = D2D1::RectF(mx, r.top, r.right, r.bottom); }
      else if (nearest == fy) { *where = "top"; *zone = D2D1::RectF(r.left, r.top, r.right, my); }
      else { *where = "bottom"; *zone = D2D1::RectF(r.left, my, r.right, r.bottom); }
    }
    *pane = pm.id;
    return true;
  }
  return false;
}

void Ui::viewPaneDrop(Painter& p) {
  if (!p.live() || !move_.live || move_.kind != MoveDrag::Pane) return;
  float s = p.scale();
  // The pane being moved, washed out: a mid grey reads on light and dark faces alike.
  for (const PaneModel& pm : m_.panes)
    if (pm.id == move_.id && paneVisible(pm)) p.fillRect(dev(pm.rect), 0x808080, 0.25f);
  std::string pane, where;
  D2D1_RECT_F zone{};
  if (!dropZone(POINT{ (LONG)move_.x, (LONG)(move_.y - bodyTop()) }, &pane, &where, &zone)) return;
  D2D1_RECT_F z = D2D1::RectF(zone.left + 4 * s, zone.top + 4 * s, zone.right - 4 * s, zone.bottom - 4 * s);
  if (z.right <= z.left || z.bottom <= z.top) return;
  p.roundedRect(z, t_.radius, t_.accent, 0.3f, t_.accent, 1.f);
  p.roundedRect(D2D1::RectF(z.left + p.px(1), z.top + p.px(1), z.right - p.px(1), z.bottom - p.px(1)), std::max(0.f, t_.radius - 1), 0, 0, t_.accent, 1.f);   // a 2 DIP edge
}
