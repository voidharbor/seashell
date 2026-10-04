#include "window.h"
#include "app.h"
#include "driver.h"
#include "gfx.h"
#include "ui/menu.h"
#include "ui/ui.h"
#include <dwmapi.h>
#include <windowsx.h>
#include <cmath>

static const wchar_t* kHostClass = L"SeaShellHost";
static const wchar_t* kBodyClass = L"SeaShellBody";
static const int kIdiApp = 101;   // IDI_APP in app.rc

Window& Window::instance() { static Window w; return w; }

// The model's tabStripH (38 DIP times uiScale), 38 DIP before the first model.
int Window::stripHeightPx() const {
  double dip = App::instance().model().window.tabStripH;
  return (int)std::lround((dip > 0 ? dip : 38) * dpi().scale());
}

void Window::onStripHeightChanged() {
  if (!hwnd_) return;
  extendFrame();
  relayout();
}
int Window::borderPx() const { return (int)std::lround(8 * dpi().scale()); }

RECT Window::bodyRect() const {
  RECT rc{};
  if (hwnd_) GetClientRect(hwnd_, &rc);
  rc.top = std::min(rc.bottom, rc.top + (LONG)stripHeightPx());
  return rc;
}

void Window::invalidateStrip() {
  if (!hwnd_) return;
  RECT rc; GetClientRect(hwnd_, &rc);
  rc.bottom = std::min(rc.bottom, rc.top + (LONG)stripHeightPx());
  InvalidateRect(hwnd_, &rc, FALSE);
}

// A frame is 1000 / refreshHz ms. An invalidate a frame or more after the
// last body paint ended goes to InvalidateRect at once, so a single event (one
// divider move, one keystroke's echo) paints on the next WM_PAINT; the key
// itself paints nothing unless it scrolled the view or cleared a selection
// (GridInput::afterTyped), so its echo finds the frame free. One sooner, or
// during a paint, joins the pending region, and one timer armed for the rest
// of the frame invalidates it: a flood paints at most once per frame.
void Window::invalidateBody(const RECT* r) {
  if (!body_) return;
  addBodyPending(r);
  double frameMs = 1000.0 / refreshHz_;
  double sinceMs = frameMs;
  if (bodyPainting_) {
    sinceMs = 0;
  } else if (bodyPaintEnd_) {
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    sinceMs = Driver::ticksMs(now.QuadPart - bodyPaintEnd_);
  }
  if (sinceMs >= frameMs) { flushBody(); return; }
  if (!bodyTimer_) bodyTimer_ = SetTimer(nullptr, 0, (UINT)std::ceil(frameMs - sinceMs), bodyFrameTick);
  if (!bodyTimer_) flushBody();   // no timer to wait on: paint now rather than never
}

void Window::addBodyPending(const RECT* r) {
  if (!r) bodyPendingAll_ = true;
  else if (!bodyPendingAll_) {
    if (bodyPendingAny_) UnionRect(&bodyPending_, &bodyPending_, r);
    else bodyPending_ = *r;
  }
  bodyPendingAny_ = true;
}

void Window::flushBody() {
  if (bodyTimer_) { KillTimer(nullptr, bodyTimer_); bodyTimer_ = 0; }
  if (!bodyPendingAny_ || !body_) return;
  InvalidateRect(body_, bodyPendingAll_ ? nullptr : &bodyPending_, FALSE);
  bodyPendingAny_ = bodyPendingAll_ = false;
}

// The frame is up. The tick paints too (UpdateWindow): WM_TIMER and WM_PAINT
// each wait for an empty queue, and under a flood a second wait would cost
// another frame or more.
void CALLBACK Window::bodyFrameTick(HWND, UINT, UINT_PTR id, DWORD) {
  Window& w = instance();
  KillTimer(nullptr, id);
  if (id != w.bodyTimer_) return;   // a tick already queued when flushBody disarmed it
  w.bodyTimer_ = 0;
  w.flushBody();
  if (w.body_) UpdateWindow(w.body_);
}

