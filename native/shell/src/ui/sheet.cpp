// The sheet over the dimmed window (redesign spec 6.3 cards and dialogs): a
// centred toastBg card with a 1 px cardBorder and the tokens' radius, the
// title bold, each section's title in badgeText, option rows of win7Buttons
// (pressed when selected, greyed when disabled, a 10 DIP swatch when the
// option has one), 13 DIP Win7 check boxes, a text field through EditWidget,
// notes as wrapped text, and the bottom buttons right-aligned with the
// default's glow ring. The body scrolls with the Win7 scrollbar when the
// sections are taller than the card allows. Everything comes from
// UiModel.sheet; the shell keeps only the scroll, the hover and the focus.
// The Projects sheet (Task 13) adds a rows field: one row per saved project,
// the name bold over its meta in badgeText, Delete, Add and Open at the right
// (Delete in danger and Cancel while the row confirms); a field with no label
// takes no label line, and a button with no caption of its own is its label,
// at the left with its note beside it. The tutorial (Task 14; Tutorial.tsx and
// styles.css .tut) lays its parts out its own way: the step counter as a quiet
// title, the step's title large in the accent, its paragraphs at 13 DIP, its
// key table as kbd boxes beside the actions, and the step buttons as a row of
// dots; the arrows reach the core as keys on the sheet.
#include "ui/sheet.h"
#include "ui/ui.h"
#include "app.h"
#include "gfx.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace {
bool startsWith(const std::string& s, const std::string& p) { return s.rfind(p, 0) == 0; }

// A wrapped paragraph's height at width w (device pixels), drawn when paint.
float paragraph(Painter& p, float x, float y, float w, const std::wstring& s, UiFont f, uint32_t rgb, bool paint, D2D1_RECT_F clip) {
  if (s.empty() || w <= 0) return 0;
  Microsoft::WRL::ComPtr<IDWriteTextLayout> tl = p.textLayout(s, f, w, 100000, Align::Left, false);
  if (!tl) return 0;
  tl->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
  tl->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);   // the chrome's formats centre vertically
  DWRITE_TEXT_METRICS m{};
  if (FAILED(tl->GetMetrics(&m))) return 0;
  float h = std::ceil(m.height);
  if (paint && p.live() && y + h > clip.top && y < clip.bottom) p.drawLayout(D2D1::RectF(x, y, x + w, y + h), tl.Get(), rgb);
  return h;
}

uint32_t hexRgb(const std::string& s, uint32_t d) {
  if (s.size() != 7 || s[0] != '#') return d;
  char* end = nullptr;
  unsigned long v = strtoul(s.c_str() + 1, &end, 16);
  return end && *end == 0 ? (uint32_t)v : d;
}

D2D1_RECT_F clipTo(D2D1_RECT_F r, D2D1_RECT_F c) {
  return D2D1::RectF(std::max(r.left, c.left), std::max(r.top, c.top), std::min(r.right, c.right), std::min(r.bottom, c.bottom));
}
bool empty(D2D1_RECT_F r) { return r.right <= r.left || r.bottom <= r.top; }

// A rows field's buttons (ProjectsPanel.tsx:194-236): Delete, Add, Open; while
// the row confirms, Delete in danger and Cancel.
struct RowButton {
  const char* id;
  const wchar_t* label;
  bool danger, primary;
};
constexpr RowButton kRowButtons[] = { { "delete", L"Delete", false, false }, { "add", L"Add", false, false }, { "open", L"Open", false, true } };
constexpr RowButton kRowConfirm[] = { { "confirm", L"Delete", true, false }, { "cancel", L"Cancel", false, false } };
constexpr float kRowH = 40;         // name over meta (.proj__row: 7 px padding, a 2 px gap)

// The tutorial's figures at uiScale 1 (styles.css .tut__title, .tut__key kbd, .tut__dots).
constexpr float kTutTitle = 18;     // .tut__title 19 px, Segoe UI's larger face
constexpr float kTutBody = 13;      // .tut__body 13.5 px
constexpr float kKbdMinW = 74;      // .tut__key kbd min-width
constexpr float kKbdH = 22;         // 3 px padding around 12 px text plus the 2 px bottom border
constexpr float kKeyGap = 7;        // .tut__keys gap
constexpr float kDot = 7;           // .tut__dot
constexpr float kDotHit = 15;       // the press target around a dot
}  // namespace

