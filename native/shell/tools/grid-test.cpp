// grid-test <cols> <rows> <file.bin> [--resize <cols> <rows>]: feeds the file
// into a Grid (scrollback 20000), optionally resizes it, and prints one JSON
// object: the screen's text rows, the cursor, the scrollback length, each
// row's wrapped flag, each cell's width, and `all`: the text of every row from
// the oldest scrollback row to the last non-empty screen row. scripts/vt-parity.mjs compares it
// with what test/dom/vt-corpus.test.ts records from xterm.js.
#include "grid.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>

int main(int argc, char** argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: grid-test <cols> <rows> <file.bin> [--resize <cols> <rows>]\n");
    return 2;
  }
  int cols = atoi(argv[1]), rows = atoi(argv[2]);
  std::ifstream in(argv[3], std::ios::binary);
  if (!in) {
    fprintf(stderr, "grid-test: cannot read %s\n", argv[3]);
    return 2;
  }
  std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  Grid g("grid-test", cols, rows, 20000);
  g.feed(bytes.data(), bytes.size());
  if (argc >= 7 && strcmp(argv[4], "--resize") == 0) g.resize(atoi(argv[5]), atoi(argv[6]));

  const GridStore& s = g.store();
  nlohmann::json text = nlohmann::json::array(), wrapped = nlohmann::json::array(), widths = nlohmann::json::array();
  for (int r = 0; r < s.rows(); r++) {
    const Row& row = s.row(r);
    text.push_back(s.text(r));
    wrapped.push_back(row.wrapped);
    nlohmann::json w = nlohmann::json::array();
    for (int c = 0; c < s.cols(); c++) w.push_back(c < (int)row.cells.size() ? (int)row.cells[(size_t)c].width : 1);
    widths.push_back(w);
  }
  nlohmann::json all = nlohmann::json::array();
  long last = s.rows() - 1;
  while (last >= 0 && s.text(last).empty()) last--;
  for (long r = -(long)s.scrollbackLen(); r <= last; r++) all.push_back(s.text(r));
  nlohmann::json out = {
    { "text", text },
    { "cursor", { { "row", g.cursor().row }, { "col", g.cursor().col } } },
    { "scrollback", s.scrollbackLen() },
    { "wrapped", wrapped },
    { "widths", widths },
    { "all", all },
  };
  std::string body = out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) + "\n";
  fwrite(body.data(), 1, body.size(), stdout);
  return 0;
}
