#include "inputline.h"
#include <algorithm>
#include <cctype>

const char* const kLineErase = "\x15";

std::optional<InputLineSelection> inputLineSelection(long cursorRow, int cursorCol, int cols, long firstRow,
                                                     const std::function<bool(long)>& isWrapped) {
  if (cols <= 0) return std::nullopt;
  // Walk back over continuation rows; the guard keeps a corrupt store from spinning.
  long start = cursorRow;
  int guard = 0;
  while (start > firstRow && isWrapped(start) && guard < 10000) {
    start--;
    guard++;
  }
  long length = (cursorRow - start) * (long)cols + cursorCol;
  if (length <= 0) return std::nullopt;
  return InputLineSelection{ start, 0, length };
}

bool isAgentForeground(const std::string& fg) {
  std::string l = fg;
  std::transform(l.begin(), l.end(), l.begin(), [](unsigned char c) { return (char)tolower(c); });
  for (const char* name : { "claude", "codex", "opencode", "gemini" })
    if (l.find(name) != std::string::npos) return true;
  return false;
}