void Ui::syncSheet(const UiModel& old) {
  (void)old;
  sheetEdit_.emit = [](const nlohmann::json& e) { App::instance().wire().sendEvent(e); };
  const SheetField* text = nullptr;
  std::string target;
  if (m_.sheet) {
    for (const SheetSection& sec : m_.sheet->sections)
      for (const SheetField& f : sec.fields)
        if (f.kind == "text" && !text) { text = &f; target = "sheet:" + m_.sheet->kind + ":" + f.id; }
  }
  // The field's revision in the model before this one: the core bumps it when
  // it sets the value itself (the Projects name clears after a save).
  int oldRev = -1;
  if (text && old.sheet)
    for (const SheetSection& sec : old.sheet->sections)
      for (const SheetField& f : sec.fields)
        if (f.kind == "text" && "sheet:" + old.sheet->kind + ":" + f.id == target) oldRev = f.rev;
  if (!text) {
    if (sheetEdit_.isOpen()) sheetEdit_.close();
  } else if (sheetEdit_.target() != target || (oldRev >= 0 && oldRev != text->rev)) {
    // The value lives in the widget while it is open; the core keeps the cleaned copy.
    bool had = sheetEdit_.target() == target && sheetEdit_.focused();
    sheetEdit_.open(target, text->text, fromUtf8(text->placeholder), text->maxLen > 0 ? (size_t)text->maxLen : 200, false);
    if (had) sheetEdit_.focus();
  }
  if (!m_.sheet) {
    sheetScroll_ = ScrollState{};
    sheetFocus_.clear();
    sheetStops_.clear();
  } else if (!old.sheet || old.sheet->kind != m_.sheet->kind) {
    sheetScroll_ = ScrollState{};
    sheetFocus_ = m_.sheet->focusField ? "sheet:" + m_.sheet->kind + ":" + *m_.sheet->focusField : "";
    if (!sheetFocus_.empty() && sheetFocus_ == sheetEdit_.target()) sheetEdit_.focus();
  }
}

bool Ui::sheetOptionDisabled(const std::string& target) const {
  if (!m_.sheet) return false;
  std::string base = "sheet:" + m_.sheet->kind + ":";
  for (const SheetSection& sec : m_.sheet->sections)
    for (const SheetField& f : sec.fields)
      for (const SheetOption& o : f.options)
        if (target == base + f.id + ":" + o.id) return o.disabled;
  for (const SheetSection& sec : m_.sheet->sections)
    for (const SheetField& f : sec.fields)
      if (f.kind == "button" && target == base + f.id) return f.disabled;
  for (const SheetButton& b : m_.sheet->buttons)
    if (target == base + "btn:" + b.id) return b.disabled;
  return false;
}

std::wstring Ui::sheetTooltip(const std::string& target) const {
  if (!m_.sheet) return L"";
  std::string base = "sheet:" + m_.sheet->kind + ":";
  for (const SheetSection& sec : m_.sheet->sections)
    for (const SheetField& f : sec.fields)
      for (const SheetOption& o : f.options)
        if (target == base + f.id + ":" + o.id) return o.tooltip ? fromUtf8(*o.tooltip) : L"";
  // The rows' titles (ProjectsPanel.tsx:223, 230; the em dash a semicolon).
  if (startsWith(target, base + "row:")) {
    auto ends = [&](const char* tail) {
      size_t n = strlen(tail);
      return target.size() > n && target.compare(target.size() - n, n, tail) == 0;
    };
    if (ends(":add")) return L"Add these tabs to this window, leaving what is open alone";
    if (ends(":open")) return L"Replace this window with the project; closes every pane open now";
  }
  return L"";
}

