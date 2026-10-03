// The Settings sheet's shell side: the terminal palette the core sends as
// UiModel.window.palette (sheets.ts paletteOverride, which runs
// xtermThemeFrom over PALETTES[key]) becomes a TermPalette for every grid.
// The sheet itself is drawn by sheet.cpp from the model alone.
#include "ui/sheet.h"
#include <cstdlib>

namespace {
bool parseHex(const std::string& s, uint32_t* out) {
  if (s.size() != 7 || s[0] != '#') return false;
  char* end = nullptr;
  unsigned long v = strtoul(s.c_str() + 1, &end, 16);
  if (!end || *end != 0) return false;
  *out = (uint32_t)v & 0xFFFFFF;
  return true;
}
}  // namespace

TermPalette termPaletteFrom(const std::map<std::string, std::string>& keys) {
  static const char* const kAnsi[16] = { "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
                                         "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
                                         "brightMagenta", "brightCyan", "brightWhite" };
  TermPalette p = kHomebrew;
  auto set = [&](const char* k, uint32_t& slot) {
    auto it = keys.find(k);
    if (it != keys.end()) parseHex(it->second, &slot);
  };
  set("background", p.bg);
  set("foreground", p.fg);
  set("cursor", p.cursor);
  set("cursorAccent", p.cursorAccent);
  set("selectionBackground", p.selection);
  for (int i = 0; i < 16; i++) set(kAnsi[i], p.ansi[i]);
  return p;
}