// The window's monitor, EnumDisplaySettingsW's current mode; 60 when the
// driver reports 0 or 1 (the hardware default) or a call fails.
void Window::readRefreshHz() {
  double hz = 0;
  MONITORINFOEXW mi{};
  mi.cbSize = sizeof mi;
  HMONITOR mon = hwnd_ ? MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST) : nullptr;
  if (mon && GetMonitorInfoW(mon, &mi)) {
    DEVMODEW dm{};
    dm.dmSize = sizeof dm;
    if (EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm) && dm.dmDisplayFrequency > 1) hz = dm.dmDisplayFrequency;
  }
  refreshHz_ = hz > 0 ? hz : 60;
  App::log("refresh %.0f Hz%s on %ls", refreshHz_, hz > 0 ? "" : " (unknown, assumed)", mi.szDevice);
}
void Window::setTitle(const std::wstring& s) { if (hwnd_) SetWindowTextW(hwnd_, s.c_str()); }
void Window::post(UINT msg, WPARAM w, LPARAM l) { if (hwnd_) PostMessageW(hwnd_, msg, w, l); }

SavedBounds Window::bounds() const {
  SavedBounds b;
  b.x = normal_.left; b.y = normal_.top;
  b.width = normal_.right - normal_.left; b.height = normal_.bottom - normal_.top;
  b.maximized = hwnd_ && IsZoomed(hwnd_);
  return b;
}

