// One grid's text selection, in GridStore's absolute rows (0 is the top screen
// row, negative rows are scrollback). Columns are cell boundaries: the end
// column is exclusive, which is how GridView paints it. Start may come after
// end (a drag upward); every reader orders the two.
#pragma once
#include <string>

class GridStore;

struct Selection {
  long startRow = 0;
  int startCol = 0;
  long endRow = 0;
  int endCol = 0;
  bool active = false;

  void clear() { active = false; }
  bool empty() const;   // inactive, or start and end on the same boundary
  // The ordered pair: (r0, c0) at or before (r1, c1).
  void ordered(long* r0, int* c0, long* r1, int* c1) const;
  // The selected text as UTF-8: rows joined with '\n' except after a row that
  // wraps onto the next; trailing blanks of an unwrapped row trimmed.
  std::string text(const GridStore& store) const;
  // Double click: the run of word characters (letters, digits, _ - . / ~ :)
  // under the cell; whitespace selects its run, anything else the cell alone.
  void selectWord(const GridStore& store, long row, int col);
  // Triple click: the logical line (the whole wrapped run) under row.
  void selectLine(const GridStore& store, long row);
  // The whole buffer, oldest scrollback row to the last screen row.
  void selectAll(const GridStore& store);
  // Moves the selection with the rows when n rows went into scrollback, and
  // drops it once it scrolls past the oldest row.
  void shift(long rows, const GridStore& store);
};
