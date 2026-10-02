// Consolas through DirectWrite (native design spec section 5): one text format
// per size and style, and the cell metrics the grid and the core's layout use.
// Sizes are device pixels; the render targets draw at 96 DPI, so DirectWrite's
// DIPs are device pixels there.
#pragma once
#include <dwrite.h>
#include <wrl/client.h>
#include <map>

struct FontMetrics { float cellW, cellH, baseline; };

class Fonts {
public:
  static IDWriteTextFormat* format(float px);   // Consolas regular at px, cached per size
  static IDWriteTextFormat* bold(float px);
  static IDWriteTextFormat* italic(float px);
  // cellW: the advance of "M" from IDWriteTextLayout::GetMetrics.
  // cellH: ceil((ascent + descent + lineGap) * px / designUnitsPerEm).
  // baseline: ascent * px / designUnitsPerEm.
  static FontMetrics metrics(float px);

private:
  struct Key { float px; int style; bool operator<(const Key& o) const { return px < o.px || (px == o.px && style < o.style); } };
  static IDWriteTextFormat* get(float px, int style);
  static std::map<Key, Microsoft::WRL::ComPtr<IDWriteTextFormat>>& formats();
};
