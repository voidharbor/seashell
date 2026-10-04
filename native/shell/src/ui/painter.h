// The chrome's drawing primitives over one Direct2D target for one frame.
// Rects are device pixels; `scale` is the DPI scale times the model's uiScale,
// so DIP sizes (radii, borders, font sizes) multiply by it. A Painter built
// with a null target draws nothing: Ui runs the views through one to register
// their hit rects without painting.
#pragma once
#include <d2d1_1.h>
#include <dwrite.h>
#include <wrl/client.h>
#include <cstdint>
#include <string>

struct UiFont {
  float dip = 12;        // Segoe UI 9 pt
  bool bold = false;
  bool symbol = false;   // Segoe UI Symbol, for the chrome glyphs
};

enum class Align { Left, Center, Right };
enum class BtnState { Normal, Hover, Pressed, Default, Disabled };

class Painter {
public:
  Painter(ID2D1RenderTarget* rt, float dpiScale, float uiScale);
  bool live() const { return rt_ != nullptr; }
  ID2D1RenderTarget* rt() const { return rt_; }
  float scale() const { return dpi_ * ui_; }    // DIP to device pixels for chrome sizes
  float dpiScale() const { return dpi_; }
  float px(float dip) const { return dip * scale(); }

  void fillRect(D2D1_RECT_F r, uint32_t rgb, float alpha = 1);
  void strokeRect(D2D1_RECT_F r, uint32_t rgb, float widthDip = 1, float alpha = 1);
  void roundedRect(D2D1_RECT_F r, float radiusDip, uint32_t fill, float fillAlpha, uint32_t stroke, float strokeAlpha);
  void gradientV(D2D1_RECT_F r, const D2D1_GRADIENT_STOP* stops, UINT n, float radiusDip = 0);
  void gradientH(D2D1_RECT_F r, const D2D1_GRADIENT_STOP* stops, UINT n, float radiusDip = 0);   // left to right
  // 6.3 button: two-stop gradient, 1 px border, inner highlight, a label.
  void win7Button(D2D1_RECT_F r, BtnState state, const std::wstring& label = L"", float labelDip = 12);
  // The Win7 tab: 5 px top radii (6.3); the active one shades into joinColor (the
  // body color under it) with no bottom border, so it merges into the content.
  // sheen is mixed into the inactive face's top at topSheen (63 percent white
  // over #dcdcdc is 6.3's #f2f2f2) and more under the pointer; border is the 1 px edge.
  void win7Tab(D2D1_RECT_F r, bool active, bool hover, uint32_t activeFace, uint32_t inactiveFace, uint32_t joinColor,
               uint32_t sheen = 0xFFFFFF, uint32_t border = 0x8E8F8F, float topSheen = 0.63f);
  void text(D2D1_RECT_F r, const std::wstring& s, UiFont f, uint32_t rgb, Align a = Align::Left, bool ellipsis = true, float alpha = 1);
  // text() in two halves, so a caller can keep the layout across frames (the
  // explorer's row names): build it for a w by h box, then draw it in r.
  Microsoft::WRL::ComPtr<IDWriteTextLayout> textLayout(const std::wstring& s, UiFont f, float w, float h, Align a = Align::Left,
                                                       bool ellipsis = true) const;
  void drawLayout(D2D1_RECT_F r, IDWriteTextLayout* tl, uint32_t rgb, float alpha = 1);
  void glyph(D2D1_RECT_F r, uint32_t codepoint, uint32_t rgb, float dip = 12, float alpha = 1);
  // The explorer's row icons (src/renderer/explorer/icons.tsx, a 16 DIP box at
  // r's centre): the folder outline in its open or closed tint, and the page
  // with its folded corner plus a 6 DIP chip square when the row has a chip.
  void folderGlyph(D2D1_RECT_F r, bool open, float alpha = 1);
  void fileGlyph(D2D1_RECT_F r, const uint32_t* chip, float alpha = 1);
  // The disclosure triangle at r's centre: pointing right, or down when open.
  void twisty(D2D1_RECT_F r, bool open, uint32_t rgb, float alpha = 1);
  enum class Dir { Right, Down, Left, Up };
  void arrow(D2D1_RECT_F box, Dir dir, uint32_t rgb, float alpha = 1);   // a filled triangle filling box
  // The Win7 caption glow behind text on glass: a white rect blurred by
  // blurDip through the D2D Gaussian blur (stacked soft rects without it).
  void glow(D2D1_RECT_F r, float blurDip = 4, float alpha = 0.85f);
  float textWidth(const std::wstring& s, UiFont f) const;   // device pixels
  // The caret index (UTF-16) nearest to x within s laid out from x0.
  size_t hitIndex(const std::wstring& s, UiFont f, float x0, float x) const;
  float caretX(const std::wstring& s, UiFont f, size_t index) const;   // offset from the text's left edge
  void pushClip(D2D1_RECT_F r);
  void popClip();

  static IDWriteTextFormat* format(UiFont f, float px);    // cached per family, weight and size
  static IDWriteInlineObject* ellipsisSign(UiFont f, float px);   // the trimming '…' for that format, made once with it

private:
  ID2D1SolidColorBrush* brush(uint32_t rgb, float alpha);
  // A cached geometry drawn in a units-square box mapped onto `box`.
  void fillShape(ID2D1Geometry* g, D2D1_RECT_F box, float units, uint32_t rgb, float alpha);
  void strokeShape(ID2D1Geometry* g, D2D1_RECT_F box, float units, uint32_t rgb, float alpha);
  Microsoft::WRL::ComPtr<IDWriteTextLayout> layout(const std::wstring& s, UiFont f, float maxW, float maxH) const;

  ID2D1RenderTarget* rt_;
  float dpi_, ui_;
  Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> brush_;
};

inline D2D1_RECT_F inset(D2D1_RECT_F r, float dx, float dy) { return D2D1::RectF(r.left + dx, r.top + dy, r.right - dx, r.bottom - dy); }
inline bool contains(D2D1_RECT_F r, float x, float y) { return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }
// rgb at weight w over base (both 0x00RRGGBB).
uint32_t mixRgb(uint32_t rgb, uint32_t base, float w);
