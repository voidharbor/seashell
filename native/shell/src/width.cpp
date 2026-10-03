#include "width.h"

#include <utf8proc.h>

extern "C" {
#include <vterm.h>
// Defined in native/third_party/libvterm/src/unicode.c (see PATCHES.md).
extern int (*vterm_width_hook)(uint32_t cp);
extern int (*vterm_combining_hook)(uint32_t cp, uint32_t prev);
extern int (*vterm_glyph_width_hook)(const uint32_t* chars, int n);
}

static bool isRegional(uint32_t cp) { return cp >= 0x1F1E6 && cp <= 0x1F1FF; }

// The regional-indicator toggle. libvterm asks about codepoints in order, but
// asks about the codepoint that ended a cluster twice (once to end it, once
// more after measuring it), so an identical question with a glyph measured in
// between is a repeat and gets the same answer.
static thread_local bool riOpen = false;            // the last RI seen started a pair
static thread_local uint32_t lastCp = 0, lastPrev = 0;
static thread_local int lastAnswer = 0;
static thread_local bool measuredSince = false;

// Override to rule 5, needed by corpus line 159 (U+1FAE0 melting face) and
// line 176 (U+1F321 thermometer): addon-unicode-graphemes 0.4 gives these
// codepoints one cell (text presentation, or newer than its tables). The list
// is the addon's own wcwidth over U+1F300..U+1FAFF, skin tones left out.
// clang-format off
static const uint32_t XTERM_NARROW_EMOJI[][2] = {
  {0x1F321, 0x1F32C}, {0x1F336, 0x1F336}, {0x1F37D, 0x1F37D}, {0x1F394, 0x1F39F},
  {0x1F3CB, 0x1F3CE}, {0x1F3D4, 0x1F3DF}, {0x1F3F1, 0x1F3F3}, {0x1F3F5, 0x1F3F7},
  {0x1F43F, 0x1F43F}, {0x1F441, 0x1F441}, {0x1F4FD, 0x1F4FE}, {0x1F53E, 0x1F54A},
  {0x1F54F, 0x1F54F}, {0x1F568, 0x1F579}, {0x1F57B, 0x1F594}, {0x1F597, 0x1F5A3},
  {0x1F5A5, 0x1F5FA}, {0x1F650, 0x1F67F}, {0x1F6C6, 0x1F6CB}, {0x1F6CD, 0x1F6CF},
  {0x1F6D3, 0x1F6D4}, {0x1F6D8, 0x1F6EA}, {0x1F6ED, 0x1F6F3}, {0x1F6FD, 0x1F7DF},
  {0x1F7EC, 0x1F90B}, {0x1F93B, 0x1F93B}, {0x1F946, 0x1F946}, {0x1F979, 0x1F979},
  {0x1F9CC, 0x1F9CC}, {0x1FA00, 0x1FA6F}, {0x1FA75, 0x1FA77}, {0x1FA7B, 0x1FA7F},
  {0x1FA87, 0x1FA8F}, {0x1FAA9, 0x1FAAF}, {0x1FAB7, 0x1FABF}, {0x1FAC3, 0x1FACF},
  {0x1FAD7, 0x1FAFF},
};
// clang-format on