void Ui::viewSheet(Painter& p) {
  if (!m_.sheet || coreDead_) return;
  const SheetModel& sh = *m_.sheet;
  RECT rc{};
  if (Window::instance().body()) GetClientRect(Window::instance().body(), &rc);
  float W = (float)rc.right, H = (float)rc.bottom;
  float s = p.scale(), d = dpi();
  const std::string base = "sheet:" + sh.kind;
  const bool tutorial = sh.kind == "tutorial";

  // The dim takes every press that misses the card.
  D2D1_RECT_F all = D2D1::RectF(0, 0, W, H);
  hit(false, all, base);
  p.fillRect(all, t_.shadow, 0.4f);

  float cw = std::round(std::min((float)sh.width * d, W * sheet::kMaxWidth));
  float pad = sheet::kPad * s;
  bool regBefore = registering_;

  // The sections, laid out from y0 at the given width; paint draws and
  // registers hits clipped to the body viewport. Returns the content height.
  std::vector<std::string> stops;
  auto sections = [&](float x0, float y0, float w, bool paint, D2D1_RECT_F clip) -> float {
    float y = y0;
    auto reg = [&](D2D1_RECT_F r, const std::string& t) {
      if (!paint) return;
      D2D1_RECT_F c = clipTo(r, clip);
      if (!empty(c)) hit(false, c, t);
    };
    auto ring = [&](D2D1_RECT_F r, const std::string& t) {
      if (paint && p.live() && sheetFocus_ == t) p.strokeRect(inset(r, -2 * s, -2 * s), 0x3399FF, 1, 0.9f);
    };
    bool first = true;
    for (const SheetSection& sec : sh.sections) {
      if (!first) y += 8 * s;
      first = false;
      if (tutorial) {
        if (paint) p.text(D2D1::RectF(x0, y, x0 + w, y + 28 * s), fromUtf8(sec.title), UiFont{ kTutTitle, true }, t_.accent, Align::Left, true);
        y += 34 * s;
      } else {
        if (paint) p.text(D2D1::RectF(x0, y, x0 + w, y + 20 * s), fromUtf8(sec.title), UiFont{ 12, true }, t_.badgeText, Align::Left, true);
        y += 22 * s;
      }
      for (const SheetField& f : sec.fields) {
        std::string ft = base + ":" + f.id;
        if (tutorial && f.kind == "buttons") {
          // .tut__dots: centred, 7 DIP apart, the current one in the accent; not Tab stops.
          float gap = kDot * s, dot = std::round(kDot * s), hitW = kDotHit * s;
          float rowW = (float)f.options.size() * dot + (float)std::max<size_t>(1, f.options.size()) * gap - gap;
          y += 12 * s;
          float x = std::round(x0 + (w - rowW) / 2);
          float cy = std::round(y + hitW / 2);
          for (const SheetOption& o : f.options) {
            D2D1_RECT_F dr = D2D1::RectF(x, cy - dot / 2, x + dot, cy - dot / 2 + dot);
            std::string t = ft + ":" + o.id;
            reg(D2D1::RectF(x + dot / 2 - hitW / 2, cy - hitW / 2, x + dot / 2 + hitW / 2, cy + hitW / 2), t);
            if (paint && p.live() && dr.bottom > clip.top && dr.top < clip.bottom) {
              uint32_t c = o.selected ? t_.accent : hovered(t) ? mixRgb(t_.toastText, t_.dotTrack, 0.35f) : mixRgb(t_.toastText, t_.dotTrack, 0.12f);
              p.roundedRect(dr, kDot / 2, c, 1, 0, 0);
            }
            x += dot + gap;
          }
          y += hitW + 10 * s;
        } else if (f.kind == "buttons") {
          if (!f.label.empty()) {
            if (paint) p.text(D2D1::RectF(x0, y, x0 + w, y + sheet::kLine * s), fromUtf8(f.label), UiFont{ 12 }, t_.toastText, Align::Left, true);
            y += sheet::kLine * s + 2 * s;
          }
          float x = x0;
          for (const SheetOption& o : f.options) {
            std::wstring label = fromUtf8(o.label);
            float bw = std::ceil(p.textWidth(label, UiFont{ 11 })) + 20 * s + (o.swatch ? 14 * s : 0);
            if (x > x0 && x + bw > x0 + w) { x = x0; y += sheet::kBtnH * s + 6 * s; }
            D2D1_RECT_F r = D2D1::RectF(std::round(x), std::round(y), std::round(x + bw), std::round(y + sheet::kBtnH * s));
            std::string t = ft + ":" + o.id;
            reg(r, t);
            if (!o.disabled) stops.push_back(t);
            if (paint && p.live() && r.bottom > clip.top && r.top < clip.bottom) {
              BtnState st = o.disabled ? BtnState::Disabled : o.selected ? BtnState::Pressed : btn(t);
              p.win7Button(r, st);
              D2D1_RECT_F lr = r;
              if (o.swatch) {
                float sw = 10 * s;
                float sy = std::round((r.top + r.bottom) / 2 - sw / 2);
                D2D1_RECT_F box = D2D1::RectF(std::round(r.left + 8 * s), sy, std::round(r.left + 8 * s + sw), sy + sw);
                p.fillRect(box, hexRgb(*o.swatch, 0x808080), o.disabled ? 0.5f : 1);
                p.strokeRect(box, 0x5A5A5A, 1, 0.8f);
                lr.left = box.right;
              }
              p.text(lr, label, UiFont{ 11, o.selected && !o.disabled }, o.disabled ? t_.btnDisabledText : t_.btnText, Align::Center, true);
              ring(r, t);
            }
            x += bw + 6 * s;
          }
          y += sheet::kBtnH * s + 4 * s;
          if (!f.note.empty()) y += paragraph(p, x0, y, w, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip) + 2 * s;
          y += 8 * s;
        } else if (f.kind == "check") {
          float bx = x0, by = y + 3 * s, bs = std::round(sheet::kCheck * s);
          D2D1_RECT_F box = D2D1::RectF(std::round(bx), std::round(by), std::round(bx) + bs, std::round(by) + bs);
          float tx = box.right + 8 * s;
          D2D1_RECT_F labelR = D2D1::RectF(tx, y, x0 + w, y + sheet::kLine * s);
          float noteH = f.note.empty() ? 0 : paragraph(p, tx, y + sheet::kLine * s, x0 + w - tx, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, false, clip);
          D2D1_RECT_F row = D2D1::RectF(x0, y, x0 + w, y + sheet::kLine * s + noteH);
          reg(row, ft);
          stops.push_back(ft);
          if (paint && p.live() && row.bottom > clip.top && row.top < clip.bottom) {
            // 6.3 check box: a checkBorder (#8e8f8f) over the checkTop to checkBottom face, editFocus under the pointer.
            D2D1_GRADIENT_STOP stops2[] = { { 0.f, D2D1::ColorF(t_.checkTop) }, { 1.f, D2D1::ColorF(t_.checkBottom) } };
            p.gradientV(box, stops2, 2);
            p.strokeRect(box, hovered(ft) ? t_.editFocus : t_.checkBorder);
            if (f.check) p.glyph(box, 0x2713, t_.editText, 11);
            p.text(labelR, fromUtf8(f.label), UiFont{ 12 }, t_.toastText, Align::Left, true);
            ring(D2D1::RectF(box.left, box.top, std::min(x0 + w, tx + p.textWidth(fromUtf8(f.label), UiFont{ 12 })), box.bottom), ft);
          }
          y += sheet::kLine * s;
          if (noteH > 0) y += paragraph(p, tx, y, x0 + w - tx, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip);
          y += 8 * s;
        } else if (f.kind == "text") {
          if (!f.label.empty()) {
            if (paint) p.text(D2D1::RectF(x0, y, x0 + w, y + sheet::kLine * s), fromUtf8(f.label), UiFont{ 12 }, t_.toastText, Align::Left, true);
            y += sheet::kLine * s + 2 * s;
          }
          D2D1_RECT_F field = D2D1::RectF(std::round(x0), std::round(y), std::round(x0 + std::min(w, 360 * s)), std::round(y + 24 * s));
          reg(field, ft);
          stops.push_back(ft);
          if (paint && p.live() && field.bottom > clip.top && field.top < clip.bottom) {
            p.fillRect(field, t_.editBg);
            p.strokeRect(field, sheetEdit_.focused() ? t_.editFocus : t_.editBorder);
            if (sheetEdit_.target() == ft) sheetEdit_.draw(p, inset(field, 4 * s, 0), UiFont{ 12 }, t_.editText, false, caretOn_);
            ring(field, ft);
          }
          y += 24 * s + 4 * s;
          if (!f.note.empty()) y += paragraph(p, x0, y, w, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip);
          y += 8 * s;
        } else if (f.kind == "button" && f.text.empty()) {
          // The label is the caption: the button at the left, sized to it, the note beside it.
          std::wstring cap = fromUtf8(f.label);
          float bw = std::max(80 * s, std::ceil(p.textWidth(cap, UiFont{ 11 })) + 24 * s);
          D2D1_RECT_F b = D2D1::RectF(std::round(x0), std::round(y), std::round(x0 + bw), std::round(y + sheet::kBtnH * s));
          if (!f.disabled) {
            reg(b, ft);
            stops.push_back(ft);
          }
          if (paint && p.live() && b.bottom > clip.top && b.top < clip.bottom) {
            p.win7Button(b, f.disabled ? BtnState::Disabled : btn(ft), cap, 11);
            ring(b, ft);
          }
          float nx = b.right + 10 * s;
          float nh = f.note.empty() ? 0 : paragraph(p, nx, y, x0 + w - nx, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, false, clip);
          if (nh > 0) paragraph(p, nx, y + std::max(0.f, std::round((sheet::kBtnH * s - nh) / 2)), x0 + w - nx, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip);
          y += std::max(sheet::kBtnH * s, nh) + 8 * s;
        } else if (f.kind == "button") {
          float bw = std::max(80 * s, std::ceil(p.textWidth(fromUtf8(f.text), UiFont{ 11 })) + 24 * s);
          D2D1_RECT_F b = D2D1::RectF(std::round(x0 + w - bw), std::round(y), std::round(x0 + w), std::round(y + sheet::kBtnH * s));
          if (!f.disabled) {
            reg(b, ft);
            stops.push_back(ft);
          }
          if (paint && p.live() && b.bottom > clip.top && b.top < clip.bottom) {
            p.win7Button(b, f.disabled ? BtnState::Disabled : btn(ft), fromUtf8(f.text), 11);
            ring(b, ft);
          }
          float lw = w - bw - 12 * s;
          if (paint) p.text(D2D1::RectF(x0, y, x0 + lw, y + sheet::kLine * s), fromUtf8(f.label), UiFont{ 12 }, t_.toastText, Align::Left, true);
          float nh = f.note.empty() ? 0 : paragraph(p, x0, y + sheet::kLine * s, lw, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip);
          y += std::max(sheet::kBtnH * s, sheet::kLine * s + nh) + 8 * s;
        } else if (tutorial && f.kind == "rows") {
          // .tut__keys: each chord in a kbd box (a 2 DIP bottom border), the action beside it in badgeText.
          y += 8 * s;
          for (const SheetRow& row : f.rows) {
            std::wstring chord = fromUtf8(row.name);
            float kw = std::max(kKbdMinW * s, std::ceil(p.textWidth(chord, UiFont{ 12 })) + 16 * s);
            D2D1_RECT_F kb = D2D1::RectF(std::round(x0), std::round(y), std::round(x0 + kw), std::round(y + kKbdH * s));
            if (paint && p.live() && kb.bottom > clip.top && kb.top < clip.bottom) {
              p.roundedRect(kb, 4, t_.titleBar, 1, t_.divider, 1);
              p.fillRect(D2D1::RectF(kb.left + 2 * s, kb.bottom - std::max(1.f, std::round(p.dpiScale())), kb.right - 2 * s, kb.bottom), t_.divider);
              p.text(kb, chord, UiFont{ 12 }, t_.toastText, Align::Center, true);
              p.text(D2D1::RectF(kb.right + 12 * s, kb.top, x0 + w, kb.bottom), fromUtf8(row.meta), UiFont{ 12 }, t_.badgeText, Align::Left, true);
            }
            y += kKbdH * s + kKeyGap * s;
          }
          y += 4 * s;
        } else if (f.kind == "rows") {
          if (f.rows.empty()) y += paragraph(p, x0, y, w, fromUtf8(f.note), UiFont{ 11 }, t_.badgeText, paint, clip) + 2 * s;
          for (const SheetRow& row : f.rows) {
            const std::string rb = base + ":row:" + row.id + ":";
            float rh = std::round(kRowH * s);
            // .proj__row's 1 px top border in --line.
            D2D1_RECT_F line = D2D1::RectF(x0, std::round(y), x0 + w, std::round(y) + std::max(1.f, std::floor(p.dpiScale())));
            bool vis = paint && p.live() && y + rh > clip.top && y < clip.bottom;
            if (vis) p.fillRect(line, t_.divider, 0.6f);
            // The buttons from the right; the text takes what is left.
            const RowButton* set = row.confirming ? kRowConfirm : kRowButtons;
            int n = row.confirming ? 2 : 3;
            float bx = x0 + w;
            float by = std::round(y + (rh - sheet::kBtnH * s) / 2);
            D2D1_RECT_F rects[3];
            for (int i = n - 1; i >= 0; --i) {
              float bw = std::max(64 * s, std::ceil(p.textWidth(set[i].label, UiFont{ 11 })) + 24 * s);
              rects[i] = D2D1::RectF(std::round(bx - bw), by, std::round(bx), by + std::round(sheet::kBtnH * s));
              bx = rects[i].left - 6 * s;
            }
            for (int i = 0; i < n; i++) {
              std::string t = rb + set[i].id;
              reg(rects[i], t);
              stops.push_back(t);
            }
            if (vis) {
              float tw = std::max(0.f, bx - 6 * s - x0);
              p.text(D2D1::RectF(x0, y + 3 * s, x0 + tw, y + 21 * s), fromUtf8(row.name), UiFont{ 12, true }, t_.toastText, Align::Left, true);
              p.text(D2D1::RectF(x0, y + 21 * s, x0 + tw, y + 37 * s), fromUtf8(row.meta), UiFont{ 11 }, t_.badgeText, Align::Left, true);
              for (int i = 0; i < n; i++) {
                std::string t = rb + set[i].id;
                if (set[i].danger) {
                  // .proj__danger: the danger face and border, white text.
                  p.roundedRect(rects[i], 3, t_.danger, pressed(t) ? 0.8f : hovered(t) ? 0.9f : 1.f, t_.danger, 1);
                  p.text(rects[i], set[i].label, UiFont{ 11, true }, 0xFFFFFF, Align::Center, true);
                } else {
                  p.win7Button(rects[i], btn(t, set[i].primary), set[i].label, 11);
                }
                ring(rects[i], t);
              }
            }
            y += rh + 2 * s;
          }
          y += 6 * s;
        } else {
          UiFont nf{ tutorial ? kTutBody : 12 };
          y += paragraph(p, x0, y, w, fromUtf8(f.note.empty() ? f.label : f.note), nf, t_.toastText, paint, clip) + 8 * s;
        }
      }
    }
    return y - y0;
  };

  // Measure at the full width; with the scrollbar the text narrows, so measure again.
  float innerW = cw - 2 * pad;
  float head = sheet::kHead * s, foot = sheet::kFoot * s;
  float maxBody = std::max(40 * s, H * sheet::kMaxHeight - head - foot);
  float contentH = sections(0, 0, innerW, false, D2D1_RECT_F{});
  bool bar = contentH > maxBody;
  float barW = bar ? std::round(ScrollBar::kWidthDip * d) : 0;
  if (bar) contentH = sections(0, 0, innerW - barW - 6 * s, false, D2D1_RECT_F{});
  float bodyH = std::min(contentH, maxBody);
  float ch = head + bodyH + foot;
  D2D1_RECT_F card = D2D1::RectF(std::round(W / 2 - cw / 2), std::round(H / 2 - ch / 2), std::round(W / 2 + cw / 2), std::round(H / 2 + ch / 2));
  hit(false, card, base + ":card");
  if (p.live()) {
    p.roundedRect(D2D1::RectF(card.left + p.px(1), card.top + p.px(2), card.right + p.px(2), card.bottom + p.px(3)), t_.radius, t_.shadow, 0.18f, 0, 0);
    p.roundedRect(card, t_.radius, t_.toastBg, 1, t_.cardBorder, 1);
  }
  // The tutorial's title is its step counter, quiet as .tut__step.
  p.text(D2D1::RectF(card.left + pad, card.top + 14 * s, card.right - pad, card.top + 40 * s), fromUtf8(sh.title), UiFont{ tutorial ? 12.f : 14.f, !tutorial },
         tutorial ? t_.badgeText : t_.toastText, Align::Left, true);

  // The body, scrolled.
  D2D1_RECT_F view = D2D1::RectF(card.left + pad, card.top + head, card.right - pad, card.top + head + bodyH);
  sheetScroll_.content = contentH / d;
  sheetScroll_.viewport = bodyH / d;
  sheetScroll_.offset = ScrollBar::clampOffset(sheetScroll_.offset, sheetScroll_.content, sheetScroll_.viewport);
  float off = std::round(sheetScroll_.offset * d);
  D2D1_RECT_F clip = view;
  if (bar) clip.right = view.right - barW - 6 * s;
  if (p.live()) p.pushClip(view);
  sections(view.left, view.top - off, clip.right - clip.left, true, clip);
  if (p.live()) p.popClip();
  if (bar) {
    sheetBar_.hit = [this](D2D1_RECT_F r, const std::string& t) { hit(false, r, t); };
    sheetBar_.layout(D2D1::RectF(view.right - barW, view.top, view.right, view.bottom), d);
    sheetBar_.draw(p, sheetScroll_, hover_, "sheet:scroll");
  }

  // The bottom buttons, right-aligned; the default one carries the glow ring.
  float bx = card.right - pad;
  float by = card.bottom - 16 * s - 26 * s;
  for (auto it = sh.buttons.rbegin(); it != sh.buttons.rend(); ++it) {
    float bw = std::max(86 * s, std::ceil(p.textWidth(fromUtf8(it->label), UiFont{ 12 })) + 24 * s);
    D2D1_RECT_F b = D2D1::RectF(std::round(bx - bw), std::round(by), std::round(bx), std::round(by + 26 * s));
    std::string t = base + ":btn:" + it->id;
    hit(false, b, t);
    p.win7Button(b, it->disabled ? BtnState::Disabled : btn(t, it->isDefault), fromUtf8(it->label));
    if (p.live() && sheetFocus_ == t) p.strokeRect(inset(b, -3 * s, -3 * s), 0x3399FF, 1, 0.9f);
    bx = b.left - 10 * s;
  }
  for (const SheetButton& b : sh.buttons)
    if (!b.disabled) stops.push_back(base + ":btn:" + b.id);
  if (regBefore) sheetStops_ = std::move(stops);
}

