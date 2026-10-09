#include "ui/edit.h"
#include "app.h"
#include "paths.h"
#include "window.h"
#include <algorithm>
#include <cwctype>

namespace {
// CF_UNICODETEXT, one line: the field never holds a line break.
std::wstring readClipboardLine() {
  bool open = false;
  for (int i = 0; i < 10 && !(open = OpenClipboard(Window::instance().hwnd()) != FALSE); i++) Sleep(10);
  if (!open) { App::log("error: OpenClipboard %lu", GetLastError()); return {}; }
  std::wstring out;
  if (HANDLE d = GetClipboardData(CF_UNICODETEXT)) {
    if (auto* p = static_cast<const wchar_t*>(GlobalLock(d))) {
      out = p;
      GlobalUnlock(d);
    }
  }
  CloseClipboard();
  // Line breaks and tabs become spaces, as a browser's single-line input does.
  for (wchar_t& c : out)
    if (c == L'\r' || c == L'\n' || c == L'\t') c = L' ';
  out.erase(std::remove_if(out.begin(), out.end(), [](wchar_t c) { return c < 0x20 || c == 0x7F; }), out.end());
  return out;
}

void writeClipboard(const std::wstring& s) {
  bool open = false;
  for (int i = 0; i < 10 && !(open = OpenClipboard(Window::instance().hwnd()) != FALSE); i++) Sleep(10);
  if (!open) { App::log("error: OpenClipboard %lu", GetLastError()); return; }
  EmptyClipboard();
  bool ok = false;
  if (HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, (s.size() + 1) * sizeof(wchar_t))) {
    if (void* p = GlobalLock(g)) {
      memcpy(p, s.c_str(), (s.size() + 1) * sizeof(wchar_t));
      GlobalUnlock(g);
      ok = SetClipboardData(CF_UNICODETEXT, g) != nullptr;
    }
    if (!ok) GlobalFree(g);
  }
  CloseClipboard();
  if (!ok) App::log("error: SetClipboardData %lu", GetLastError());
}

bool wordChar(wchar_t c) { return iswalnum(c) || c == L'_'; }
bool lowSurrogate(wchar_t c) { return c >= 0xDC00 && c <= 0xDFFF; }
}  // namespace

void EditWidget::open(const std::string& target, const std::string& valueUtf8, const std::wstring& placeholder, size_t maxLen, bool all) {
  target_ = target;
  value_ = fromUtf8(valueUtf8);
  if (maxLen && value_.size() > maxLen) value_.resize(maxLen);
  placeholder_ = placeholder;
  maxLen_ = maxLen;
  caret_ = value_.size();
  anchor_ = all ? 0 : caret_;
  scroll_ = 0;
  swallowChar_ = false;
  high_ = 0;
  focused_ = false;
}

void EditWidget::close() {
  target_.clear();
  value_.clear();
  focused_ = false;
  caret_ = anchor_ = 0;
}

void EditWidget::focus() { if (isOpen()) focused_ = true; }

void EditWidget::blur() {
  if (!focused_) return;
  focused_ = false;
  if (emit) emit({ { "type", "blur" }, { "target", target_ } });
}

std::string EditWidget::valueUtf8() const { return toUtf8(value_); }

void EditWidget::changed() {
  if (emit) emit({ { "type", "text" }, { "target", target_ }, { "text", toUtf8(value_) } });
}

void EditWidget::sendKey(const char* k, Mods m) {
  if (emit) emit({ { "type", "key" }, { "target", target_ }, { "key", k }, { "mods", { { "ctrl", m.ctrl }, { "alt", m.alt }, { "shift", m.shift } } } });
}

void EditWidget::move(size_t to, bool extend) {
  caret_ = std::min(to, value_.size());
  if (!extend) anchor_ = caret_;
}

size_t EditWidget::wordLeft(size_t i) const {
  while (i > 0 && !wordChar(value_[i - 1])) i--;
  while (i > 0 && wordChar(value_[i - 1])) i--;
  return i;
}

size_t EditWidget::wordRight(size_t i) const {
  size_t n = value_.size();
  while (i < n && !wordChar(value_[i])) i++;
  while (i < n && wordChar(value_[i])) i++;
  return i;
}