static bool inTable(uint32_t cp, const uint32_t (*table)[2], size_t n) {
  size_t lo = 0, hi = n;
  while (lo < hi) {
    size_t mid = (lo + hi) / 2;
    if (cp < table[mid][0]) hi = mid;
    else if (cp > table[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// Hangul conjoining jamo, for UAX29 GB6 to GB8.
static bool isJamoL(uint32_t cp) { return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0xA960 && cp <= 0xA97C); }
static bool isJamoV(uint32_t cp) { return (cp >= 0x1160 && cp <= 0x11A7) || (cp >= 0xD7B0 && cp <= 0xD7C6); }
static bool isJamoT(uint32_t cp) { return (cp >= 0x11A8 && cp <= 0x11FF) || (cp >= 0xD7CB && cp <= 0xD7FB); }
static bool isSyllable(uint32_t cp) { return cp >= 0xAC00 && cp <= 0xD7A3; }
static bool isSyllableLV(uint32_t cp) { return isSyllable(cp) && (cp - 0xAC00) % 28 == 0; }

int seashell_width(uint32_t cp) {
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  // Box drawing and blocks: EastAsianWidth is A or N, and xterm.js draws both
  // as one cell (ambiguousCharsAreWide is false). Corpus line 316 holds the
  // whole range; utf8proc gives every one of them 1 today, so this guards that
  // line against an ambiguous-wide utf8proc rather than changing a width.
  if (cp >= 0x2500 && cp <= 0x259F) return 1;
  // xterm.js counts U+FE0F as wide (UnicodeGraphemeProvider.charProperties:
  // "Treat emoji_presentation_selector as WIDE"). Needed by corpus line 179
  // (U+2764 U+FE0F: two cells, one without this) and by lines 180 to 198.
  if (cp == 0xFE0F) return 2;
  // Rule 5: emoji presentation; xterm.js's Unicode tables mark the
  // pictographs here East Asian Wide, less the narrow list above.
  if (cp >= 0x1F300 && cp <= 0x1FAFF)
    return inTable(cp, XTERM_NARROW_EMOJI, sizeof(XTERM_NARROW_EMOJI) / sizeof(XTERM_NARROW_EMOJI[0])) ? 1 : 2;
  int w = utf8proc_charwidth((utf8proc_int32_t)cp);
  // xterm.js gives every non-wide codepoint one cell, zero-width ones included,
  // when they do not join a cluster (charProperties: w < 2 becomes 1). Needed
  // by corpus line 317 (U+0301 at the start of a line, with nothing to join).
  return w >= 2 ? 2 : 1;
}

int seashell_is_combining(uint32_t cp, uint32_t prev) {
  // Rule 1: after a ZWJ the next codepoint stays in the cluster (UAX29 GB11,
  // which xterm.js applies through UC.shouldJoin), so ZWJ sequences keep the
  // first emoji's cells.
  if (prev == 0x200D) {
    riOpen = false;
    lastCp = cp, lastPrev = prev, lastAnswer = 1, measuredSince = false;
    return 1;
  }
  // Rule 3, regional indicators: xterm.js joins exactly two into a flag
  // (GRAPHEME_BREAK_SAW_Regional_Pair), so the second of each pair joins.
  if (isRegional(cp)) {
    if (isRegional(prev)) {
      if (cp == lastCp && prev == lastPrev && measuredSince) {
        measuredSince = false;
        return lastAnswer;
      }
      int answer = riOpen ? 1 : 0;
      riOpen = !riOpen;
      lastCp = cp, lastPrev = prev, lastAnswer = answer, measuredSince = false;
      return answer;
    }
    riOpen = true;
    lastCp = cp, lastPrev = prev, lastAnswer = 0, measuredSince = false;
    return 0;
  }
  riOpen = false;
  lastCp = cp, lastPrev = prev, measuredSince = false;
  int answer = 0;
  // Rule 2: ZWJ, the variation selectors, skin tones and tag characters are
  // Grapheme_Cluster_Break Extend or ZWJ, which xterm.js joins (GB9).
  if (cp == 0x200D || cp == 0xFE0E || cp == 0xFE0F || (cp >= 0x1F3FB && cp <= 0x1F3FF) ||
      (cp >= 0xE0020 && cp <= 0xE007F))
    answer = 1;
  // Override needed by corpus lines 97 and 98 (L V T jamo sequences): xterm.js
  // joins conjoining jamo into one syllable (UAX29 GB6 to GB8), and utf8proc
  // gives the V and T jamo a width of 1, so rule 4 alone misses them.
  else if ((isJamoL(prev) && (isJamoL(cp) || isJamoV(cp) || isSyllable(cp))) ||
           ((isSyllableLV(prev) || isJamoV(prev)) && (isJamoV(cp) || isJamoT(cp))) ||
           (((isSyllable(prev) && !isSyllableLV(prev)) || isJamoT(prev)) && isJamoT(cp)))
    answer = 1;
  // Rule 4: zero-width marks (Mn, Me, and the like) are Extend and join (GB9);
  // below U+0300 a zero width means a control, which never joins.
  else if (cp >= 0x300 && utf8proc_get_property((utf8proc_int32_t)cp)->charwidth == 0)
    answer = 1;
  lastAnswer = answer;
  return answer;
}

int seashell_glyph_width(const uint32_t* chars, int n) {
  measuredSince = true;
  // xterm.js gives a joined cluster the widest of its members (charProperties:
  // "if (oldWidth > w) w = oldWidth"), and a regional pair two cells.
  int w = seashell_width(chars[0]);
  for (int i = 1; i < n; i++) {
    int m = seashell_width(chars[i]);
    if (m > w) w = m;
  }
  if (n >= 2 && isRegional(chars[0]) && isRegional(chars[1])) w = 2;
  return w;
}

// The per-codepoint hook libvterm still calls outside clusters.
static int widthHook(uint32_t cp) { return seashell_width(cp); }

void seashell_install_width_hooks() {
  vterm_width_hook = widthHook;
  vterm_combining_hook = seashell_is_combining;
  vterm_glyph_width_hook = seashell_glyph_width;
}

std::vector<int> seashell_cluster_widths(const std::string& utf8) {
  seashell_install_width_hooks();
  const int rows = 4, cols = 200;
  VTerm* vt = vterm_new(rows, cols);
  vterm_set_utf8(vt, 1);
  VTermScreen* screen = vterm_obtain_screen(vt);
  vterm_screen_reset(screen, 1);
  vterm_input_write(vt, utf8.data(), utf8.size());
  std::vector<int> out;
  for (int col = 0; col < cols;) {
    VTermScreenCell cell{};
    if (!vterm_screen_get_cell(screen, VTermPos{0, col}, &cell)) break;
    if (cell.chars[0] == 0) {
      col++;
      continue;
    }
    out.push_back(cell.width);
    col += cell.width > 0 ? cell.width : 1;
  }
  vterm_free(vt);
  return out;
}
