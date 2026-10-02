#include "find.h"
#include <algorithm>
#include <cwctype>
#include <regex>

namespace {
struct Pos {
  long row; int col;
  bool operator<(const Pos& o) const { return row < o.row || (row == o.row && col < o.col); }
  bool operator<=(const Pos& o) const { return !(o < *this); }
};
struct Match { Pos start; Pos end; };   // end: the last row and its exclusive column

// UTF-16 code units held in wchar_t (the search runs on code units, as the
// addon's JavaScript strings do), so the cell index lines up on every compiler.
void putUtf16(std::wstring& s, uint32_t cp) {
  if (cp >= 0x10000) {
    cp -= 0x10000;
    s.push_back((wchar_t)(0xD800 + (cp >> 10)));
    s.push_back((wchar_t)(0xDC00 + (cp & 0x3FF)));
  } else {
    s.push_back((wchar_t)cp);
  }
}

std::wstring utf16(const std::string& s) {
  std::wstring out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = (unsigned char)s[i];
    uint32_t cp;
    int n;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; n = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; n = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; n = 4; }
    else { out.push_back(0xFFFD); i++; continue; }
    if (i + n > s.size()) { out.push_back(0xFFFD); break; }
    for (int k = 1; k < n; k++) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3F);
    putUtf16(out, cp);
    i += n;
  }
  return out;
}

void lower(std::wstring& s) {
  for (wchar_t& c : s) c = (wchar_t)towlower((wint_t)c);
}

// One logical line as the addon sees it (translateBufferLineToString): every
// row but the last padded to the full width, the last trimmed. cell[i] is the
// code unit's cell as rowOffset * cols + col; wide[i] marks a two-column cell.
struct Line {
  long first = 0;
  std::wstring text;
  std::vector<int> cell;
  std::vector<uint8_t> wide;
};

long buildLine(const GridStore& st, long first, Line& ln) {
  ln.first = first;
  ln.text.clear();
  ln.cell.clear();
  ln.wide.clear();
  int cols = st.cols();
  uint32_t cps[16];
  long r = first;
  for (long off = 0; r < st.rows(); r++, off++) {
    const Row& rw = st.row(r);
    for (int col = 0; col < cols; col++) {
      int n = 0;
      uint8_t w = 1;
      if (col < (int)rw.cells.size()) {
        const Cell& c = rw.cells[(size_t)col];
        if (c.width == 0) continue;
        w = c.width;
        if (c.nchars > 0) n = st.chars(c, cps, 16);
      }
      if (n == 0) { cps[0] = ' '; n = 1; }
      for (int k = 0; k < n; k++) {
        size_t before = ln.text.size();
        putUtf16(ln.text, cps[k]);
        for (size_t u = before; u < ln.text.size(); u++) {
          ln.cell.push_back((int)off * cols + col);
          ln.wide.push_back(w);
        }
      }
    }
    if (!rw.wrapped) break;
  }
  size_t end = ln.text.size();
  while (end > 0 && ln.text[end - 1] == L' ') end--;
  ln.text.resize(end);
  return std::min(r, (long)st.rows() - 1);   // the line's last row
}
}

