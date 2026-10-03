// grid-test <cols> <rows> <file.bin> [--resize <cols> <rows>]: feeds the file
// into a Grid (scrollback 20000), optionally resizes it, and prints one JSON
// object: the screen's text rows, the cursor, the scrollback length, each
// row's wrapped flag, each cell's width, `all`: the text of every row from
// the oldest scrollback row to the last non-empty screen row, each screen
// cell's pen (`cells`), the cursor's shape, blink and visibility, the OSC 0/2
// title and the mode flags. scripts/vt-parity.mjs compares it with what
// test/dom/vt-corpus.test.ts records from xterm.js, in the same shape.
#include "grid.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>

// A colour as the xterm.js side writes it: `p<index>`, `#rrggbb`, or null for
// the default (left out of the cell).
static nlohmann::json color(uint32_t c) {
  if (c == kColorDefault) return nullptr;
  char buf[16];
  if (colorIsPalette(c)) snprintf(buf, sizeof buf, "p%u", (unsigned)(c & 0xFF));
  else snprintf(buf, sizeof buf, "#%06x", (unsigned)(c & 0xFFFFFF));
  return buf;
}

// One cell's pen with the defaults left out, as test/dom/vt-corpus.test.ts
// writes it.
static nlohmann::json pen(const Grid& g, const Cell& cell, int row, int col) {
  nlohmann::json p = nlohmann::json::object();
  const CellAttrs& a = cell.a;
  if (auto fg = color(a.fg); !fg.is_null()) p["fg"] = fg;
  if (auto bg = color(a.bg); !bg.is_null()) p["bg"] = bg;
  if (a.bold) p["bold"] = true;
  if (a.italic) p["italic"] = true;
  if (a.underline) p["underline"] = (int)a.underline;
  if (a.strike) p["strike"] = true;
  if (a.reverse) p["inverse"] = true;
  if (a.dim) p["dim"] = true;
  if (a.blink) p["blink"] = true;
  std::string uri = g.uriAt(row, col);
  if (!uri.empty()) p["link"] = uri;
  return p;
}

static const char* shape(int s) {
  switch (s) {
    case VTERM_PROP_CURSORSHAPE_UNDERLINE: return "underline";
    case VTERM_PROP_CURSORSHAPE_BAR_LEFT: return "bar";
    default: return "block";
  }
}

// xterm.js's mouseTrackingMode names: ?1000 vt200, ?1002 drag, ?1003 any.
static const char* mouse(int m) {
  switch (m) {
    case VTERM_PROP_MOUSE_CLICK: return "vt200";
    case VTERM_PROP_MOUSE_DRAG: return "drag";
    case VTERM_PROP_MOUSE_MOVE: return "any";
    default: return "none";
  }
}

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
  std::string title;
  g.onTitle = [&](const std::string& t) { title = t; };
  g.feed(bytes.data(), bytes.size());
  if (argc >= 7 && strcmp(argv[4], "--resize") == 0) g.resize(atoi(argv[5]), atoi(argv[6]));

  // DECCKM, DECOM and DECAWM have no getter on Grid or libvterm's public API;
  // ask through DECRQM (CSI ? Ps $ p, answered CSI ? Ps ; 1 $ y when set) once
  // the corpus is in. A query changes no cell.
  std::string replies;
  g.setOutput([&](const std::string& s) { replies += s; });
  auto modeSet = [&](int mode) {
    replies.clear();
    std::string q = "\x1b[?" + std::to_string(mode) + "$p";
    g.feed(q.data(), q.size());
    return replies == "\x1b[?" + std::to_string(mode) + ";1$y";
  };
  bool appCursor = modeSet(1), origin = modeSet(6), autowrap = modeSet(7);

  const GridStore& s = g.store();
  nlohmann::json text = nlohmann::json::array(), wrapped = nlohmann::json::array(), widths = nlohmann::json::array(),
                 cells = nlohmann::json::array();
  for (int r = 0; r < s.rows(); r++) {
    const Row& row = s.row(r);
    text.push_back(s.text(r));
    wrapped.push_back(row.wrapped);
    nlohmann::json w = nlohmann::json::array(), pens = nlohmann::json::array();
    for (int c = 0; c < s.cols(); c++) {
      bool have = c < (int)row.cells.size();
      w.push_back(have ? (int)row.cells[(size_t)c].width : 1);
      pens.push_back(have ? pen(g, row.cells[(size_t)c], r, c) : nlohmann::json::object());
    }
    widths.push_back(w);
    cells.push_back(pens);
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
    { "cells", cells },
    { "cursorStyle",
      { { "shape", shape(g.cursorShape()) }, { "blink", g.cursorBlink() }, { "visible", g.cursorVisible() } } },
    { "title", title },
    { "modes",
      { { "appCursor", appCursor },
        { "bracketedPaste", g.bracketedPaste() },
        { "mouse", mouse(g.mouseMode()) },
        { "altScreen", g.altScreen() },
        { "origin", origin },
        { "autowrap", autowrap } } },
  };
  std::string body = out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) + "\n";
  fwrite(body.data(), 1, body.size(), stdout);
  return 0;
}
