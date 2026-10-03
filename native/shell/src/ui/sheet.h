// Sheets (Phase 2 Task 12; native design spec section 7): one card over the
// dimmed window, drawn from UiModel.sheet by Ui::viewSheet (sheet.cpp), with
// its keys in Ui::sheetKey and its pointer in Ui::sheetMouse. The Settings
// sheet's shell side, the terminal palette, is settings.cpp.
#pragma once
#include <map>
#include <string>
#include "palette.h"

// Layout figures at uiScale 1 (redesign spec 6.3 cards and dialogs; the
// renderer's .sheet__card).
namespace sheet {
constexpr float kPad = 18;          // the card's inner margin
constexpr float kHead = 46;         // the title row
constexpr float kFoot = 56;         // the bottom button row
constexpr float kBtnH = 24;         // an option button
constexpr float kCheck = 13;        // the Win7 check box
constexpr float kLine = 20;         // one line of label
constexpr float kWheelDip = 60;     // one wheel notch
constexpr float kMaxHeight = 0.82f; // .sheet__card max-height: 82%
constexpr float kMaxWidth = 0.88f;  // .sheet__card width: min(620px, 88%)
}  // namespace sheet

// UiModel.window.palette (xterm ITheme keys: background, foreground, cursor,
// cursorAccent, selectionBackground and the sixteen ANSI names) over the
// Homebrew table; unknown keys and malformed colours are ignored.
TermPalette termPaletteFrom(const std::map<std::string, std::string>& keys);