void EditWidget::erase(size_t from, size_t to) {
  from = std::min(from, value_.size());
  to = std::min(to, value_.size());
  if (to <= from) return;
  value_.erase(from, to - from);
  caret_ = anchor_ = from;
}

void EditWidget::insert(const std::wstring& s) {
  size_t from = selFrom(), to = selTo();
  std::wstring add = s;
  if (maxLen_) {
    size_t room = maxLen_ - std::min(maxLen_, value_.size() - (to - from));
    if (add.size() > room) {
      add.resize(room);
      if (!add.empty() && add.back() >= 0xD800 && add.back() <= 0xDBFF) add.pop_back();   // never half a pair
    }
  }
  if (add.empty() && from == to) return;
  value_.replace(from, to - from, add);
  caret_ = anchor_ = from + add.size();
  changed();
}

void EditWidget::selectAll() {
  anchor_ = 0;
  caret_ = value_.size();
}

void EditWidget::paste() {
  std::wstring t = readClipboardLine();
  if (!t.empty()) insert(t);
}

bool EditWidget::key(UINT msg, WPARAM w, LPARAM l, Mods m, const ChordTable& chords) {
  if (!focused_) return false;
  if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
    swallowChar_ = false;
    if (w == VK_SHIFT || w == VK_CONTROL || w == VK_MENU || w == VK_LWIN || w == VK_RWIN) return false;
    // The clipboard and select-all chords act on the field, as they do in a
    // focused input (Ctrl+Shift+V would otherwise paste into the pane).
    std::optional<std::string> cmd = chords.command(chordFromMessage(w, l, m.ctrl, m.alt, m.shift));
    bool ctrlOnly = m.ctrl && !m.alt && !m.shift;
    if (cmd && *cmd == "edit.paste") { swallowChar_ = true; paste(); return true; }
    if (cmd && *cmd == "edit.copy") { swallowChar_ = true; if (hasSelection()) writeClipboard(value_.substr(selFrom(), selTo() - selFrom())); return true; }
    if (cmd && *cmd == "edit.selectAll") { swallowChar_ = true; selectAll(); return true; }
    if (cmd && *cmd == "pane.clear") { swallowChar_ = true; return true; }   // Clear is ignored while a field has the keys
    if (msg == WM_KEYDOWN && ((ctrlOnly && (w == 'A' || w == 'C' || w == 'V' || w == 'X')) ||
                              (m.shift && !m.ctrl && w == VK_INSERT) || (m.ctrl && !m.shift && w == VK_INSERT) ||
                              (m.shift && !m.ctrl && w == VK_DELETE))) {
      swallowChar_ = true;
      if (w == 'A') selectAll();
      else if (w == 'V' || (w == VK_INSERT && m.shift)) paste();
      else if (hasSelection()) {
        writeClipboard(value_.substr(selFrom(), selTo() - selFrom()));
        if (w == 'X' || w == VK_DELETE) { erase(selFrom(), selTo()); changed(); }
      }
      return true;
    }
    if (cmd) return false;                       // every other chord still runs
    if (msg == WM_SYSKEYDOWN) return false;      // Alt+Space and the window menu
    swallowChar_ = true;
    switch (w) {
      case VK_RETURN: sendKey(m.shift ? "Shift+Enter" : "Enter", m); return true;
      case VK_ESCAPE: sendKey("Escape", m); return true;
      case VK_TAB: sendKey(m.shift ? "Shift+Tab" : "Tab", m); return true;
      case VK_LEFT: {
        if (hasSelection() && !m.shift) { move(selFrom(), false); return true; }
        size_t to = m.ctrl ? wordLeft(caret_) : caret_ - (caret_ > 0 ? 1 : 0);
        if (to > 0 && lowSurrogate(value_[to])) to--;
        move(to, m.shift);
        return true;
      }
      case VK_RIGHT: {
        if (hasSelection() && !m.shift) { move(selTo(), false); return true; }
        size_t to = m.ctrl ? wordRight(caret_) : std::min(value_.size(), caret_ + 1);
        if (to < value_.size() && lowSurrogate(value_[to])) to++;
        move(to, m.shift);
        return true;
      }
      case VK_HOME: move(0, m.shift); return true;
      case VK_END: move(value_.size(), m.shift); return true;
      case VK_BACK: {
        if (hasSelection()) { erase(selFrom(), selTo()); changed(); return true; }
        if (caret_ == 0) return true;
        size_t from = m.ctrl ? wordLeft(caret_) : caret_ - 1;
        if (!m.ctrl && from > 0 && lowSurrogate(value_[from])) from--;
        erase(from, caret_);
        changed();
        return true;
      }
      case VK_DELETE: {
        if (hasSelection()) { erase(selFrom(), selTo()); changed(); return true; }
        if (caret_ >= value_.size()) return true;
        size_t to = m.ctrl ? wordRight(caret_) : caret_ + 1;
        if (!m.ctrl && to < value_.size() && lowSurrogate(value_[to])) to++;
        erase(caret_, to);
        changed();
        return true;
      }
      default:
        break;
    }
    swallowChar_ = m.ctrl;   // Ctrl+letter types nothing; a plain key's WM_CHAR follows
    return true;             // nothing reaches the pty while the field has focus
  }
  if (msg == WM_CHAR) {
    if (swallowChar_) { swallowChar_ = false; return true; }
    wchar_t ch = (wchar_t)w;
    if (ch < 0x20 || ch == 0x7F) return true;
    if (ch >= 0xD800 && ch <= 0xDBFF) { high_ = ch; return true; }
    std::wstring units;
    if (lowSurrogate(ch)) {
      if (!high_) return true;
      units.push_back(high_);
    }
    high_ = 0;
    units.push_back(ch);
    insert(units);
    return true;
  }
  if (msg == WM_SYSCHAR) return false;
  return false;   // key ups stay with GridInput
}

