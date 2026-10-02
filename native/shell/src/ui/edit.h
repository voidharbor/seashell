// A single-line edit widget drawn by the Painter: the find query and the tab
// rename field. The value lives here while the widget is open (the core keeps
// a copy from each `text` event); keys arrive only while it has focus.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <functional>
#include <string>
#include "chords.h"
#include "ui/painter.h"

struct Mods { bool ctrl = false, alt = false, shift = false; };

class EditWidget {
public:
  // Opens on `target` with a value; the caret goes to the end, or everything
  // is selected. No event is sent.
  void open(const std::string& target, const std::string& valueUtf8, const std::wstring& placeholder, size_t maxLen, bool selectAll);
  void close();                                  // gone without a blur (the core closed it)
  bool isOpen() const { return !target_.empty(); }
  const std::string& target() const { return target_; }
  bool focused() const { return focused_; }
  void focus();                                  // the widget takes the keys
  void blur();                                   // emits ui:event blur when it had focus
  // WM_KEYDOWN, WM_SYSKEYDOWN, WM_CHAR, WM_KEYUP while focused. True when
  // consumed; false lets a chord (or a key up) go on to GridInput.
  bool key(UINT msg, WPARAM w, LPARAM l, Mods m, const ChordTable& chords);
  void pointer(float x, bool extend);            // a press in the field: the caret to x (device pixels)
  void selectAll();
  void paste();                                  // the clipboard's text at the caret
  void draw(Painter& p, D2D1_RECT_F r, UiFont f, uint32_t textColor, bool miss, bool caretOn);
  std::string valueUtf8() const;
  std::function<void(const nlohmann::json&)> emit;   // Wire::sendEvent

private:
  void insert(const std::wstring& s);
  void erase(size_t from, size_t to);
  bool hasSelection() const { return caret_ != anchor_; }
  size_t selFrom() const { return caret_ < anchor_ ? caret_ : anchor_; }
  size_t selTo() const { return caret_ < anchor_ ? anchor_ : caret_; }
  void move(size_t to, bool extend);
  size_t wordLeft(size_t i) const;
  size_t wordRight(size_t i) const;
  void changed();                                // emits ui:event text
  void sendKey(const char* k, Mods m);

  std::string target_;
  std::wstring value_, placeholder_;
  size_t maxLen_ = 0, caret_ = 0, anchor_ = 0;
  bool focused_ = false;
  bool swallowChar_ = false;                     // the WM_CHAR of a key already handled on WM_KEYDOWN
  wchar_t high_ = 0;                             // a high surrogate waiting for its low half
  float scroll_ = 0;                             // device pixels the text is shifted left to show the caret
  D2D1_RECT_F rect_{};                           // where it was last drawn, for pointer()
  UiFont font_{};
  float dpiScale_ = 1, uiScale_ = 1;
};
