// Reads UTF-8 lines from stdin and prints one JSON array of cluster widths per
// line (seashell_cluster_widths). Lines starting with '#' are corpus comments
// and are skipped, matching test/dom/width-corpus.test.ts.
#include "width.h"

#include <cstdio>
#include <iostream>
#include <string>

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.size() >= 3 && (unsigned char)line[0] == 0xEF && (unsigned char)line[1] == 0xBB &&
        (unsigned char)line[2] == 0xBF)
      line.erase(0, 3);
    if (line.empty() || line[0] == '#') continue;
    std::vector<int> widths = seashell_cluster_widths(line);
    std::string out = "[";
    for (size_t i = 0; i < widths.size(); i++) {
      if (i) out += ",";
      out += std::to_string(widths[i]);
    }
    out += "]\n";
    fwrite(out.data(), 1, out.size(), stdout);
  }
  return 0;
}
