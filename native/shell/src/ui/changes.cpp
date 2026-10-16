// The changes column beside a zoomed agent pane (ChangesModel): its header
// (Changes, the agent and the file count, the line totals, hide), the note
// when only the agent's own record is listed, the groups Created, Edited and
// Deleted with their rows, the Win7 scrollbar when they overflow, and the
// grip between the pane and the column. Below the list, while a row is
// previewed, PreviewHost puts its WebView2 over the preview rect; this file
// only paints what shows until it does. The rows' scroll offset is the
// shell's own view state, as the explorer's is.
#include "ui/ui.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cmath>

namespace {
const float kWheelRows = 3;      // rows per wheel notch
const float kPadDip = 4;         // above the first group and below the last row

bool lightFace(uint32_t rgb) {
  float lum = (0.2126f * ((rgb >> 16) & 0xFF) + 0.7152f * ((rgb >> 8) & 0xFF) + 0.0722f * (rgb & 0xFF)) / 255.f;
  return lum > 0.5f;
}

D2D1_RECT_F clipTo(D2D1_RECT_F r, D2D1_RECT_F c) {
  return D2D1::RectF(std::max(r.left, c.left), std::max(r.top, c.top), std::min(r.right, c.right), std::min(r.bottom, c.bottom));
}
}  // namespace

// Where the column's parts go for the current model, and the list's scroll
// content, viewport and offset.
void Ui::changesGeometry() {
  ChangesGeom g;
  if (haveModel_ && m_.changes && !coreDead_) {
    const ChangesModel& cm = *m_.changes;
    float d = dpi();
    g.col = dev(cm.rect);
    if (g.col.right - g.col.left > 2 && g.col.bottom > g.col.top) {
      g.on = true;
      g.head = D2D1::RectF(g.col.left, g.col.top, g.col.right, std::min(g.col.bottom, g.col.top + std::round((float)cm.headerH * d)));
      g.list = dev(cm.listRect);
      g.note = D2D1::RectF(g.col.left, g.head.bottom, g.col.right, std::max(g.head.bottom, g.list.top));
      if (cm.preview) g.preview = dev(cm.preview->rect);
      float content = kPadDip * (float)m_.window.uiScale * 2;
      for (const ChangeGroupModel& grp : cm.groups) content += (float)cm.groupH + (grp.folded ? 0.f : (float)grp.rows.size() * (float)cm.rowH);
      if (cm.paneId != chPane_) {
        chPane_ = cm.paneId;
        chScroll_.offset = 0;
      }
      chScroll_.content = content;
      chScroll_.viewport = std::max(0.f, (g.list.bottom - g.list.top) / d);
      chScroll_.offset = ScrollBar::clampOffset(chScroll_.offset, chScroll_.content, chScroll_.viewport);
      g.rowsRight = g.list.right - std::max(1.f, std::round(d));
      if (ScrollBar::needed(chScroll_)) {
        g.bar = D2D1::RectF(std::round(g.rowsRight - ScrollBar::kWidthDip * d), g.list.top, g.rowsRight, g.list.bottom);
        g.rowsRight = g.bar.left;
      }
      chBar_.layout(g.bar, d);
    }
  }
  if (!g.on) {
    if (chScroll_.dragging) {
      chScroll_.dragging = false;
      if (GetCapture() == Window::instance().body()) ReleaseCapture();
    }
    chBar_.layout(D2D1_RECT_F{}, 1);
    chPane_.clear();
  }
  ch_ = g;
}