bool Window::create(HINSTANCE hinst, bool noActivate) {
  HICON icon = LoadIconW(hinst, MAKEINTRESOURCEW(kIdiApp));
  WNDCLASSEXW wc{ sizeof wc };
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;   // a double-click on a tab renames it
  wc.lpfnWndProc = hostProc;
  wc.hInstance = hinst;
  wc.hIcon = icon;
  wc.hIconSm = icon;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = kHostClass;
  if (!RegisterClassExW(&wc)) { App::log("error: RegisterClassEx host %lu", GetLastError()); return false; }
  WNDCLASSEXW bc{ sizeof bc };
  bc.style = CS_DBLCLKS;   // WM_LBUTTONDBLCLK: word select and path click (Task 13)
  bc.lpfnWndProc = bodyProc;
  bc.hInstance = hinst;
  bc.hCursor = LoadCursorW(nullptr, IDC_IBEAM);
  bc.lpszClassName = kBodyClass;
  if (!RegisterClassExW(&bc)) { App::log("error: RegisterClassEx body %lu", GetLastError()); return false; }

  SavedBounds b;
  bool saved = loadBounds(b);
  if (!saved) {
    // 1440x900 DIP at 100,100 on the monitor holding that point.
    POINT at{ 100, 100 };
    UINT sdpi = GetDpiForSystem();
    float s = sdpi / 96.f;
    b.x = (int)std::lround(at.x * s); b.y = (int)std::lround(at.y * s);
    b.width = (int)std::lround(1440 * s); b.height = (int)std::lround(900 * s);
    RECT r{ b.x, b.y, b.x + b.width, b.y + b.height };
    MONITORINFO mi{ sizeof mi };
    if (GetMonitorInfoW(MonitorFromRect(&r, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      int waw = mi.rcWork.right - mi.rcWork.left, wah = mi.rcWork.bottom - mi.rcWork.top;
      b.width = std::min(b.width, waw); b.height = std::min(b.height, wah);
      b.x = std::min(std::max(b.x, (int)mi.rcWork.left), (int)mi.rcWork.right - b.width);
      b.y = std::min(std::max(b.y, (int)mi.rcWork.top), (int)mi.rcWork.bottom - b.height);
    }
  }
  normal_ = RECT{ b.x, b.y, b.x + b.width, b.y + b.height };

  hwnd_ = CreateWindowExW(0, kHostClass, L"SeaShell", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                          b.x, b.y, b.width, b.height, nullptr, nullptr, hinst, nullptr);
  if (!hwnd_) { App::log("error: CreateWindowEx host %lu", GetLastError()); return false; }
  dpi_ = GetDpiForWindow(hwnd_);
  readRefreshHz();
  RECT br = bodyRect();
  body_ = CreateWindowExW(0, kBodyClass, nullptr, WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                          br.left, br.top, br.right - br.left, br.bottom - br.top, hwnd_, nullptr, hinst, nullptr);
  if (!body_) { App::log("error: CreateWindowEx body %lu", GetLastError()); return false; }

  // SW_SHOWNOACTIVATE sends no WM_ACTIVATE, so extend the frame here too and
  // make Windows recompute the (now empty) non-client area.
  extendFrame();
  SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  if (noActivate) {
    // An unattended run never takes focus, so a saved maximized state is not
    // restored there (every maximizing show command activates).
    ShowWindow(hwnd_, SW_SHOWNOACTIVATE);
  } else {
    ShowWindow(hwnd_, saved && b.maximized ? SW_SHOWMAXIMIZED : SW_SHOW);
  }
  UpdateWindow(hwnd_);
  App::log("window %p dpi %u %dx%d at %d,%d%s", (void*)hwnd_, dpi_, b.width, b.height, b.x, b.y, saved ? " (saved)" : "");
  return true;
}

void Window::extendFrame() {
  MARGINS m{ 0, 0, stripHeightPx(), 0 };
  HRESULT hr = DwmExtendFrameIntoClientArea(hwnd_, &m);
  if (FAILED(hr)) App::log("error: DwmExtendFrameIntoClientArea 0x%08lx", (unsigned long)hr);
}

void Window::relayout() {
  if (!hwnd_ || !body_) return;
  RECT br = bodyRect();
  SetWindowPos(body_, nullptr, br.left, br.top, br.right - br.left, br.bottom - br.top, SWP_NOZORDER | SWP_NOACTIVATE);
  Ui::instance().relayout();   // the strip's controls and the status bar follow the client size
  invalidateStrip();
  App::instance().onResized();   // shell:geometry (Task 8)
}

LRESULT Window::hitTest(POINT screen) const {
  POINT pt = screen; ScreenToClient(hwnd_, &pt);
  RECT rc; GetClientRect(hwnd_, &rc);
  int b = borderPx();
  bool top = pt.y < b, bottom = pt.y >= rc.bottom - b, left = pt.x < b, right = pt.x >= rc.right - b;
  if (!IsZoomed(hwnd_)) {
    if (top && left) return HTTOPLEFT;
    if (top && right) return HTTOPRIGHT;
    if (bottom && left) return HTBOTTOMLEFT;
    if (bottom && right) return HTBOTTOMRIGHT;
    if (top) return HTTOP;
    if (bottom) return HTBOTTOM;
    if (left) return HTLEFT;
    if (right) return HTRIGHT;
  }
  // The strip drags the window only where no control is.
  if (pt.y < stripHeightPx()) return Ui::instance().stripTargetAt(pt) == "strip:empty" ? HTCAPTION : HTCLIENT;
  return HTCLIENT;
}

void Window::freeStripDib() {
  if (stripDc_) { SelectObject(stripDc_, stripOld_); DeleteDC(stripDc_); stripDc_ = nullptr; }
  if (stripBmp_) { DeleteObject(stripBmp_); stripBmp_ = nullptr; }
  stripW_ = stripH_ = 0;
}

// The MSDN "Custom Window Frame Using DWM" technique: draw into a 32-bpp
// premultiplied DIB through a DC render target, then BitBlt it to the window.
// Pixels left at alpha 0 show the DWM glass.
void Window::paintStrip() {
  LARGE_INTEGER t0, t1;
  QueryPerformanceCounter(&t0);
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(hwnd_, &ps);
  RECT rc; GetClientRect(hwnd_, &rc);
  int w = rc.right - rc.left, h = std::min((int)(rc.bottom - rc.top), stripHeightPx());
  if (w > 0 && h > 0) {
    if (w != stripW_ || h != stripH_) {
      freeStripDib();
      BITMAPINFO bi{};
      bi.bmiHeader.biSize = sizeof bi.bmiHeader;
      bi.bmiHeader.biWidth = w;
      bi.bmiHeader.biHeight = -h;   // top-down
      bi.bmiHeader.biPlanes = 1;
      bi.bmiHeader.biBitCount = 32;
      bi.bmiHeader.biCompression = BI_RGB;
      void* bits = nullptr;
      stripBmp_ = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
      stripDc_ = stripBmp_ ? CreateCompatibleDC(dc) : nullptr;
      if (stripDc_) { stripOld_ = SelectObject(stripDc_, stripBmp_); stripW_ = w; stripH_ = h; }
      else { App::log("error: strip DIB %dx%d", w, h); freeStripDib(); }
    }
    if (stripDc_) {
      RECT sr{ 0, 0, w, h };
      if (ID2D1DCRenderTarget* rt = Gfx::instance().stripTarget(stripDc_, sr)) {
        rt->BeginDraw();
        rt->Clear(D2D1::ColorF(0, 0, 0, 0));   // glass wherever the tab row draws nothing
        Ui::instance().drawStrip(rt);
        if (rt->EndDraw() == D2DERR_RECREATE_TARGET) Gfx::instance().discardStripTarget();
      }
      BitBlt(dc, 0, 0, w, h, stripDc_, 0, 0, SRCCOPY);
    }
  }
  EndPaint(hwnd_, &ps);
  QueryPerformanceCounter(&t1);
  Driver::instance().notePaint(true, t0.QuadPart, t1.QuadPart);   // the driver's modelMs
}

// Every paint draws the whole body, so it also answers whatever was pending
// (an invalidate during it pends again); its end starts the next frame.
void Window::paintBody() {
  PAINTSTRUCT ps;
  BeginPaint(body_, &ps);
  if (bodyTimer_) { KillTimer(nullptr, bodyTimer_); bodyTimer_ = 0; }
  bodyPendingAny_ = bodyPendingAll_ = false;
  bodyPainting_ = true;
  App::instance().paintBody();   // the panes (Task 12), then the chrome (Task 15)
  bodyPainting_ = false;
  EndPaint(body_, &ps);
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  bodyPaintEnd_ = t.QuadPart;
}

bool Window::menuKeys(UINT msg, WPARAM w, LPARAM l) {
  bool alt = w == VK_MENU || w == VK_LMENU || w == VK_RMENU;
  bool chord = Driver::keyDown(VK_CONTROL) || Driver::keyDown(VK_SHIFT);
  if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
    if (!alt) altTap_ = false;
    else if (!(l & (1 << 30))) altTap_ = !chord && !mouseHeld();   // the first Alt down arms the tap; its auto-repeats leave it be
  } else if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && alt) {
    bool tap = altTap_ && !chord;
    altTap_ = false;
    if (tap) {
      AppMenu& menu = AppMenu::instance();
      if (menu.open()) menu.dismiss("Alt");   // the test-mode menu; a shown one runs its own loop
      else Ui::instance().altTap();
      return true;   // a lone Alt never reaches DefWindowProc's menu-bar mode
    }
  }
  return AppMenu::instance().key(msg, w);
}

