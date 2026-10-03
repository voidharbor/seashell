// The file explorer column (Explorer.tsx, drawn natively): the header with
// File Browser and refresh, the rows (twisty, folder or file glyph, name), the
// '… too many entries to list' line, the Win7 scrollbar when the rows
// overflow, the path strip along the bottom and the grip beside the column.
// The column and the grip come from the model; the rows' scroll offset is the
// shell's own view state (sbScroll_), as is the last reveal it centred. The
// context menu is a Popup over everything (viewMenu).
#include "ui/ui.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {
const float kHeadDip = 26;      // the header row
const float kStripDip = 22;     // styles.css .sidebar__path
const float kRowDip = 22;       // a row, at uiScale
const float kPadDip = 4;        // above the first row and below the last
const float kIndentDip = 14;    // per depth
const float kTwistyDip = 14;    // styles.css .node__twisty
const float kIconDip = 16;      // styles.css .node__icon
const float kWheelRows = 3;     // rows per wheel notch
const ULONGLONG kFlashFadeMs = 1400;   // styles.css revealFlash; the core clears the flag at 2.5 s
const uint32_t kFlash = 0x28FE14;      // the Homebrew green

bool hexRgb(const std::optional<std::string>& s, uint32_t* out) {
  if (!s || s->size() != 7 || (*s)[0] != '#') return false;
  char* end = nullptr;
  unsigned long v = strtoul(s->c_str() + 1, &end, 16);
  if (!end || *end != 0) return false;
  *out = (uint32_t)v;
  return true;
}

D2D1_RECT_F clipTo(D2D1_RECT_F r, D2D1_RECT_F c) {
  return D2D1::RectF(std::max(r.left, c.left), std::max(r.top, c.top), std::min(r.right, c.right), std::min(r.bottom, c.bottom));
}
}  // namespace

// Where everything in the column goes for the current model, the scroll
// state's content and viewport, and the offset clamped to them.
void Ui::sidebarGeometry() {
  SidebarGeom g;
  const SidebarModel& sm = m_.sidebar;
  if (haveModel_ && sm.visible) {
    float d = dpi(), ui = (float)(m_.window.uiScale > 0 ? m_.window.uiScale : 1), s = d * ui;
    float one = std::max(1.f, std::round(d));
    g.col = dev(sm.rect);
    if (g.col.right - g.col.left > one && g.col.bottom > g.col.top) {
      g.on = true;
      g.rowDip = kRowDip * ui;
      g.padDip = kPadDip * ui;
      float headH = std::round(kHeadDip * s), stripH = std::round(kStripDip * s);
      float right = g.col.right - one;   // the 1 px panelBorder edge
      g.head = D2D1::RectF(g.col.left, g.col.top, right, std::min(g.col.bottom, g.col.top + headH));
      g.strip = D2D1::RectF(g.col.left, std::max(g.head.bottom, g.col.bottom - stripH), right, g.col.bottom);
      g.tree = D2D1::RectF(g.col.left, g.head.bottom, right, g.strip.top);
      g.line.resize(sm.rows.size());
      int n = 0;
      for (size_t i = 0; i < sm.rows.size(); i++) {
        g.line[i] = n++;
        if (sm.rows[i].truncatedAfter) n++;
      }
      g.lines = n;
      sbScroll_.content = 2 * g.padDip + (float)n * g.rowDip;
      sbScroll_.viewport = std::max(0.f, (g.tree.bottom - g.tree.top) / d);
      sbScroll_.offset = ScrollBar::clampOffset(sbScroll_.offset, sbScroll_.content, sbScroll_.viewport);
      g.rowsRight = g.tree.right;
      if (ScrollBar::needed(sbScroll_)) {
        g.bar = D2D1::RectF(std::round(g.tree.right - ScrollBar::kWidthDip * d), g.tree.top, g.tree.right, g.tree.bottom);
        g.rowsRight = g.bar.left;
      }
      sbBar_.layout(g.bar, d);
    }
  }
  if (!g.on) {
    // The column went away under a thumb drag: the drag and its capture end.
    if (sbScroll_.dragging) {
      sbScroll_.dragging = false;
      if (GetCapture() == Window::instance().body()) ReleaseCapture();
    }
    sbBar_.layout(D2D1_RECT_F{}, 1);
  }
  sb_ = std::move(g);
}

float Ui::sidebarRowTop(size_t i) const {
  float d = dpi();
  return std::round(sb_.tree.top + (sb_.padDip + (float)sb_.line[i] * sb_.rowDip - sbScroll_.offset) * d);
}

