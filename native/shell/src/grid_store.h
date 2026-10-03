// The cells one pane's Grid mirrors out of libvterm: the screen rows plus up to
// `scrollback` rows above them. The renderer, find, selection and path click
// read it; only Grid mutates it.
//
// Absolute rows: 0 is the top screen row, rows() - 1 the bottom one, -1 the
// newest scrollback row, -scrollbackLen() the oldest.
//
// Screen rows hold cols() cells. Scrollback rows are packed (a few bytes a
// cell, so 20000 rows of 110 columns stay inside the 12 MB budget) and row()
// unpacks them into a small ring: a reference to a scrollback row stays valid
// for the next kDecodeSlots row() calls and until the next mutation.
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <vector>

// Colors: kColorDefault (the theme's fg or bg), kColorPalette | index (0..255,
// the theme resolves 0..15), or 0x00RRGGBB.
constexpr uint32_t kColorDefault = 0xFF000000u;
constexpr uint32_t kColorPalette = 0xFE000000u;
inline bool colorIsPalette(uint32_t c) { return (c & 0xFF000000u) == kColorPalette; }

// dim is SGR 2 (faint), kept by the libvterm patch in PATCHES.md.
struct CellAttrs {
  uint32_t fg = kColorDefault, bg = kColorDefault;
  uint8_t bold : 1, italic : 1, underline : 2, strike : 1, reverse : 1, blink : 1, dim : 1;
  uint16_t uri = 0;   // OSC 8 link id, 0 = none; Grid::uriAt resolves it
  CellAttrs() : bold(0), italic(0), underline(0), strike(0), reverse(0), blink(0), dim(0) {}
  bool operator==(const CellAttrs& o) const {
    return fg == o.fg && bg == o.bg && bold == o.bold && italic == o.italic && underline == o.underline &&
           strike == o.strike && reverse == o.reverse && blink == o.blink && dim == o.dim && uri == o.uri;
  }
  bool operator!=(const CellAttrs& o) const { return !(*this == o); }
};

// A cluster of up to two codepoints sits in chars. A longer one (a ZWJ emoji
// sequence) keeps its first codepoint in chars[0] and an index into the
// store's cluster table in chars[1]; GridStore::chars() returns all of them.
struct Cell {
  uint32_t chars[2] = { 0, 0 };
  uint8_t nchars = 0;   // 0 = blank
  uint8_t width = 1;    // 0 = continuation of a wide cell
  CellAttrs a;
};

struct Row {
  std::vector<Cell> cells;   // screen rows: cols() cells; scrollback rows: trimmed to the last non-blank
  bool wrapped = false;      // continues on the next row
};

class GridStore {
public:
  static constexpr size_t kDecodeSlots = 128;
  // Interned clusters are never freed, so their number is capped: Unicode has
  // a few thousand emoji sequences, while random combining marks (zalgo text)
  // would otherwise grow the table without bound. Past the cap a long cluster
  // keeps its first two codepoints (and its width).
  static constexpr size_t kMaxClusters = 16384;

  explicit GridStore(size_t maxScrollback = 20000) : maxScrollback_(maxScrollback) {}
  void setSize(int cols, int rows);
  int cols() const { return cols_; }
  int rows() const { return rows_; }
  size_t scrollbackLen() const { return sb_.size(); }   // rows above the screen, at most maxScrollback
  const Row& row(long absRow) const;                    // absRow in [-scrollbackLen, rows); an empty row outside
  std::string text(long absRow) const;                  // UTF-8, trailing blanks trimmed
  // Joins absRow's wrapped run of rows into one line, every row padded to
  // cols() (cellmap.ts assembleLogicalLine). firstRow gets the run's first
  // absolute row; cellIndexOfChar gets, per UTF-16 code unit of the line, the
  // cell it came from as rowOffset * cols() + col.
  std::string logicalLine(long absRow, long* firstRow, std::vector<int>* cellIndexOfChar) const;
  // Every codepoint of a cell (a long cluster comes out of the cluster table).
  int chars(const Cell& c, uint32_t* out, int max) const;
  // Stores a cluster of n codepoints into c (the table takes the long ones).
  void setChars(Cell& c, const uint32_t* cps, int n);

  // mutation, from Grid only
  Row& screenRow(int r);
  void pushScrollback(Row&& r, bool continuation);   // continuation: r continues the row above it
  bool popScrollback(Row& out);                      // the newest scrollback row back onto the screen
  void clearScrollback();
  void setNewestScrollbackWrapped(bool wrapped);     // screen row 0 continues the newest scrollback row
  // Rewraps the scrollback to cols (libvterm reflows only the screen; xterm.js
  // reflows everything). Rows that fit and join nothing are kept as they are.
  void reflowScrollback(int cols);
  size_t bytes() const;                              // scrollback plus screen, for the 12 MB budget check

private:
  struct Packed { std::string data; uint16_t ncells = 0; bool wrapped = false; };
  Packed pack(const Row& r) const;
  Row unpack(const Packed& p) const;
  size_t packedCost(const Packed& p) const { return sizeof(Packed) + p.data.capacity() + 16; }

  int cols_ = 0, rows_ = 0;
  size_t maxScrollback_;
  std::vector<Row> screen_;
  std::deque<Packed> sb_;
  uint64_t firstSerial_ = 0;   // serial of sb_.front(); a row keeps its serial until it leaves
  size_t sbBytes_ = 0;
  std::vector<std::u32string> clusters_;
  std::map<std::u32string, uint32_t> clusterIds_;
  struct Slot { uint64_t serial = UINT64_MAX; Row row; };
  mutable std::vector<Slot> decoded_;
  mutable size_t nextSlot_ = 0;
  Row empty_;
};
