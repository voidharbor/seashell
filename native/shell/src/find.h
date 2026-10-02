// Find in one pane's grid (native design spec section 5): the search addon's
// behaviour over GridStore. Each logical (wrapped) line is searched as UTF-16,
// as xterm.js does, so a match may cross a soft wrap. Literal or ECMAScript
// regex, case-insensitive by default, a count that stops at 1000, and an
// anchor that keeps the user's match while output streams (find-anchor.ts).
// UI thread only; App keeps one Finder per pane.
#pragma once
#include "grid_store.h"
#include <climits>
#include <string>
#include <utility>
#include <vector>

// The decorated cells, sorted by row then column. A match that crosses a soft
// wrap takes one entry per row; entries [active, activeEnd) are the active one.
struct FindDecor {
  std::vector<std::pair<long, std::pair<int, int>>> matches;   // absRow, [startCol, endCol)
  int active = -1;
  int activeEnd = -1;
};

class Finder {
public:
  static constexpr int kCountCap = 1000;   // the search addon's highlightLimit
  struct Options { bool caseSensitive; bool regex; bool incremental; };
  // index is 0-based like the addon's resultIndex (-1 when the active match is
  // past the cap); index and total are 0 on a miss.
  struct Result { int index; int total; bool capped; bool miss; };

  // Runs the search over the whole store (scrollback plus screen), newest state
  // of the buffer. anchorRow LONG_MIN means no anchor: forward starts at the
  // oldest row, backward at the newest. Forward takes the first match after the
  // anchor (at it when incremental), backward the last one before it; both wrap.
  Result find(const GridStore& store, const std::string& query, Options opt, bool forward, long anchorRow, int anchorCol);
  const FindDecor& decor() const { return decor_; }
  void clear();
  // The anchor: the start of the user's current match.
  bool anchor(long* absRow, int* col) const;
  long activeRow() const { return activeRow_; }   // the active match's first row (LONG_MIN when none)
  // n rows went into scrollback: every absolute row moves up by n. Rows older
  // than the store's oldest (-scrollbackLen) are dropped, the anchor with them.
  void onScrollbackPushed(long rows, size_t scrollbackLen);

private:
  FindDecor decor_;
  long anchorRow_ = LONG_MIN;
  int anchorCol_ = 0;
  long activeRow_ = LONG_MIN;
};