// The model's explorer state that is the shell's to follow: a fresh column
// starts at the top, the menu becomes the popup, and each row's flash start
// is kept for its fade. A new revealSeq restarts its row's fade, as the core
// restarted its 2.5 s, even when the row was still flashing from the last.
void Ui::syncSidebar(const UiModel& old) {
  const SidebarModel& sm = m_.sidebar;
  if (sm.visible && !old.sidebar.visible) sbScroll_.offset = 0;
  ULONGLONG now = GetTickCount64();
  const std::string* again = sm.revealSeq != old.sidebar.revealSeq && sm.revealRowId ? &*sm.revealRowId : nullptr;
  std::map<std::string, ULONGLONG> flash;
  for (const SidebarRow& r : sm.rows) {
    if (!r.flashing) continue;
    auto it = flashSince_.find(r.path);
    flash[r.path] = it == flashSince_.end() || (again && r.id == *again) ? now : it->second;
  }
  flashSince_ = std::move(flash);
  if (sm.visible && sm.menu) {
    std::vector<PopupItem> items;
    for (const SidebarMenuItem& it : sm.menu->items) items.push_back(PopupItem{ it.id, fromUtf8(it.label), it.enabled, false });
    menu_.set("sidebar:menu:", items, (float)sm.menu->x, (float)sm.menu->y);
  } else {
    menu_.close();
  }
}

// A revealSeq the shell has not honoured yet scrolls the reveal row to the
// middle of the tree (after layout, so the geometry is the new model's).
void Ui::sidebarReveal() {
  const SidebarModel& sm = m_.sidebar;
  if (!sb_.on || sm.revealSeq == sbRevealSeq_) return;
  sbRevealSeq_ = sm.revealSeq;
  if (!sm.revealRowId) return;
  for (size_t i = 0; i < sm.rows.size(); i++) {
    if (sm.rows[i].id != *sm.revealRowId) continue;
    float centre = sb_.padDip + (float)sb_.line[i] * sb_.rowDip + sb_.rowDip / 2;
    sbScroll_.offset = ScrollBar::clampOffset(centre - sbScroll_.viewport / 2, sbScroll_.content, sbScroll_.viewport);
    layout();
    return;
  }
}

// The wheel over the column: three rows a notch, a partial notch in proportion.
bool Ui::sidebarWheel(POINT clientPx, int delta) {
  POINT bp{ clientPx.x, clientPx.y - (LONG)bodyTop() };
  if (!sb_.on || !contains(sb_.col, (float)bp.x, (float)bp.y)) return false;
  float before = sbScroll_.offset;
  sbScroll_.offset = ScrollBar::clampOffset(sbScroll_.offset - (float)delta / WHEEL_DELTA * kWheelRows * sb_.rowDip, sbScroll_.content,
                                            sbScroll_.viewport);
  if (sbScroll_.offset != before) sidebarScrolled(clientPx);
  return true;
}

// The rows moved under the pointer: the hit rects again, the hover from the
// pointer's new target, a repaint.
void Ui::sidebarScrolled(POINT clientPx) {
  layout();
  if (clientPx.y >= Window::instance().stripHeightPx())
    setHover(bodyTargetAt(POINT{ clientPx.x, clientPx.y - (LONG)bodyTop() }), false, clientPx);
  Window::instance().invalidateBody();
}

std::vector<Ui::DrawnRow> Ui::sidebarRows(D2D1_RECT_F* viewportDip, float* offsetDip) const {
  std::vector<DrawnRow> out;
  float d = dpi(), top = bodyTop();
  if (viewportDip) *viewportDip = D2D1_RECT_F{};
  if (offsetDip) *offsetDip = sbScroll_.offset;
  if (!sb_.on) return out;
  if (viewportDip)
    *viewportDip = D2D1::RectF(sb_.tree.left / d, (sb_.tree.top + top) / d, sb_.rowsRight / d, (sb_.tree.bottom + top) / d);
  float h = std::round(sb_.rowDip * d);
  for (size_t i = 0; i < m_.sidebar.rows.size(); i++) {
    float y = sidebarRowTop(i);
    out.push_back(DrawnRow{ m_.sidebar.rows[i].id, (y + top) / d, h / d, y + h > sb_.tree.top && y < sb_.tree.bottom });
  }
  return out;
}

bool Ui::scrollView(const std::string& view, float offsetDip, float* clamped) {
  if (view != "sidebar" || !sb_.on) return false;
  sbScroll_.offset = ScrollBar::clampOffset(offsetDip, sbScroll_.content, sbScroll_.viewport);
  if (clamped) *clamped = sbScroll_.offset;
  sidebarScrolled(pointer_);
  return true;
}

// A press on the scrollbar (Ui::mouse and the driver's click by target).
bool Ui::sidebarBarPress(UINT msg, POINT clientPx, const std::string& target) {
  float x = (float)clientPx.x, y = (float)clientPx.y - bodyTop();
  if (!sbBar_.mouse(msg, x, y, sbScroll_, sb_.rowDip, target)) return false;
  if (sbScroll_.dragging) SetCapture(Window::instance().body());
  sidebarScrolled(clientPx);
  return true;
}

