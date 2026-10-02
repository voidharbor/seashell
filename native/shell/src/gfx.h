// Direct2D, DirectWrite and WIC, created once. Both render targets draw in
// physical pixels (target DPI 96); callers scale by Window::dpi() themselves.
#pragma once
#include <windows.h>
#include <d2d1_1.h>
#include <dwrite.h>
#include <wincodec.h>
#include <wrl/client.h>

class Gfx {
public:
  static Gfx& instance();
  bool init();                                    // after CoInitializeEx; false logs the failing call
  ID2D1Factory1* d2d() const { return d2d_.Get(); }
  IDWriteFactory* dwrite() const { return dwrite_.Get(); }
  IWICImagingFactory* wic() const { return wic_.Get(); }

  // The body child's hardware target, created on first use and after
  // discardBodyTarget() (call it when EndDraw returns D2DERR_RECREATE_TARGET).
  ID2D1HwndRenderTarget* bodyTarget();
  void discardBodyTarget();
  void resizeBody(UINT w, UINT h);

  // The strip's DC target bound to `dc` (a 32-bpp premultiplied DIB) over `rc`.
  ID2D1DCRenderTarget* stripTarget(HDC dc, RECT rc);
  void discardStripTarget();

private:
  Microsoft::WRL::ComPtr<ID2D1Factory1> d2d_;
  Microsoft::WRL::ComPtr<IDWriteFactory> dwrite_;
  Microsoft::WRL::ComPtr<IWICImagingFactory> wic_;
  Microsoft::WRL::ComPtr<ID2D1HwndRenderTarget> body_;
  Microsoft::WRL::ComPtr<ID2D1DCRenderTarget> strip_;
};
