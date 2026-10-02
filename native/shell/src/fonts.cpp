#include "fonts.h"
#include "app.h"
#include "gfx.h"
#include <cmath>

using Microsoft::WRL::ComPtr;

namespace {
const wchar_t* kFace = L"Consolas";
enum { kRegular, kBold, kItalic };

struct Design { float ascent = 0, descent = 0, lineGap = 0, upem = 0; };

// Consolas's design metrics from the system collection; zeros when it is missing.
Design design() {
  static Design d;
  static bool done = false;
  if (done) return d;
  done = true;
  IDWriteFactory* f = Gfx::instance().dwrite();
  ComPtr<IDWriteFontCollection> sys;
  if (!f || FAILED(f->GetSystemFontCollection(sys.GetAddressOf()))) return d;
  UINT32 index = 0;
  BOOL exists = FALSE;
  if (FAILED(sys->FindFamilyName(kFace, &index, &exists)) || !exists) { App::log("error: font %ls not installed", kFace); return d; }
  ComPtr<IDWriteFontFamily> family;
  ComPtr<IDWriteFont> font;
  if (FAILED(sys->GetFontFamily(index, family.GetAddressOf()))) return d;
  if (FAILED(family->GetFirstMatchingFont(DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, font.GetAddressOf()))) return d;
  DWRITE_FONT_METRICS m{};
  font->GetMetrics(&m);
  d = Design{ (float)m.ascent, (float)m.descent, (float)m.lineGap, (float)m.designUnitsPerEm };
  return d;
}
}  // namespace

std::map<Fonts::Key, ComPtr<IDWriteTextFormat>>& Fonts::formats() {
  static std::map<Key, ComPtr<IDWriteTextFormat>> m;
  return m;
}

IDWriteTextFormat* Fonts::get(float px, int style) {
  if (!(px > 0)) px = 13;
  Key k{ px, style };
  auto& m = formats();
  auto it = m.find(k);
  if (it != m.end()) return it->second.Get();
  IDWriteFactory* f = Gfx::instance().dwrite();
  ComPtr<IDWriteTextFormat> tf;
  if (!f) return nullptr;
  HRESULT hr = f->CreateTextFormat(kFace, nullptr, style == kBold ? DWRITE_FONT_WEIGHT_BOLD : DWRITE_FONT_WEIGHT_NORMAL,
                                   style == kItalic ? DWRITE_FONT_STYLE_ITALIC : DWRITE_FONT_STYLE_NORMAL,
                                   DWRITE_FONT_STRETCH_NORMAL, px, L"en-us", tf.GetAddressOf());
  if (FAILED(hr)) { App::log("error: CreateTextFormat %.1f 0x%08lx", px, (unsigned long)hr); return nullptr; }
  tf->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
  // Every row is one line exactly the cell high, its baseline where the cell's is.
  FontMetrics fm = metrics(px);
  tf->SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, fm.cellH, fm.baseline);
  m[k] = tf;
  return tf.Get();
}

IDWriteTextFormat* Fonts::format(float px) { return get(px, kRegular); }
IDWriteTextFormat* Fonts::bold(float px) { return get(px, kBold); }
IDWriteTextFormat* Fonts::italic(float px) { return get(px, kItalic); }

FontMetrics Fonts::metrics(float px) {
  if (!(px > 0)) px = 13;
  static std::map<float, FontMetrics> cache;
  auto it = cache.find(px);
  if (it != cache.end()) return it->second;
  Design d = design();
  // Without Consolas (never on a real Windows): Consolas's own proportions.
  FontMetrics fm{ px * 0.5498f, std::ceil(px * 1.1709f), px * 0.9199f };
  if (d.upem > 0) {
    fm.cellH = std::ceil((d.ascent + d.descent + d.lineGap) * px / d.upem);
    fm.baseline = d.ascent * px / d.upem;
  }
  IDWriteFactory* f = Gfx::instance().dwrite();
  ComPtr<IDWriteTextFormat> tf;
  ComPtr<IDWriteTextLayout> lay;
  if (f && SUCCEEDED(f->CreateTextFormat(kFace, nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL,
                                         DWRITE_FONT_STRETCH_NORMAL, px, L"en-us", tf.GetAddressOf())) &&
      SUCCEEDED(f->CreateTextLayout(L"M", 1, tf.Get(), 1000.f, 1000.f, lay.GetAddressOf()))) {
    DWRITE_TEXT_METRICS tm{};
    if (SUCCEEDED(lay->GetMetrics(&tm)) && tm.widthIncludingTrailingWhitespace > 0) fm.cellW = tm.widthIncludingTrailingWhitespace;
  }
  cache[px] = fm;
  return fm;
}
