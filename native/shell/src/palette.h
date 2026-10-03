// The terminal palettes, as 0x00RRGGBB. The Homebrew table is
// src/renderer/term/palette.ts:37-61 (TERMINAL_APP_PALETTE); the overrides
// follow xtermThemeFrom (palette.ts:79-95), which re-points nine slots at a
// palette's tokens from src/renderer/theme/tokens.ts:515-528 (PALETTES).
#pragma once
#include <cstdint>
#include <string>

struct TermPalette {
  uint32_t bg, fg, cursor, cursorAccent, selection;
  uint32_t ansi[16];   // black red green yellow blue magenta cyan white, then the bright eight
};

// palette.ts:37-61. 'Theme native' is this table: the terminal stays Homebrew
// (redesign spec decision 6).
constexpr TermPalette kHomebrew = {
  0x000000, 0x28FE14, 0x38FE27, 0x000000, 0x255A1E,
  { 0x000000, 0xC23621, 0x25BC24, 0xADAD27, 0x492EE1, 0xD338D3, 0x33BBC8, 0xCBCCCD,
    0x818383, 0xFC391F, 0x31E722, 0xEAEC23, 0x5833FF, 0xF935F8, 0x14F0F0, 0xE9EBEB },
};

// xtermThemeFrom (palette.ts:79-95): bg = --termBg, fg = cursor = --termFg,
// cursorAccent = --termBg, green/cyan/yellow/red/blue/magenta from --g --c --y
// --r --b --m, brightBlack from --gr; every other slot keeps Homebrew's.
constexpr TermPalette paletteOverride(uint32_t termBg, uint32_t termFg, uint32_t g, uint32_t c, uint32_t y,
                                      uint32_t r, uint32_t b, uint32_t m, uint32_t gr) {
  return TermPalette{
    termBg, termFg, termFg, termBg, kHomebrew.selection,
    { kHomebrew.ansi[0], r, g, y, b, m, c, kHomebrew.ansi[7],
      gr, kHomebrew.ansi[9], kHomebrew.ansi[10], kHomebrew.ansi[11],
      kHomebrew.ansi[12], kHomebrew.ansi[13], kHomebrew.ansi[14], kHomebrew.ansi[15] },
  };
}

// tokens.ts:516 solar, 517 amber, 518 ice (PALETTES).
constexpr TermPalette kSolar = paletteOverride(0x04212b, 0x93a1a1, 0x859900, 0x2aa198, 0xb58900, 0xdc322f, 0x268bd2, 0x6c71c4, 0x586e75);
constexpr TermPalette kAmber = paletteOverride(0x140f04, 0xffb000, 0xffb000, 0xe09400, 0xffd171, 0xff7b3d, 0xc98a1f, 0xffc94d, 0x8a6216);
constexpr TermPalette kIce = paletteOverride(0x0b1016, 0xd6e2ee, 0x8fd6a8, 0x8fc8dd, 0xe6cf8f, 0xe08b8b, 0x89a9dc, 0xb7a4dd, 0x6b7885);

// The PaletteKey names of tokens.ts ('native' | 'solar' | 'amber' | 'ice');
// anything else is native.
inline const TermPalette& paletteFor(const std::string& key) {
  if (key == "solar") return kSolar;
  if (key == "amber") return kAmber;
  if (key == "ice") return kIce;
  return kHomebrew;
}

// Search decorations (native design spec section 5): matches in the selection
// green, the active match in blue.
constexpr uint32_t kFindMatch = 0x255A1E;
constexpr uint32_t kFindActive = 0x3C5A8A;

// Text at half opacity over a background, channel by channel: how xterm.js
// (addon-webgl, DIM_OPACITY 0.5) draws SGR 2 faint text.
inline uint32_t blendHalf(uint32_t fg, uint32_t bg) {
  uint32_t out = 0;
  for (int shift = 0; shift <= 16; shift += 8) out |= ((((fg >> shift) & 0xFF) + ((bg >> shift) & 0xFF)) / 2) << shift;
  return out;
}

// xterm's 256-color table above the 16 the theme owns: the 6x6x6 cube
// (levels 0, 95, 135, 175, 215, 255) and 24 grays from 8 in steps of 10.
inline uint32_t xterm256(int idx, const TermPalette& p) {
  if (idx < 16) return p.ansi[idx < 0 ? 0 : idx];
  if (idx < 232) {
    static const uint8_t lv[6] = { 0, 95, 135, 175, 215, 255 };
    int i = idx - 16;
    return (uint32_t)lv[i / 36] << 16 | (uint32_t)lv[(i / 6) % 6] << 8 | lv[i % 6];
  }
  uint32_t g = 8 + 10 * (uint32_t)(idx - 232);
  return g << 16 | g << 8 | g;
}