// A button already down (a selection drag, a strip drag) or a window holding
// the capture: an Alt pressed now is not a tap.
bool Window::mouseHeld() {
  return GetKeyState(VK_LBUTTON) < 0 || GetKeyState(VK_RBUTTON) < 0 || GetKeyState(VK_MBUTTON) < 0 || GetCapture() != nullptr;
}

void Window::noteMouse(UINT msg) {
  if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN ||
      msg == WM_LBUTTONDBLCLK || msg == WM_RBUTTONDBLCLK || msg == WM_MBUTTONDBLCLK || msg == WM_MOUSEWHEEL ||
      msg == WM_NCLBUTTONDOWN || msg == WM_NCRBUTTONDOWN)
    altTap_ = false;
}

LRESULT CALLBACK Window::hostProc(HWND h, UINT msg, WPARAM w, LPARAM l) {
  Window& self = instance();
  if (!self.hwnd_) self.hwnd_ = h;   // messages sent during CreateWindowEx
  return self.onHost(h, msg, w, l);
}

LRESULT CALLBACK Window::bodyProc(HWND h, UINT msg, WPARAM w, LPARAM l) {
  Window& self = instance();
  if (!self.body_) self.body_ = h;
  return self.onBody(h, msg, w, l);
}

LRESULT Window::onHost(HWND h, UINT msg, WPARAM w, LPARAM l) {
  // DWM first: its caption buttons in the extended frame hit, hover and paint.
  LRESULT dwm = 0;
  bool dwmHandled = DwmDefWindowProc(h, msg, w, l, &dwm) != FALSE;
  if (msg == WM_NCHITTEST && dwmHandled && dwm != HTNOWHERE) return dwm;

  switch (msg) {
    case WM_NCCALCSIZE:
      if (w) {
        if (IsZoomed(h)) {
          auto* p = reinterpret_cast<NCCALCSIZE_PARAMS*>(l);
          UINT d = GetDpiForWindow(h);
          int fx = GetSystemMetricsForDpi(SM_CXSIZEFRAME, d) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, d);
          int fy = GetSystemMetricsForDpi(SM_CYSIZEFRAME, d) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, d);
          p->rgrc[0].left += fx; p->rgrc[0].right -= fx; p->rgrc[0].top += fy; p->rgrc[0].bottom -= fy;
        }
        return 0;   // the whole window is client
      }
      break;
    case WM_NCHITTEST:
      return hitTest(POINT{ GET_X_LPARAM(l), GET_Y_LPARAM(l) });
    case WM_SETFOCUS:
      // Activation focuses the top-level window; the keys belong to the body.
      if (body_) SetFocus(body_);
      return 0;
    case WM_ACTIVATE:
      App::instance().onActivate(LOWORD(w) != WA_INACTIVE);
      extendFrame();
      break;
    case WM_DWMCOMPOSITIONCHANGED:
      extendFrame();
      App::instance().sendColorization();   // glass or the opaque strip (Task 16)
      invalidateStrip();
      break;
    case WM_DWMCOLORIZATIONCOLORCHANGED:
      App::instance().sendColorization();   // the chrome follows the desktop color
      break;
    case WM_SETTINGCHANGE:
      // The Windows app theme changed: the tab strip's System mode follows it (Task 12b).
      // lParam is read only when non-null (SPI changes may send 0), and only
      // "ImmersiveColorSet" re-reads it; "Policy", "intl" and the rest do nothing
      // here (Phase 3 Review Focus 5). An ordinal compare: the area name is an
      // identifier, not text in the user's locale.
      if (l && CompareStringOrdinal(reinterpret_cast<LPCWSTR>(l), -1, L"ImmersiveColorSet", -1, TRUE) == CSTR_EQUAL)
        App::instance().sendColorization();
      break;
    case WM_NCLBUTTONDOWN:
      altTap_ = false;
      if (w == HTCAPTION) Ui::instance().captionPress();
      else AppMenu::instance().noteDown();
      break;
    case WM_NCLBUTTONDBLCLK:
      // strip:empty's double-click is the core's new tab, not maximize.
      if (w == HTCAPTION) { Ui::instance().captionDblClick(); return 0; }
      break;
    case WM_NCMOUSEMOVE:
      Ui::instance().mouseLeave(true);
      break;
    case WM_MOUSELEAVE:
      Ui::instance().mouseLeave(true);
      return 0;
    case WM_DPICHANGED: {
      dpi_ = HIWORD(w);
      auto* r = reinterpret_cast<RECT*>(l);
      extendFrame();
      SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      readRefreshHz();   // a new monitor, perhaps at another rate
      relayout();
      return 0;
    }
    case WM_DISPLAYCHANGE:
      readRefreshHz();
      break;
    case WM_WINDOWPOSCHANGED:
      if (!IsZoomed(h) && !IsIconic(h)) GetWindowRect(h, &normal_);
      break;   // DefWindowProc turns it into WM_SIZE and WM_MOVE
    case WM_SIZE:
      relayout();
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      paintStrip();
      return 0;
    case WM_COPYDATA: {
      auto* cds = reinterpret_cast<const COPYDATASTRUCT*>(l);
      if (!cds || cds->dwData != kCopyDataEnvelope || !cds->lpData) return FALSE;
      App::instance().onPeerEnvelope(std::string(static_cast<const char*>(cds->lpData), cds->cbData));
      return TRUE;
    }
    case WM_CLOSE:
      App::instance().requestQuit();   // the core's quit drain runs first (Task 8)
      return 0;
    case WM_DESTROY:
      if (bodyTimer_) { KillTimer(nullptr, bodyTimer_); bodyTimer_ = 0; }
      freeStripDib();
      App::instance().onWindowDestroyed();
      return 0;
    default:
      if (msg >= WM_APP_CORE_LINE && msg <= WM_APP_PTY_FEED) return App::instance().onAppMessage(msg, w, l);
      if (msg == WM_MOUSEMOVE) {
        TRACKMOUSEEVENT t{ sizeof t, TME_LEAVE, h, 0 };
        TrackMouseEvent(&t);
      }
      noteMouse(msg);
      if (msg >= WM_KEYFIRST && msg <= WM_KEYLAST && menuKeys(msg, w, l)) return 0;
      if ((msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) || (msg >= WM_KEYFIRST && msg <= WM_KEYLAST)) {
        if (App::instance().onInput(h, msg, w, l)) return 0;
      }
      break;
  }
  if (dwmHandled) return dwm;
  return DefWindowProcW(h, msg, w, l);
}