Finder::Result Finder::find(const GridStore& st, const std::string& query, Options opt, bool forward, long anchorRow, int anchorCol) {
  decor_ = FindDecor{};
  activeRow_ = LONG_MIN;
  Result miss{ 0, 0, false, true };
  std::wstring q = utf16(query);
  int cols = st.cols();
  if (q.empty() || cols <= 0) { anchorRow_ = LONG_MIN; return miss; }
  std::wregex re;
  if (opt.regex) {
    try {
      auto flags = std::regex_constants::ECMAScript | std::regex_constants::optimize;
      if (!opt.caseSensitive) flags |= std::regex_constants::icase;
      re.assign(q, flags);
    } catch (const std::exception&) {
      anchorRow_ = LONG_MIN;   // "29[" while typing a regex: a miss, never a throw
      return miss;
    }
  } else if (!opt.caseSensitive) {
    lower(q);
  }

  bool hasAnchor = anchorRow != LONG_MIN;
  Pos anchor{ anchorRow, anchorCol };
  long count = 0;
  bool haveTarget = false;
  Match target{}, firstM{}, lastM{};
  long targetOrd = 0;
  std::vector<std::pair<int, int>> decorRange;   // per decorated match, its entries [begin, end)

  auto addDecor = [&](const Match& m) {
    int b = (int)decor_.matches.size();
    for (long r = m.start.row; r <= m.end.row; r++) {
      int c0 = r == m.start.row ? m.start.col : 0;
      int c1 = r == m.end.row ? m.end.col : cols;
      if (c1 > c0) decor_.matches.push_back({ r, { c0, c1 } });
    }
    return std::make_pair(b, (int)decor_.matches.size());
  };
  auto take = [&](const Match& m) {
    if (count == 0) firstM = m;
    lastM = m;
    if (hasAnchor) {
      if (forward && !haveTarget && (opt.incremental ? anchor <= m.start : anchor < m.start)) {
        haveTarget = true; target = m; targetOrd = count;
      } else if (!forward && (opt.incremental ? m.start <= anchor : m.start < anchor)) {
        haveTarget = true; target = m; targetOrd = count;
      }
    }
    if (count < kCountCap) decorRange.push_back(addDecor(m));
    count++;
  };
  // Past the cap the count is settled; scanning on only matters while the
  // target can still change: forward until it is found, backward until a match
  // after the anchor shows up. Without an anchor, backward needs the last match.
  auto settled = [&]() {
    if (count <= kCountCap) return false;
    if (forward) return !hasAnchor || haveTarget;
    return hasAnchor && haveTarget && anchor < lastM.start;
  };

  Line ln;
  std::wstring hay;
  try {
    for (long r = -(long)st.scrollbackLen(); r < st.rows();) {
      long last = buildLine(st, r, ln);
      // Past the cap, forward, the lines before the anchor can no longer change anything.
      if (count > kCountCap && forward && hasAnchor && !haveTarget && last < anchor.row) { r = last + 1; continue; }
      const std::wstring* text = &ln.text;
      if (!opt.regex && !opt.caseSensitive) { hay = ln.text; lower(hay); text = &hay; }
      auto toMatch = [&](size_t s, size_t e) {
        int c0 = ln.cell[s], c1 = ln.cell[e - 1] + ln.wide[e - 1];
        return Match{ { ln.first + c0 / cols, c0 % cols }, { ln.first + (c1 - 1) / cols, (c1 - 1) % cols + 1 } };
      };
      // Overlapping matches count, as the addon steps one column past each start.
      // Past the cap only the target's place matters, so the scan steps past
      // each match instead (std::regex makes the overlapping restarts slow).
      for (size_t pos = 0; pos < text->size();) {
        size_t s, e;
        if (opt.regex) {
          std::wsmatch m;
          auto flags = pos > 0 ? std::regex_constants::match_prev_avail : std::regex_constants::match_default;
          if (!std::regex_search(text->cbegin() + (long)pos, text->cend(), m, re, flags)) break;
          s = pos + (size_t)m.position(0);
          e = s + (size_t)m.length(0);
          if (e == s) { pos = s + 1; continue; }   // an empty match selects nothing
        } else {
          s = text->find(q, pos);
          if (s == std::wstring::npos) break;
          e = s + q.size();
        }
        take(toMatch(s, e));
        pos = count > kCountCap ? e : s + 1;
      }
      if (settled()) break;
      r = last + 1;
    }
  } catch (const std::exception&) {
    // std::regex gives up on some patterns (error_complexity, error_stack).
    decor_ = FindDecor{};
    anchorRow_ = LONG_MIN;
    return miss;
  }

  if (count == 0) { anchorRow_ = LONG_MIN; return miss; }
  if (!haveTarget) {   // none past the anchor, or no anchor: wrap to the far end
    if (forward) { target = firstM; targetOrd = 0; }
    else { target = lastM; targetOrd = count - 1; }
  }
  if (targetOrd < kCountCap) {
    decor_.active = decorRange[(size_t)targetOrd].first;
    decor_.activeEnd = decorRange[(size_t)targetOrd].second;
  } else {
    auto rg = addDecor(target);   // past the cap: after every decorated match, so the order holds
    decor_.active = rg.first;
    decor_.activeEnd = rg.second;
  }
  anchorRow_ = target.start.row;
  anchorCol_ = target.start.col;
  activeRow_ = target.start.row;
  bool capped = count > kCountCap;
  // Like the addon's resultIndex: -1 when the active match is past the cap.
  return { targetOrd < kCountCap ? (int)targetOrd : -1, (int)std::min<long>(count, kCountCap), capped, false };
}

void Finder::clear() {
  decor_ = FindDecor{};
  anchorRow_ = LONG_MIN;
  activeRow_ = LONG_MIN;
}

bool Finder::anchor(long* absRow, int* col) const {
  if (anchorRow_ == LONG_MIN) return false;
  if (absRow) *absRow = anchorRow_;
  if (col) *col = anchorCol_;
  return true;
}

void Finder::onScrollbackPushed(long rows, size_t scrollbackLen) {
  if (rows <= 0) return;
  long oldest = -(long)scrollbackLen;
  for (auto& m : decor_.matches) m.first -= rows;
  size_t gone = 0;
  while (gone < decor_.matches.size() && decor_.matches[gone].first < oldest) gone++;
  if (gone) {
    decor_.matches.erase(decor_.matches.begin(), decor_.matches.begin() + (long)gone);
    decor_.active -= (int)gone;
    decor_.activeEnd -= (int)gone;
    if (decor_.activeEnd <= 0) decor_.active = decor_.activeEnd = -1;
    else if (decor_.active < 0) decor_.active = 0;
  }
  if (anchorRow_ != LONG_MIN) {
    anchorRow_ -= rows;
    if (anchorRow_ < oldest) anchorRow_ = LONG_MIN;   // its row left the scrollback (the marker's disposed flag)
  }
  if (activeRow_ != LONG_MIN) {
    activeRow_ -= rows;
    if (activeRow_ < oldest) activeRow_ = LONG_MIN;
  }
}
