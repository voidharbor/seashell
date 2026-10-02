// Cell widths for libvterm, matched to xterm.js with @xterm/addon-unicode-graphemes
// 0.4 (activeVersion '15-graphemes'). test/fixtures/width-corpus.txt is the
// contract; scripts/width-parity.mjs compares tools/width-test against it.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Points libvterm's width hooks (native/third_party/libvterm/PATCHES.md) at the
// functions below. Idempotent; call before the first vterm_input_write.
void seashell_install_width_hooks();

// The cell width of one codepoint on its own (1 or 2; 0 only for controls).
int seashell_width(uint32_t cp);

// Whether `cp` joins the cluster that `prev` (the codepoint before it in the
// same write, 0 at the start) belongs to.
int seashell_is_combining(uint32_t cp, uint32_t prev);

// The width of one cluster libvterm built, `n` codepoints starting with its base.
int seashell_glyph_width(const uint32_t* chars, int n);

// Writes `utf8` into a fresh 200x4 libvterm screen and returns the width of
// every cell-consuming cluster on row 0, in order (what width-test prints).
std::vector<int> seashell_cluster_widths(const std::string& utf8);