LRESULT Window::onBody(HWND h, UINT msg, WPARAM w, LPARAM l) {
  switch (msg) {
    case WM_NCHITTEST: {
      // The body reaches the window's left, right and bottom edges; leave the
      // resize borders to the top-level window's hit test.
      if (hwnd_ && !IsZoomed(hwnd_)) {
        LRESULT ht = hitTest(POINT{ GET_X_LPARAM(l), GET_Y_LPARAM(l) });
        if (ht != HTCLIENT && ht != HTCAPTION) return HTTRANSPARENT;
      }
      return HTCLIENT;
    }
    case WM_SIZE:
      Gfx::instance().resizeBody(LOWORD(l), HIWORD(l));
      InvalidateRect(h, nullptr, FALSE);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      paintBody();
      return 0;
    case WM_DISPLAYCHANGE:
      InvalidateRect(h, nullptr, FALSE);
      return 0;
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
      altTap_ = false;
      App::instance().onInput(h, msg, w, l);   // the focused pane's grid takes the keys; focus loss resets the wheel ramp
      return 0;
    case WM_CAPTURECHANGED:
      if ((HWND)l != h) {   // a lost drag ends like focus loss
        Ui::instance().cancelDrag();
        App::instance().onInput(h, WM_KILLFOCUS, 0, 0);
      }
      return 0;
    case WM_SETCURSOR:
      if (LOWORD(l) == HTCLIENT) {
        POINT pt;
        GetCursorPos(&pt);
        ScreenToClient(h, &pt);
        SetCursor(LoadCursorW(nullptr, Ui::instance().cursorFor(pt)));
        return TRUE;
      }
      break;
    case WM_MOUSELEAVE:
      Ui::instance().mouseLeave(false);
      return 0;
    default:
      if (msg == WM_MOUSEMOVE) {
        TRACKMOUSEEVENT t{ sizeof t, TME_LEAVE, h, 0 };
        TrackMouseEvent(&t);
      }
      noteMouse(msg);
      if (msg >= WM_KEYFIRST && msg <= WM_KEYLAST && menuKeys(msg, w, l)) return 0;
      if ((msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) || (msg >= WM_KEYFIRST && msg <= WM_KEYLAST)) {
        if (App::instance().onInput(h, msg, w, l)) return 0;
      }
      break;
  }
  return DefWindowProcW(h, msg, w, l);
}
