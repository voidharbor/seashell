#include "gfx.h"
#include "app.h"
#include "window.h"

Gfx& Gfx::instance() { static Gfx g; return g; }

bool Gfx::init() {
  D2D1_FACTORY_OPTIONS opts{};
  HRESULT hr = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory1), &opts,
                                 reinterpret_cast<void**>(d2d_.GetAddressOf()));
  if (FAILED(hr)) { App::log("error: D2D1CreateFactory 0x%08lx", (unsigned long)hr); return false; }
  hr = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                           reinterpret_cast<IUnknown**>(dwrite_.GetAddressOf()));
  if (FAILED(hr)) { App::log("error: DWriteCreateFactory 0x%08lx", (unsigned long)hr); return false; }
  hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(wic_.GetAddressOf()));
  if (FAILED(hr)) { App::log("error: WIC factory 0x%08lx", (unsigned long)hr); return false; }
  return true;
}

ID2D1HwndRenderTarget* Gfx::bodyTarget() {
  if (body_) return body_.Get();
  HWND h = Window::instance().body();
  if (!h || !d2d_) return nullptr;
  RECT rc; GetClientRect(h, &rc);
  D2D1_SIZE_U size = D2D1::SizeU((UINT32)(rc.right - rc.left), (UINT32)(rc.bottom - rc.top));
  auto props = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_HARDWARE,
                                            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE), 96.f, 96.f);
  HRESULT hr = d2d_->CreateHwndRenderTarget(props, D2D1::HwndRenderTargetProperties(h, size), body_.GetAddressOf());
  if (FAILED(hr)) {
    // No hardware device (a remote session, a broken driver): WARP still draws.
    App::log("error: hardware body target 0x%08lx, falling back to default", (unsigned long)hr);
    props.type = D2D1_RENDER_TARGET_TYPE_DEFAULT;
    hr = d2d_->CreateHwndRenderTarget(props, D2D1::HwndRenderTargetProperties(h, size), body_.GetAddressOf());
    if (FAILED(hr)) { App::log("error: CreateHwndRenderTarget 0x%08lx", (unsigned long)hr); return nullptr; }
  }
  return body_.Get();
}

void Gfx::discardBodyTarget() { body_.Reset(); }

void Gfx::resizeBody(UINT w, UINT h) {
  if (body_) body_->Resize(D2D1::SizeU(w, h));
}

ID2D1DCRenderTarget* Gfx::stripTarget(HDC dc, RECT rc) {
  if (!strip_) {
    if (!d2d_) return nullptr;
    auto props = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_DEFAULT,
                                              D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED), 96.f, 96.f);
    HRESULT hr = d2d_->CreateDCRenderTarget(&props, strip_.GetAddressOf());
    if (FAILED(hr)) { App::log("error: CreateDCRenderTarget 0x%08lx", (unsigned long)hr); return nullptr; }
  }
  HRESULT hr = strip_->BindDC(dc, &rc);
  if (FAILED(hr)) { App::log("error: BindDC 0x%08lx", (unsigned long)hr); return nullptr; }
  return strip_.Get();
}

void Gfx::discardStripTarget() { strip_.Reset(); }