void Ui::sheetFocusMove(int dir) {
  if (sheetStops_.empty()) return;
  auto it = std::find(sheetStops_.begin(), sheetStops_.end(), sheetFocus_);
  int n = (int)sheetStops_.size();
  int i = it == sheetStops_.end() ? (dir > 0 ? 0 : n - 1) : ((int)(it - sheetStops_.begin()) + dir + n) % n;
  sheetFocus_ = sheetStops_[(size_t)i];
  if (sheetFocus_ == sheetEdit_.target()) {
    sheetEdit_.focus();
    sheetEdit_.selectAll();
  } else if (sheetEdit_.focused()) {
    sheetEdit_.blur();
  }
  Window::instance().invalidateBody();
}

bool Ui::sheetKey(UINT msg, WPARAM w, LPARAM l, Mods m) {
  Window& win = Window::instance();
  if (msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP || msg == WM_SYSCHAR) return false;   // Alt+F4 still closes
  const std::string base = "sheet:" + m_.sheet->kind;
  if (msg == WM_KEYDOWN && w == VK_TAB) {
    sheetFocusMove(m.shift ? -1 : 1);
    return true;
  }
  if (msg == WM_CHAR && w == L'\t') return true;
  if (sheetEdit_.focused()) {
    sheetEdit_.key(msg, w, l, m, chords_);   // Enter and Escape reach the core as keys on the field
    win.invalidateBody();
    return true;
  }
  if (msg != WM_KEYDOWN) return true;
  if (w == VK_ESCAPE || w == VK_LEFT || w == VK_RIGHT) {
    // Escape closes any sheet; the tutorial steps on the arrows (Tutorial.tsx:273-291).
    const char* name = w == VK_ESCAPE ? "Escape" : w == VK_LEFT ? "ArrowLeft" : "ArrowRight";
    App::instance().wire().sendEvent({ { "type", "key" }, { "target", base }, { "key", name },
                                       { "mods", { { "ctrl", m.ctrl }, { "alt", m.alt }, { "shift", m.shift } } } });
    return true;
  }
  if (w == VK_RETURN || w == VK_SPACE) {
    std::string t = sheetFocus_;
    if (t.empty() && w == VK_RETURN)
      for (const SheetButton& b : m_.sheet->buttons)
        if (b.isDefault && !b.disabled) t = base + ":btn:" + b.id;
    if (!t.empty() && !sheetOptionDisabled(t)) send("click", t, 0, 0, 0, m);
    return true;
  }
  return true;
}