void EditWidget::pointer(float x, bool extend) {
  Painter measure(nullptr, dpiScale_, uiScale_);
  float pad = measure.px(4);
  size_t i = measure.hitIndex(value_, font_, rect_.left + pad - scroll_, x);
  move(i, extend);
}

void EditWidget::draw(Painter& p, D2D1_RECT_F r, UiFont f, uint32_t textColor, bool miss, bool caretOn) {
  rect_ = r;
  font_ = f;
  dpiScale_ = p.dpiScale();
  uiScale_ = p.scale() / p.dpiScale();
  if (!p.live()) return;
  // A Win7 text box: the edit face (white under Aero), its border (the focus
  // blue when focused), a red tint when the find query has no match.
  const Tokens& t = p.tokens();
  p.fillRect(r, miss ? t.editMissBg : t.editBg);
  p.strokeRect(r, miss ? t.editMissBorder : focused_ ? t.editFocus : t.editBorder);
  float pad = p.px(4);
  D2D1_RECT_F inner = D2D1::RectF(r.left + pad, r.top + 1, r.right - pad, r.bottom - 1);
  float width = inner.right - inner.left;
  float cx = p.caretX(value_, f, caret_);
  if (cx - scroll_ > width) scroll_ = cx - width;
  if (cx - scroll_ < 0) scroll_ = cx;
  float full = p.textWidth(value_, f);
  if (full - scroll_ < width) scroll_ = std::max(0.f, full - width);
  p.pushClip(inner);
  if (value_.empty()) {
    if (!placeholder_.empty()) p.text(inner, placeholder_, f, t.editPlaceholder, Align::Left, true);
  } else {
    D2D1_RECT_F tr = D2D1::RectF(inner.left - scroll_, inner.top, inner.left - scroll_ + full + p.px(8), inner.bottom);
    if (hasSelection() && focused_) {
      float a = p.caretX(value_, f, selFrom()), b = p.caretX(value_, f, selTo());
      D2D1_RECT_F sr = D2D1::RectF(tr.left + a, inner.top + 1, tr.left + b, inner.bottom - 1);
      p.text(tr, value_, f, textColor, Align::Left, false);
      p.fillRect(sr, 0x3399FF);
      p.pushClip(sr);
      p.text(tr, value_, f, 0xFFFFFF, Align::Left, false);
      p.popClip();
    } else {
      p.text(tr, value_, f, textColor, Align::Left, false);
    }
  }
  if (focused_ && caretOn) {
    float x = std::round(inner.left - scroll_ + cx);
    p.fillRect(D2D1::RectF(x, inner.top + p.px(3), x + std::max(1.f, std::round(p.dpiScale())), inner.bottom - p.px(3)), textColor);
  }
  p.popClip();
}
