// What draws over the panes: the find bar, the toast, the empty state, the
// splash, the restore card (6.3 cards and dialogs) and the tooltip; and the
// update banner in its band above the status bar (Task 14).
#include "ui/ui.h"
#include "gfx.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {
// The renderer's toLocaleString for an ISO time ("10/2/2026, 5:47:50 PM"), in
// local time; "" when it does not parse.
std::wstring localTime(const std::string& iso) {
  SYSTEMTIME u{};
  int y, mo, d, h, mi, se;
  if (sscanf_s(iso.c_str(), "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &se) != 6) return L"";
  u.wYear = (WORD)y; u.wMonth = (WORD)mo; u.wDay = (WORD)d; u.wHour = (WORD)h; u.wMinute = (WORD)mi; u.wSecond = (WORD)se;
  SYSTEMTIME l{};
  if (!SystemTimeToTzSpecificLocalTime(nullptr, &u, &l)) return L"";
  int h12 = l.wHour % 12 == 0 ? 12 : l.wHour % 12;
  wchar_t buf[64];
  swprintf(buf, 64, L"%u/%u/%u, %d:%02u:%02u %s", l.wMonth, l.wDay, l.wYear, h12, l.wMinute, l.wSecond, l.wHour < 12 ? L"AM" : L"PM");
  return buf;
}

void card(Painter& p, D2D1_RECT_F r, const Tokens& t) {
  // A 2 px drop shadow, then 6.3's #f0f0f0 face with a 1 px #a0a0a0 border.
  p.roundedRect(D2D1::RectF(r.left + p.px(1), r.top + p.px(2), r.right + p.px(2), r.bottom + p.px(3)), t.radius, 0x000000, 0.18f, 0, 0);
  p.roundedRect(r, t.radius, t.toastBg, 1, 0xA0A0A0, 1);
}
}  // namespace

// Top right of the find pane's grid: the query, Aa and .* toggles, the count,
// previous, next and close.
void Ui::viewFindBar(Painter& p) {
  if (!m_.find.open || modal()) return;
  float s = p.scale();
  D2D1_RECT_F area{};
  const PaneModel* pm = m_.find.paneId ? pane(*m_.find.paneId) : nullptr;
  if (pm && paneVisible(*pm)) {
    area = dev(pm->gridRect);
  } else {
    for (const PaneModel& q : m_.panes)
      if (q.focused && paneVisible(q)) area = dev(q.gridRect);
  }
  if (area.right - area.left < 60 * s) return;
  float w = std::min(360 * s, area.right - area.left - 12 * s), h = 30 * s;
  D2D1_RECT_F bar = D2D1::RectF(std::round(area.right - 8 * s - w), std::round(area.top + 6 * s), std::round(area.right - 8 * s),
                                std::round(area.top + 6 * s + h));
  hit(false, bar, "find:bar");
  card(p, bar, t_);
  float x = bar.right - 4 * s;
  auto button = [&](const char* target, uint32_t cp, float glyphDip, bool on) {
    D2D1_RECT_F r = D2D1::RectF(x - 22 * s, bar.top + 4 * s, x, bar.bottom - 4 * s);
    hit(false, r, target);
    if (on || hovered(target)) p.win7Button(r, on ? BtnState::Pressed : btn(target));
    p.glyph(r, cp, t_.toastText, glyphDip);
    x = r.left - 2 * s;
  };
  button("find:close", 0x2715, 9, false);
  button("find:next", 0x2193, 11, false);
  button("find:prev", 0x2191, 11, false);
  // FindBar.tsx's counter: "N of M" (N one-based), "1000+" for a capped
  // total, "0 of 0" for a query with no result yet or a miss.
  std::wstring count;
  if (m_.find.count)
    count = std::to_wstring(std::max(0, m_.find.count->index + 1)) + L" of " +
            (m_.find.count->capped || m_.find.count->total >= 1000 ? L"1000+" : std::to_wstring(m_.find.count->total));
  else if (!find_.valueUtf8().empty())
    count = L"0 of 0";
  float cw = 68 * s;
  p.text(D2D1::RectF(x - cw, bar.top, x - 2 * s, bar.bottom), count, UiFont{ 11 }, m_.find.miss ? mixRgb(t_.danger, 0, 0.8f) : t_.toastText,
         Align::Center, true);
  x -= cw + 2 * s;
  auto toggle = [&](const char* target, const wchar_t* label, bool on) {
    D2D1_RECT_F r = D2D1::RectF(x - 26 * s, bar.top + 4 * s, x, bar.bottom - 4 * s);
    hit(false, r, target);
    p.win7Button(r, on ? BtnState::Pressed : btn(target));
    p.text(r, label, UiFont{ 11, on }, t_.toastText, Align::Center, false);
    x = r.left - 2 * s;
  };
  toggle("find:regex", L".*", m_.find.regex);
  toggle("find:case", L"Aa", m_.find.caseSensitive);
  D2D1_RECT_F field = D2D1::RectF(bar.left + 6 * s, bar.top + 4 * s, x - 2 * s, bar.bottom - 4 * s);
  hit(false, field, "find:query");
  find_.draw(p, field, UiFont{ 12 }, 0x1E1E1E, m_.find.miss, caretOn_);
}

// The update banner (UpdateBanner.tsx; plan Task 14) in the band the core's
// layout leaves above the status bar: toastBg with a 1 px #a0a0a0 top line,
// the text at the left, the buttons at the right as win7Buttons (Download,
// Install and Relaunch and Try again are the primary ones, btn--primary,
// drawn with the default ring), and a thin accent bar along the bottom for a
// download's progress.
void Ui::viewUpdate(Painter& p) {
  if (!haveModel_ || !m_.update || coreDead_) return;
  const UpdateBannerModel& u = *m_.update;
  float s = p.scale(), d = dpi();
  D2D1_RECT_F band = dev(u.rect);
  if (band.bottom - band.top < 4 * s || band.right <= band.left) return;
  hit(false, band, "update:bar");
  if (p.live()) {
    p.fillRect(band, t_.toastBg);
    p.fillRect(D2D1::RectF(band.left, band.top, band.right, band.top + std::max(1.f, std::round(d))), 0xA0A0A0);
  }
  float bh = std::round(std::min(22 * s, band.bottom - band.top - 4 * s));
  float by = std::round((band.top + band.bottom) / 2 - bh / 2);
  float x = band.right - 12 * s;
  for (auto it = u.buttons.rbegin(); it != u.buttons.rend(); ++it) {
    std::wstring label = fromUtf8(it->label);
    float bw = std::max(72 * s, std::ceil(p.textWidth(label, UiFont{ 12 })) + 24 * s);
    D2D1_RECT_F b = D2D1::RectF(std::round(x - bw), by, std::round(x), by + bh);
    std::string t = "update:" + it->id;
    hit(false, b, t);
    bool primary = it->id == "download" || it->id == "install" || it->id == "retry";
    p.win7Button(b, btn(t, primary), label);
    x = b.left - 8 * s;
  }
  p.text(D2D1::RectF(band.left + 12 * s, band.top, std::max(band.left + 12 * s, x - 4 * s), band.bottom), fromUtf8(u.text), UiFont{ 12 },
         t_.toastText, Align::Left, true);
  if (u.progress && p.live()) {
    float f = (float)std::clamp(*u.progress, 0.0, 1.0);
    float h = std::max(2.f, std::round(2 * s));
    p.fillRect(D2D1::RectF(band.left, band.bottom - h, band.left + std::round((band.right - band.left) * f), band.bottom), t_.accent);
  }
}

void Ui::viewOverlays(Painter& p) {
  Window& win = Window::instance();
  RECT rc{};
  if (win.body()) GetClientRect(win.body(), &rc);
  float W = (float)rc.right, H = (float)rc.bottom;
  float s = p.scale(), d = dpi();
  float statusH = std::round((float)m_.window.statusH * d);

  // Before the first model, and while the core boots or restores.
  if (!haveModel_ || (m_.starting && m_.panes.empty() && !m_.restore)) {
    D2D1_RECT_F all = D2D1::RectF(0, 0, W, H);
    hit(false, all, "splash");
    p.text(all, L"Starting SeaShell...", UiFont{ 14 }, t_.badgeText, Align::Center, false);
  } else if (m_.emptyState) {
    float cy = (H - statusH) / 2;
    p.text(D2D1::RectF(0, cy - 40 * s, W, cy - 12 * s), L"No tabs open", UiFont{ 16, true }, t_.titleText, Align::Center, false);
    D2D1_RECT_F b = D2D1::RectF(std::round(W / 2 - 95 * s), std::round(cy), std::round(W / 2 + 95 * s), std::round(cy + 28 * s));
    hit(false, b, "empty:newtab");
    p.win7Button(b, btn("empty:newtab"), L"New Tab (Ctrl+Shift+T)");
  }

  // The toast, bottom centre above the status bar. A dead core's message is
  // the shell's own and stays until the core comes back.
  std::wstring toast;
  if (coreDead_) {
    toast = L"The SeaShell core stopped (code " + std::to_wstring(coreCode_) + L"). Restart a pane or quit.";
  } else if (m_.toast) {
    toast = fromUtf8(*m_.toast);
  }
  if (!toast.empty()) {
    UiFont f{ 12 };
    float tw = std::min(std::ceil(p.textWidth(toast, f)) + 32 * s, W - 24 * s);
    float th = 32 * s;
    // Above the update banner while it shows, as the renderer's body ends there.
    float bottom = m_.update && !coreDead_ ? dev(m_.update->rect).top : H - statusH;
    D2D1_RECT_F r = D2D1::RectF(std::round(W / 2 - tw / 2), std::round(bottom - 14 * s - th), std::round(W / 2 + tw / 2),
                                std::round(bottom - 14 * s));
    hit(false, r, "toast");
    card(p, r, t_);
    p.text(inset(r, 14 * s, 0), toast, f, t_.toastText, Align::Center, true);
  }

  // A sheet (sheet.cpp) over everything but the tooltip.
  viewSheet(p);

  // The restore card over everything: a full-window dim and a centred panel.
  if (modal() && m_.restore) {
    D2D1_RECT_F all = D2D1::RectF(0, 0, W, H);
    hit(false, all, "restore:card");
    p.fillRect(all, 0x000000, 0.4f);
    float cw = std::min(420 * s, W - 24 * s), ch = 150 * s;
    D2D1_RECT_F r = D2D1::RectF(std::round(W / 2 - cw / 2), std::round(H / 2 - ch / 2), std::round(W / 2 + cw / 2), std::round(H / 2 + ch / 2));
    card(p, r, t_);
    const RestoreCardModel& rm = *m_.restore;
    std::wstring when = localTime(rm.savedAt);
    std::wstring detail = std::to_wstring(rm.tabs) + (rm.tabs == 1 ? L" tab, " : L" tabs, ") + std::to_wstring(rm.panes) +
                          (rm.panes == 1 ? L" pane" : L" panes") + (when.empty() ? L"" : L", saved " + when) +
                          L". Claude panes resume their sessions.";
    p.text(D2D1::RectF(r.left + 18 * s, r.top + 14 * s, r.right - 18 * s, r.top + 40 * s), L"Restore last session?", UiFont{ 14, true },
           t_.toastText, Align::Left, true);
    if (p.live()) {
      // The sentence wraps over two lines inside the card.
      D2D1_RECT_F dr = D2D1::RectF(r.left + 18 * s, r.top + 44 * s, r.right - 18 * s, r.top + 92 * s);
      Microsoft::WRL::ComPtr<IDWriteTextLayout> tl;
      IDWriteTextFormat* tf = Painter::format(UiFont{ 12 }, 12 * s);
      if (tf && SUCCEEDED(Gfx::instance().dwrite()->CreateTextLayout(detail.data(), (UINT32)detail.size(), tf, dr.right - dr.left,
                                                                     dr.bottom - dr.top, tl.GetAddressOf()))) {
        tl->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
        tl->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> b;
        uint32_t c = t_.toastText;
        p.rt()->CreateSolidColorBrush(D2D1::ColorF(((c >> 16) & 0xFF) / 255.f, ((c >> 8) & 0xFF) / 255.f, (c & 0xFF) / 255.f, 1), b.GetAddressOf());
        if (b) p.rt()->DrawTextLayout(D2D1::Point2F(dr.left, dr.top), tl.Get(), b.Get());
      }
    }
    D2D1_RECT_F fresh = D2D1::RectF(r.right - 18 * s - 100 * s, r.bottom - 16 * s - 26 * s, r.right - 18 * s, r.bottom - 16 * s);
    D2D1_RECT_F yes = D2D1::RectF(fresh.left - 10 * s - 100 * s, fresh.top, fresh.left - 10 * s, fresh.bottom);
    hit(false, yes, "restore:yes");
    hit(false, fresh, "restore:fresh");
    p.win7Button(yes, btn("restore:yes", restoreFocus_ == 0), L"Restore");
    p.win7Button(fresh, btn("restore:fresh", restoreFocus_ == 1), L"Start fresh");
  }

  // The tooltip, near the pointer (a strip target's shows at the body's top).
  if (tipShown_ && !tip_.empty() && p.live()) {
    UiFont f{ 12 };
    float tw = std::min(p.textWidth(tip_, f) + 12 * s, W - 8 * s), th = 22 * s;
    float px = (float)pointer_.x, py = hoverStrip_ ? 2 * s : (float)pointer_.y - (float)win.bodyRect().top + 20 * s;
    float left = std::clamp(px, 4 * s, std::max(4 * s, W - tw - 4 * s));
    float top = std::clamp(py, 2 * s, std::max(2 * s, H - th - 2 * s));
    D2D1_RECT_F r = D2D1::RectF(std::round(left), std::round(top), std::round(left + tw), std::round(top + th));
    p.fillRect(r, 0xFFFFFF);
    p.strokeRect(r, 0x767676);
    p.text(inset(r, 6 * s, 0), tip_, f, 0x575757, Align::Left, true);
  }
}