bool Ui::sheetMouse(UINT msg, POINT pt, int button, Mods mods, const std::string& target, int wheelDelta) {
  Window& win = Window::instance();
  float top = bodyTop();
  if (msg == WM_MOUSEWHEEL) {
    float before = sheetScroll_.offset;
    sheetScroll_.offset = ScrollBar::clampOffset(sheetScroll_.offset - (float)wheelDelta / WHEEL_DELTA * sheet::kWheelDip, sheetScroll_.content,
                                                 sheetScroll_.viewport);
    if (sheetScroll_.offset != before) { layout(); win.invalidateBody(); }
    return true;
  }
  if (sheetScroll_.dragging) {
    if (msg == WM_MOUSEMOVE || msg == WM_LBUTTONUP) {
      sheetBar_.mouse(msg, (float)pt.x, (float)pt.y - top, sheetScroll_, 24, "");
      if (msg == WM_LBUTTONUP && GetCapture() == win.body()) ReleaseCapture();
      layout();
      win.invalidateBody();
    }
    return true;
  }
  bool down = msg == WM_LBUTTONDOWN || msg == WM_LBUTTONDBLCLK;
  bool up = msg == WM_LBUTTONUP;
  if (down && button == 0) {
    if (startsWith(target, "sheet:scroll:")) {
      sheetBar_.mouse(msg, (float)pt.x, (float)pt.y - top, sheetScroll_, 24, target);
      if (sheetScroll_.dragging) SetCapture(win.body());
      layout();
      win.invalidateBody();
      return true;
    }
    if (!sheetEdit_.target().empty() && target == sheetEdit_.target()) {
      sheetFocus_ = target;
      sheetEdit_.focus();
      sheetEdit_.pointer((float)pt.x, mods.shift);
      if (msg == WM_LBUTTONDBLCLK) sheetEdit_.selectAll();
      win.invalidateBody();
      return true;
    }
    if (sheetEdit_.focused()) sheetEdit_.blur();
    pressed_ = target;
    pressedButton_ = 0;
    win.invalidateBody();
    return true;
  }
  if (up && button == 0) {
    std::string was = pressed_;
    pressed_.clear();
    const std::string base = "sheet:" + m_.sheet->kind;
    bool acts = was == target && (target == "sheet:close" || startsWith(target, base + ":")) && target != base + ":card" &&
                target != sheetEdit_.target() && !sheetOptionDisabled(target);
    if (acts) {
      if (std::find(sheetStops_.begin(), sheetStops_.end(), target) != sheetStops_.end()) sheetFocus_ = target;
      activate(target, mods, pt.x / dpi(), pt.y / dpi());
    }
    win.invalidateBody();
    return true;
  }
  if (msg == WM_MOUSEMOVE) return true;
  return true;
}