void Ui::viewChanges(Painter& p) {
  if (!ch_.on || !m_.changes) return;
  const ChangesModel& cm = *m_.changes;
  float s = p.scale(), d = dpi();
  float one = std::max(1.f, std::round(d));
  bool light = lightFace(t_.panel);
  uint32_t green = light ? 0x1A7F37 : 0x3FB950, red = light ? 0xCF222E : 0xF85149, amber = light ? 0x9A6700 : 0xD29922;

  hit(false, ch_.col, "changes:column");
  p.fillRect(ch_.col, t_.panel);

  // The header: Changes and the agent's line, the totals and hide at the right.
  float hh = ch_.head.bottom - ch_.head.top;
  D2D1_RECT_F hide = D2D1::RectF(ch_.head.right - 8 * s - 20 * s, ch_.head.top + std::round((hh - 20 * s) / 2), ch_.head.right - 8 * s,
                                 ch_.head.top + std::round((hh + 20 * s) / 2));
  hit(false, hide, "changes:hide");
  if (hovered("changes:hide")) p.roundedRect(hide, 3, t_.hoverFace, pressed("changes:hide") ? 0.9f : 0.6f, t_.panelBorder, 0.6f);
  p.glyph(hide, 0x2715, hovered("changes:hide") ? t_.titleText : t_.badgeText, 9);
  float right = hide.left - 8 * s;
  if (!cm.totals.empty() && p.live()) {
    // '+120 -30': the additions green, the removals red.
    size_t sp = cm.totals.find(' ');
    std::wstring plus = fromUtf8(cm.totals.substr(0, sp)), minus = sp == std::string::npos ? L"" : fromUtf8(cm.totals.substr(sp + 1));
    UiFont f{ 11, true };
    float mw = p.textWidth(minus, f), pw = p.textWidth(plus, f);
    p.text(D2D1::RectF(right - mw, ch_.head.top, right, ch_.head.bottom), minus, f, red, Align::Right, false);
    right -= mw + 6 * s;
    p.text(D2D1::RectF(right - pw, ch_.head.top, right, ch_.head.bottom), plus, f, green, Align::Right, false);
    right -= pw + 8 * s;
  }
  float mid = ch_.head.top + hh / 2;
  p.text(D2D1::RectF(ch_.head.left + 12 * s, ch_.head.top + 4 * s, std::max(ch_.head.left + 12 * s, right), mid + 1 * s), fromUtf8(cm.title),
         UiFont{ 12, true }, t_.titleText, Align::Left, true);
  p.text(D2D1::RectF(ch_.head.left + 12 * s, mid, std::max(ch_.head.left + 12 * s, right), ch_.head.bottom - 4 * s), fromUtf8(cm.subtitle),
         UiFont{ 11 }, t_.badgeText, Align::Left, true);
  p.fillRect(D2D1::RectF(ch_.head.left, ch_.head.bottom - one, ch_.head.right, ch_.head.bottom), t_.divider);

  // The note: only the agent's own record is listed, and why.
  if (cm.note && ch_.note.bottom - ch_.note.top > 8 * s) {
    D2D1_RECT_F box = inset(ch_.note, 8 * s, 5 * s);
    p.roundedRect(box, std::min(t_.radius, 6.f), t_.badge, 0.7f, t_.panelBorder, 0.5f);
    p.text(inset(box, 8 * s, 2 * s), fromUtf8(*cm.note), UiFont{ 11 }, t_.badgeText, Align::Left, true);
  }

  // The list, clipped to its rect.
  hit(false, ch_.list, "changes:list");
  float groupPx = std::round((float)cm.groupH * d), rowPx = std::round((float)cm.rowH * d);
  float y = std::round(ch_.list.top + (kPadDip * (float)m_.window.uiScale - chScroll_.offset) * d);
  if (p.live()) p.pushClip(ch_.list);
  UiFont f{ 12 }, small{ 11 };
  for (const ChangeGroupModel& grp : cm.groups) {
    float top = y, bottom = y + groupPx;
    y = bottom;
    if (bottom > ch_.list.top && top < ch_.list.bottom) {
      std::string gid = "changes:group:" + grp.id;
      D2D1_RECT_F band = D2D1::RectF(ch_.list.left, top, ch_.rowsRight, bottom);
      hit(false, clipTo(band, ch_.list), gid);
      if (p.live()) {
        if (hovered(gid)) p.fillRect(band, t_.selection, 0.08f);
        D2D1_RECT_F tw = D2D1::RectF(band.left + 8 * s, top, band.left + 22 * s, bottom);
        p.twisty(tw, !grp.folded, t_.badgeText);
        std::wstring label = fromUtf8(grp.label);
        UiFont gf{ 11, true };
        float lw = p.textWidth(label, gf);
        p.text(D2D1::RectF(tw.right + 4 * s, top, tw.right + 4 * s + lw + 1, bottom), label, gf, t_.badgeText, Align::Left, false);
        std::wstring n = std::to_wstring(grp.count);
        float nw = std::max(16 * s, p.textWidth(n, small) + 10 * s);
        D2D1_RECT_F pill = D2D1::RectF(tw.right + 10 * s + lw, top + (groupPx - 16 * s) / 2, tw.right + 10 * s + lw + nw, top + (groupPx + 16 * s) / 2);
        p.roundedRect(pill, 8, t_.badge, 1, t_.panelBorder, 0.5f);
        p.text(pill, n, small, t_.badgeText, Align::Center, false);
      }
    }
    if (grp.folded) continue;
    for (const ChangeRowModel& r : grp.rows) {
      float rt = y, rb = y + rowPx;
      y = rb;
      if (rb <= ch_.list.top || rt >= ch_.list.bottom) continue;
      std::string id = "changes:" + r.id;
      D2D1_RECT_F band = D2D1::RectF(ch_.list.left, rt, ch_.rowsRight, rb);
      hit(false, clipTo(band, ch_.list), id);
      if (!p.live()) continue;
      D2D1_RECT_F pill = D2D1::RectF(band.left + 4 * s, rt, band.right - 4 * s, rb);
      bool hover = hovered(id);
      if (r.selected) p.roundedRect(pill, std::min(t_.radius, 6.f), t_.selection, hover ? 0.32f : 0.25f, t_.selection, 1);
      else if (hover) p.roundedRect(pill, std::min(t_.radius, 6.f), t_.selection, 0.1f, t_.selection, 0.4f);
      bool gone = r.change == "deleted";
      // The state mark at the right (A, M, D in the change's colour), then the stat.
      uint32_t markRgb = r.change == "created" ? green : gone ? red : amber;
      D2D1_RECT_F mark = D2D1::RectF(pill.right - 6 * s - 14 * s, rt, pill.right - 6 * s, rb);
      p.text(mark, r.change == "created" ? L"A" : gone ? L"D" : L"M", UiFont{ 11, true }, markRgb, Align::Center, false);
      float rx = mark.left - 6 * s;
      if (!r.stat.empty()) {
        std::wstring rem = L"-" + std::to_wstring(r.removed), add = L"+" + std::to_wstring(r.added);
        float rw = p.textWidth(rem, small), aw = p.textWidth(add, small);
        if (r.removed > 0 || r.change != "created") {
          p.text(D2D1::RectF(rx - rw, rt, rx, rb), rem, small, red, Align::Right, false, r.removed > 0 ? 1.f : 0.45f);
          rx -= rw + 4 * s;
        }
        if (r.added > 0 || r.change != "deleted") {
          p.text(D2D1::RectF(rx - aw, rt, rx, rb), add, small, green, Align::Right, false, r.added > 0 ? 1.f : 0.45f);
          rx -= aw;
        }
        rx -= 8 * s;
      }
      // The file glyph, the name, then its folder dimmed.
      D2D1_RECT_F icon = D2D1::RectF(pill.left + 22 * s, rt, pill.left + 38 * s, rb);
      p.fileGlyph(icon, nullptr, gone ? 0.5f : 1.f);
      float nx = icon.right + 6 * s;
      if (rx > nx) {
        std::wstring name = fromUtf8(r.name), dir = fromUtf8(r.dir);
        float nw = std::min(p.textWidth(name, f) + 1, rx - nx);
        p.text(D2D1::RectF(nx, rt, nx + nw, rb), name, f, gone ? t_.badgeText : t_.titleText, Align::Left, true);
        if (!dir.empty() && nx + nw + 8 * s < rx)
          p.text(D2D1::RectF(nx + nw + 6 * s, rt, rx, rb), dir, small, t_.badgeText, Align::Left, true, 0.8f);
        if (gone) {
          // Struck through, as Cursor marks a deleted file.
          float ly = std::round((rt + rb) / 2);
          p.fillRect(D2D1::RectF(nx, ly, nx + nw, ly + one), t_.badgeText, 0.8f);
        }
      }
    }
  }
  if (cm.empty && p.live()) p.text(ch_.list, fromUtf8(*cm.empty), UiFont{ 12 }, t_.badgeText, Align::Center, true, 0.9f);
  if (p.live()) p.popClip();
  if (ch_.bar.right > ch_.bar.left) chBar_.draw(p, chScroll_, hover_, "changes:scroll");

  // The preview: the WebView2 covers this once it is up.
  if (cm.preview && ch_.preview.bottom > ch_.preview.top) {
    hit(false, ch_.preview, "changes:preview");
    p.fillRect(D2D1::RectF(ch_.col.left, ch_.preview.top - one, ch_.col.right, ch_.preview.top), t_.divider);
    p.fillRect(ch_.preview, t_.panel);
    p.text(ch_.preview, L"Loading preview…", UiFont{ 12 }, t_.badgeText, Align::Center, true, 0.8f);
  }

  // The frame, rounded like the panes, and the grip beside it.
  p.cornerMask(ch_.col, t_.radius, t_.body);
  p.roundedStroke(ch_.col, t_.radius, t_.panelBorder, 1, 0.8f);
  D2D1_RECT_F grip = dev(cm.gripRect);
  hit(false, grip, "changes:grip");
  if (hovered("changes:grip") || dragDivider_ == "changes:grip") p.fillRect(grip, t_.accent, 0.6f);
}

