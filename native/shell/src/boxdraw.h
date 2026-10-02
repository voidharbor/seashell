// Box-drawing and block characters (U+2500 to U+259F) drawn as geometry to
// the cell, so lines meet and blocks fill it: xterm.js's customGlyphs
// behaviour. DirectWrite never sees these codepoints.
#pragma once
#include <d2d1_1.h>
#include <cstdint>

bool boxdrawHandles(uint32_t cp);
// cell is the cell's rect in device pixels (two cells for a wide one); light
// is the light line thickness in pixels (heavy is twice it).
void boxdrawDraw(ID2D1RenderTarget* rt, ID2D1SolidColorBrush* brush, uint32_t cp, D2D1_RECT_F cell, float light);
