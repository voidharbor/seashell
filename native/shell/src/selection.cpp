#include "selection.h"
#include "grid_store.h"
#include <algorithm>
#include <cwctype>
#include <vector>

namespace {
void appendUtf8(std::string& s, uint32_t cp) {
  if (cp < 0x80) {
    s += (char)cp;
  } else if (cp < 0x800) {
    s += (char)(0xC0 | (cp >> 6));
    s += (char)(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    s += (char)(0xE0 | (cp >> 12));
    s += (char)(0x80 | ((cp >> 6) & 0x3F));
    s += (char)(0x80 | (cp & 0x3F));
  } else {
    s += (char)(0xF0 | (cp >> 18));
    s += (char)(0x80 | ((cp >> 12) & 0x3F));
    s += (char)(0x80 | ((cp >> 6) & 0x3F));
    s += (char)(0x80 | (cp & 0x3F));
  }
}

enum CharClass { kSpace, kWord, kOther };

// The first codepoint of the cell at col (0 for a blank or a column past the
// row's trimmed end); a wide cell's continuation reports its lead.
uint32_t leadAt(const Row& row, int col) {
  if (col < 0 || col >= (int)row.cells.size()) return 0;
  while (col > 0 && row.cells[col].width == 0) col--;
  const Cell& c = row.cells[col];
  return c.nchars ? c.chars[0] : 0;
}

CharClass classOf(uint32_t cp) {
  if (cp == 0 || cp == ' ' || cp == '\t') return kSpace;
  if (cp < 0x80) {
    if ((cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') || (cp >= '0' && cp <= '9')) return kWord;
    return (cp == '_' || cp == '-' || cp == '.' || cp == '/' || cp == '~' || cp == ':') ? kWord : kOther;
  }
  // Letters and digits outside ASCII (accented names, CJK) count as word characters.
  return (cp <= 0xFFFF && (iswalnum((wint_t)cp) || iswalpha((wint_t)cp))) || cp > 0xFFFF ? kWord : kOther;
}
}  // namespace

bool Selection::empty() const { return !active || (startRow == endRow && startCol == endCol); }

void Selection::ordered(long* r0, int* c0, long* r1, int* c1) const {
  bool swap = startRow > endRow || (startRow == endRow && startCol > endCol);
  *r0 = swap ? endRow : startRow; *c0 = swap ? endCol : startCol;
  *r1 = swap ? startRow : endRow; *c1 = swap ? startCol : endCol;
}

std::string Selection::text(const GridStore& store) const {
  if (empty()) return {};
  long r0, r1;
  int c0, c1;
  ordered(&r0, &c0, &r1, &c1);
  r0 = std::max(r0, -(long)store.scrollbackLen());
  r1 = std::min(r1, (long)store.rows() - 1);
  std::string out;
  uint32_t cps[16];
  for (long r = r0; r <= r1; r++) {
    // Copy what is needed now: a scrollback reference lives only for a few row() calls.
    const Row& row = store.row(r);
    bool wrapped = row.wrapped;
    int a = r == r0 ? c0 : 0, e = r == r1 ? c1 : store.cols();
    std::string line;
    for (int col = std::max(0, a); col < e; col++) {
      if (col >= (int)row.cells.size()) { line += ' '; continue; }
      const Cell& c = row.cells[col];
      if (c.width == 0) continue;   // the right half of a wide character
      if (!c.nchars) { line += ' '; continue; }
      int n = store.chars(c, cps, 16);
      for (int i = 0; i < n; i++) appendUtf8(line, cps[i]);
    }
    bool last = r == r1;
    if (!wrapped || last) {
      while (!line.empty() && line.back() == ' ') line.pop_back();
    }
    out += line;
    if (!last && !wrapped) out += '\n';
  }
  return out;
}

void Selection::selectWord(const GridStore& store, long row, int col) {
  const Row& rw = store.row(row);
  std::vector<uint32_t> leads(store.cols());
  for (int c = 0; c < store.cols(); c++) leads[c] = leadAt(rw, c);
  if (col < 0 || col >= store.cols()) { active = false; return; }
  // A click on the right half of a wide character means the character.
  while (col > 0 && col < (int)rw.cells.size() && rw.cells[col].width == 0) col--;
  CharClass k = classOf(leads[col]);
  int a = col, e = col + 1;
  if (k != kOther) {
    while (a > 0 && classOf(leads[a - 1]) == k) a--;
    while (e < store.cols() && classOf(leads[e]) == k) e++;
  } else if (col + 1 < (int)rw.cells.size() && rw.cells[col + 1].width == 0) {
    e = col + 2;
  }
  startRow = endRow = row;
  startCol = a;
  endCol = e;
  active = true;
}

void Selection::selectLine(const GridStore& store, long row) {
  long first = -(long)store.scrollbackLen(), last = store.rows() - 1;
  if (row < first || row > last) { active = false; return; }
  long a = row, e = row;
  while (a > first && store.row(a - 1).wrapped) a--;
  while (e < last && store.row(e).wrapped) e++;
  startRow = a; startCol = 0;
  endRow = e; endCol = store.cols();
  active = true;
}

void Selection::selectAll(const GridStore& store) {
  startRow = -(long)store.scrollbackLen(); startCol = 0;
  endRow = store.rows() - 1; endCol = store.cols();
  active = true;
}

void Selection::shift(long rows, const GridStore& store) {
  if (!active || rows == 0) return;
  startRow -= rows;
  endRow -= rows;
  long first = -(long)store.scrollbackLen();
  if (std::max(startRow, endRow) < first) { active = false; return; }
  if (startRow < first) { startRow = first; startCol = 0; }
  if (endRow < first) { endRow = first; endCol = 0; }
}