// The wheel over the list: three rows a notch.
bool Ui::changesWheel(POINT clientPx, int delta) {
  POINT bp{ clientPx.x, clientPx.y - (LONG)bodyTop() };
  if (!ch_.on || !m_.changes || !contains(ch_.list, (float)bp.x, (float)bp.y)) return false;
  float before = chScroll_.offset;
  chScroll_.offset = ScrollBar::clampOffset(chScroll_.offset - (float)delta / WHEEL_DELTA * kWheelRows * (float)m_.changes->rowH,
                                            chScroll_.content, chScroll_.viewport);
  if (chScroll_.offset != before) sidebarScrolled(clientPx);   // the hit rects again, the hover, a repaint
  return true;
}

bool Ui::changesBarPress(UINT msg, POINT clientPx, const std::string& target) {
  if (!m_.changes) return false;
  float x = (float)clientPx.x, y = (float)clientPx.y - bodyTop();
  if (!chBar_.mouse(msg, x, y, chScroll_, (float)m_.changes->rowH, target)) return false;
  if (chScroll_.dragging) SetCapture(Window::instance().body());
  sidebarScrolled(clientPx);
  return true;
}

// Where PreviewHost puts the WebView2: the preview rect inside the column's
// border, its bottom kept clear of the rounded corners; hidden while a sheet,
// the restore card, a menu or a popover is over the body (they are drawn
// under it otherwise).
bool Ui::previewPlacement(RECT* bounds, bool* visible, uint32_t* bg) const {
  if (!ch_.on || !m_.changes || !m_.changes->preview) return false;
  D2D1_RECT_F r = ch_.preview;
  float d = dpi(), one = std::max(1.f, std::round(d));
  float corner = std::ceil(t_.radius * d * (float)m_.window.uiScale);
  *bounds = RECT{ (LONG)std::lround(r.left + one), (LONG)std::lround(r.top), (LONG)std::lround(r.right - one),
                  (LONG)std::lround(std::max(r.top, r.bottom - std::max(one, corner))) };
  *visible = !modal() && !menu_.isOpen() && !popover_.isOpen() && !(move_.kind != MoveDrag::None && move_.live);
  *bg = t_.panel;
  return bounds->right > bounds->left && bounds->bottom > bounds->top;
}

std::vector<Ui::DrawnRow> Ui::changesRows(float* offsetDip) const {
  std::vector<DrawnRow> out;
  if (offsetDip) *offsetDip = chScroll_.offset;
  if (!ch_.on || !m_.changes) return out;
  const ChangesModel& cm = *m_.changes;
  float d = dpi(), top = bodyTop();
  float y = std::round(ch_.list.top + (kPadDip * (float)m_.window.uiScale - chScroll_.offset) * d);
  float groupPx = std::round((float)cm.groupH * d), rowPx = std::round((float)cm.rowH * d);
  for (const ChangeGroupModel& grp : cm.groups) {
    out.push_back(DrawnRow{ "group:" + grp.id, (y + top) / d, groupPx / d, y + groupPx > ch_.list.top && y < ch_.list.bottom });
    y += groupPx;
    if (grp.folded) continue;
    for (const ChangeRowModel& r : grp.rows) {
      out.push_back(DrawnRow{ r.id, (y + top) / d, rowPx / d, y + rowPx > ch_.list.top && y < ch_.list.bottom });
      y += rowPx;
    }
  }
  return out;
}
