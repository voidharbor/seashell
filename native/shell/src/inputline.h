// Ports of src/renderer/term/inputline.ts: what Ctrl+A selects in an agent's
// prompt, and the bytes that clear it.
#pragma once
#include <functional>
#include <optional>
#include <string>

struct InputLineSelection {
  long row = 0;     // absolute row (GridStore numbering) the selection starts on
  int col = 0;      // always the line start
  long length = 0;  // cells, spanning wrapped rows
};

// inputLineSelection (inputline.ts:45-70): from the start of the cursor's
// logical line to the cursor. isWrapped(row) says row continues the row above
// it; firstRow is the oldest row there is. nullopt for an empty prompt at
// column 0 (the caller then selects the whole buffer).
std::optional<InputLineSelection> inputLineSelection(long cursorRow, int cursorCol, int cols, long firstRow,
                                                     const std::function<bool(long)>& isWrapped);

// Ctrl+U: erase back to the line start, exactly what the selection covers
// (inputline.ts KILL_LINE).
extern const char* const kLineErase;

// The agent CLIs whose prompt Ctrl+A selects, matched case-insensitively
// against the pane's foreground process (the model's badge).
bool isAgentForeground(const std::string& foregroundProcess);