void Ui::viewSidebar(Painter& p) {
  if (!sb_.on) return;
  const SidebarModel& sm = m_.sidebar;
  float s = p.scale(), d = dpi();
  float one = std::max(1.f, std::round(d));
  ULONGLONG now = GetTickCount64();

  // The column on `panel` with its 1 px panelBorder right edge. A press on
  // nothing in particular is sidebar:empty.
  hit(false, sb_.col, "sidebar:empty");
  p.fillRect(sb_.col, t_.panel);
  p.fillRect(D2D1::RectF(sb_.col.right - one, sb_.col.top, sb_.col.right, sb_.col.bottom), t_.panelBorder);

  // The rows, clipped to the tree.
  UiFont f{ 12 };
  float rowPx = std::round(sb_.rowDip * d);
  if (p.live()) p.pushClip(sb_.tree);
  for (size_t i = 0; i < sm.rows.size(); i++) {
    const SidebarRow& r = sm.rows[i];
    float top = sidebarRowTop(i);
    float bottom = top + rowPx;
    float x0 = sb_.tree.left + 6 * s + (float)r.depth * kIndentDip * s;
    bool rowShows = bottom > sb_.tree.top && top < sb_.tree.bottom;
    // The truncation line under this row, at the row's indent.
    if (r.truncatedAfter && bottom + rowPx > sb_.tree.top && bottom < sb_.tree.bottom && p.live()) {
      p.text(D2D1::RectF(x0 + 4 * s, bottom, sb_.rowsRight - 6 * s, bottom + rowPx), L"… too many entries to list", f, t_.titleText,
             Align::Left, true, 0.45f);
    }
    if (!rowShows) continue;
    std::string id = "sidebar:" + r.id;
    std::string twistyId = "sidebar:twisty:" + r.path;
    D2D1_RECT_F band = D2D1::RectF(sb_.tree.left, top, sb_.rowsRight, bottom);
    hit(false, clipTo(band, sb_.tree), id);
    D2D1_RECT_F twisty = D2D1::RectF(x0, top, x0 + kTwistyDip * s, bottom);
    if (r.isDir) hit(false, clipTo(D2D1::RectF(twisty.left, top, twisty.right, bottom), sb_.tree), twistyId);
    if (!p.live()) continue;

    // The row's fill: the reveal flash, the selection, or the hover.
    D2D1_RECT_F pill = D2D1::RectF(sb_.tree.left + 2 * s, top, sb_.rowsRight - 2 * s, bottom);
    bool hover = hovered(id) || hovered(twistyId);
    if (r.flashing) {
      auto it = flashSince_.find(r.path);
      ULONGLONG el = it == flashSince_.end() ? kFlashFadeMs : now - it->second;
      float t = std::min(1.f, (float)el / (float)kFlashFadeMs);
      float a = 0.2f + 0.4f * (1 - t) * (1 - t);   // ease-out from 0.6, then held at 0.2 until the core clears it
      p.roundedRect(pill, 2, kFlash, a, kFlash, std::min(1.f, a + 0.2f));
    } else if (r.selected) {
      p.roundedRect(pill, 2, t_.selection, hover ? 0.32f : 0.25f, t_.selection, 1);
    } else if (hover) {
      p.roundedRect(pill, 2, t_.selection, 0.1f, t_.selection, 0.4f);
    }
    float alpha = r.ignored ? 0.45f : 1.f;
    if (r.isDir) p.twisty(twisty, r.expanded, hover ? t_.titleText : t_.badgeText, alpha);
    D2D1_RECT_F icon = D2D1::RectF(twisty.right + 1 * s, top, twisty.right + (1 + kIconDip) * s, bottom);
    uint32_t chip = 0;
    if (r.isDir) p.folderGlyph(icon, r.expanded, alpha);
    else p.fileGlyph(icon, hexRgb(r.chip, &chip) ? &chip : nullptr, alpha);
    float nx = icon.right + 5 * s, nr = pill.right - 4 * s;
    if (r.error) {
      // The listing's error after the name, in badgeText.
      std::wstring name = fromUtf8(r.name), err = fromUtf8(*r.error);
      float ew = p.textWidth(err, f), nw = p.textWidth(name, f);
      float nameRight = std::max(nx, std::min(nx + nw + 1, nr - ew - 6 * s));
      p.text(D2D1::RectF(nx, top, nameRight, bottom), name, f, t_.titleText, Align::Left, true, alpha);
      p.text(D2D1::RectF(nameRight + 6 * s, top, nr, bottom), err, f, t_.badgeText, Align::Left, true, alpha);
    } else if (nr > nx) {
      // The name's layout is kept while the row shows at this width and font,
      // so a flash frame or a repaint for terminal output lays out nothing.
      char box[48];
      snprintf(box, sizeof box, "\x1f%ld\x1f%ld\x1f%ld", std::lround(nr - nx), std::lround(rowPx), std::lround(f.dip * s * 4));
      NameLayout& nl = sbNames_[r.name + box];
      if (!nl.tl) nl.tl = p.textLayout(fromUtf8(r.name), f, nr - nx, rowPx);
      nl.used = true;
      p.drawLayout(D2D1::RectF(nx, top, nr, bottom), nl.tl.Get(), t_.titleText, alpha);
    }
  }
  if (p.live()) {
    p.popClip();
    // Only the rows just drawn keep their layouts.
    for (auto it = sbNames_.begin(); it != sbNames_.end();) {
      if (!it->second.used) it = sbNames_.erase(it);
      else (it++)->second.used = false;
    }
  }

  // The scrollbar when the rows overflow.
  if (sb_.bar.right > sb_.bar.left) sbBar_.draw(p, sbScroll_, hover_, "sidebar:scroll");

  // The header: File Browser, and refresh at the right.
  p.fillRect(sb_.head, t_.panel);
  p.fillRect(D2D1::RectF(sb_.head.left, sb_.head.bottom - one, sb_.head.right, sb_.head.bottom), t_.divider);
  float hh = sb_.head.bottom - sb_.head.top;
  D2D1_RECT_F refresh = D2D1::RectF(sb_.head.right - 6 * s - 22 * s, sb_.head.top + std::round((hh - 22 * s) / 2), sb_.head.right - 6 * s,
                                    sb_.head.top + std::round((hh + 22 * s) / 2));
  p.text(D2D1::RectF(sb_.head.left + 12 * s, sb_.head.top, refresh.left - 4 * s, sb_.head.bottom - one), L"File Browser", UiFont{ 12, true },
         t_.badgeText, Align::Left, true);
  hit(false, refresh, "sidebar:refresh");
  if (hovered("sidebar:refresh")) p.roundedRect(refresh, 3, 0xFFFFFF, pressed("sidebar:refresh") ? 0.9f : 0.6f, t_.panelBorder, 0.6f);
  p.glyph(refresh, 0x27F3, hovered("sidebar:refresh") ? t_.titleText : t_.badgeText, 13);

  // The path strip: the selected path (or the root), its end always in view.
  hit(false, sb_.strip, "sidebar:strip");
  bool stripHover = hovered("sidebar:strip");
  p.fillRect(sb_.strip, stripHover ? mixRgb(t_.divider, t_.badge, 0.45f) : t_.badge);
  p.fillRect(D2D1::RectF(sb_.strip.left, sb_.strip.top, sb_.strip.right, sb_.strip.top + one), t_.divider);
  if (p.live()) {
    UiFont sf{ 11 };
    uint32_t ink = stripHover ? t_.titleText : t_.badgeText;
    D2D1_RECT_F area = D2D1::RectF(sb_.strip.left + 8 * s, sb_.strip.top + one, sb_.strip.right - 8 * s, sb_.strip.bottom);
    std::wstring path = fromUtf8(sm.strip);
    if (p.textWidth(path, sf) <= area.right - area.left) {
      p.text(area, path, sf, ink, Align::Left, false);
    } else {
      // The renderer's direction: rtl ellipsis: a leading '…', then the path
      // right-aligned and clipped on the left, so the file name survives.
      std::wstring ell = L"…";
      float ew = std::ceil(p.textWidth(ell, sf));
      p.text(D2D1::RectF(area.left, area.top, area.left + ew, area.bottom), ell, sf, ink, Align::Left, false);
      p.text(D2D1::RectF(area.left + ew, area.top, area.right, area.bottom), path, sf, ink, Align::Right, false);
    }
  }

  // The grip beside the column (6 DIP from the model, the accent under the pointer or in a drag).
  D2D1_RECT_F grip = dev(sm.gripRect);
  hit(false, grip, "sidebar:grip");
  if (hovered("sidebar:grip") || dragDivider_ == "sidebar:grip") p.fillRect(grip, t_.accent, 0.6f);
}

// The popups over everything below the restore card and the toast: the
// explorer's context menu.
void Ui::viewMenu(Painter& p) {
  if (!menu_.isOpen() || modal()) return;
  Window& win = Window::instance();
  RECT rc{};
  if (win.body()) GetClientRect(win.body(), &rc);
  menu_.draw(p, D2D1::RectF(0, 0, (float)rc.right, (float)rc.bottom), bodyTop(), hover_);
}

// Some flashing row is still inside its fade (the animation timer runs for it).
bool Ui::sidebarAnimating(ULONGLONG now) const {
  for (const auto& f : flashSince_)
    if (now - f.second < kFlashFadeMs) return true;
  return false;
}
