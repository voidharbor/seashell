#include "preview_host.h"
#include "app.h"
#include "chords.h"
#include "paths.h"
#include "ui/ui.h"
#include "window.h"
#include <wrl.h>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using nlohmann::json;

namespace {
// The page's own origin; .example is reserved, so it can never be a real host.
const wchar_t kHost[] = L"seashell-preview.example";
const wchar_t kPage[] = L"https://seashell-preview.example/index.html";

std::wstring exeDir() {
  std::wstring p(32768, L'\0');
  DWORD n = GetModuleFileNameW(nullptr, p.data(), (DWORD)p.size());
  p.resize(n);
  size_t slash = p.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : p.substr(0, slash);
}

std::wstring take(LPWSTR s) {
  std::wstring out = s ? s : L"";
  if (s) CoTaskMemFree(s);
  return out;
}

bool isHttp(const std::wstring& u) { return _wcsnicmp(u.c_str(), L"http://", 7) == 0 || _wcsnicmp(u.c_str(), L"https://", 8) == 0; }

void viewEvent(const json& p) { App::instance().wire().send("view:event", p); }

// The edit chords stay with the page (its own copy and select all); every
// other app chord works with the preview focused.
bool pageKeeps(const std::string& cmd) { return cmd.rfind("edit.", 0) == 0; }
}  // namespace

PreviewHost& PreviewHost::instance() { static PreviewHost h; return h; }

std::wstring PreviewHost::folder() {
  std::wstring env = envW(L"SEASHELL_PREVIEW_DIR");
  return env.empty() ? exeDir() + L"\\resources\\preview" : env;
}

bool PreviewHost::ours(const std::wstring& uri) {
  std::wstring pre = std::wstring(L"https://") + kHost + L"/";
  return _wcsnicmp(uri.c_str(), pre.c_str(), pre.size()) == 0;
}

void PreviewHost::sync(bool want, RECT bounds, bool visible, uint32_t bg) {
  if (!want) {
    failed_ = false;
    if (phase_ != Phase::None) destroy();
    return;
  }
  bounds_ = bounds;
  visible_ = visible;
  bg_ = bg;
  if (phase_ == Phase::None && !failed_) create();
  else place();
}

void PreviewHost::create() {
  HWND body = Window::instance().body();
  if (!body) return;
  std::wstring dir = folder();
  if (GetFileAttributesW((dir + L"\\index.html").c_str()) == INVALID_FILE_ATTRIBUTES) {
    App::log("error: preview: %s\\index.html is missing (SEASHELL_PREVIEW_DIR or resources\\preview); no preview", toUtf8(dir).c_str());
    failed_ = true;
    return;
  }
  phase_ = Phase::Creating;
  unsigned gen = ++gen_;
  std::wstring data = userDataWin() + L"\\webview2";
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, data.c_str(), nullptr,
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([this, gen, body](HRESULT r, ICoreWebView2Environment* env) -> HRESULT {
        if (gen != gen_ || phase_ != Phase::Creating) return S_OK;   // closed while it was coming up
        if (FAILED(r) || !env) {
          App::log("error: preview: no WebView2 environment (0x%08lx)", (unsigned long)r);
          phase_ = Phase::None;
          failed_ = true;
          return S_OK;
        }
        env_ = env;
        return env->CreateCoreWebView2Controller(
            body, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([this, gen](HRESULT r2, ICoreWebView2Controller* ctl) -> HRESULT {
                    if (gen != gen_ || phase_ != Phase::Creating) {
                      if (ctl) ctl->Close();
                      return S_OK;
                    }
                    if (FAILED(r2) || !ctl) {
                      App::log("error: preview: no WebView2 controller (0x%08lx)", (unsigned long)r2);
                      destroy();
                      failed_ = true;
                      return S_OK;
                    }
                    attach(ctl);
                    return S_OK;
                  }).Get());
      }).Get());
  if (FAILED(hr)) {
    App::log("error: preview: WebView2 did not start (0x%08lx); is the WebView2 Runtime installed?", (unsigned long)hr);
    phase_ = Phase::None;
    failed_ = true;
  }
}

void PreviewHost::attach(ICoreWebView2Controller* ctl) {
  ctl_ = ctl;
  if (FAILED(ctl_->get_CoreWebView2(&wv_)) || !wv_) {
    destroy();
    failed_ = true;
    return;
  }
  bool devtools = false;
#ifndef NDEBUG
  devtools = envW(L"SEASHELL_PREVIEW_DEVTOOLS") == L"1";
#endif
  ComPtr<ICoreWebView2Settings> st;
  if (SUCCEEDED(wv_->get_Settings(&st))) {
    st->put_IsScriptEnabled(TRUE);
    st->put_IsWebMessageEnabled(TRUE);
    st->put_AreDefaultScriptDialogsEnabled(FALSE);
    st->put_IsStatusBarEnabled(FALSE);
    st->put_IsZoomControlEnabled(FALSE);
    st->put_AreHostObjectsAllowed(FALSE);
    st->put_AreDefaultContextMenusEnabled(devtools ? TRUE : FALSE);
    st->put_AreDevToolsEnabled(devtools ? TRUE : FALSE);
    ComPtr<ICoreWebView2Settings3> st3;
    if (SUCCEEDED(st.As(&st3))) st3->put_AreBrowserAcceleratorKeysEnabled(FALSE);   // no reload, find or print of its own
  }
  ComPtr<ICoreWebView2_3> wv3;
  if (FAILED(wv_.As(&wv3)) ||
      FAILED(wv3->SetVirtualHostNameToFolderMapping(kHost, folder().c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))) {
    App::log("error: preview: this WebView2 cannot map a virtual host; no preview");
    destroy();
    failed_ = true;
    return;
  }
  ComPtr<ICoreWebView2Controller2> ctl2;
  if (SUCCEEDED(ctl_.As(&ctl2)))
    ctl2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{ 255, (BYTE)(bg_ >> 16), (BYTE)(bg_ >> 8), (BYTE)bg_ });

  EventRegistrationToken tok{};
  // Only the page itself loads in the top frame; anything else is cancelled,
  // and an http or https address goes to the core for the browser.
  wv_->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                                  [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) -> HRESULT {
                                    LPWSTR u = nullptr;
                                    a->get_Uri(&u);
                                    std::wstring uri = take(u);
                                    if (ours(uri)) return S_OK;
                                    a->put_Cancel(TRUE);
                                    App::log("preview: navigation cancelled %s", toUtf8(uri).c_str());
                                    if (isHttp(uri)) viewEvent({ { "type", "navigate" }, { "uri", toUtf8(uri) } });
                                    return S_OK;
                                  }).Get(), &tok);
  // The rendered frame is the page's render.html and nothing else.
  wv_->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                                       [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) -> HRESULT {
                                         LPWSTR u = nullptr;
                                         a->get_Uri(&u);
                                         std::wstring uri = take(u);
                                         if (ours(uri) || uri == L"about:blank" || uri == L"about:srcdoc") return S_OK;
                                         a->put_Cancel(TRUE);
                                         App::log("preview: frame navigation cancelled %s", toUtf8(uri).c_str());
                                         if (isHttp(uri)) viewEvent({ { "type", "navigate" }, { "uri", toUtf8(uri) } });
                                         return S_OK;
                                       }).Get(), &tok);
  // No windows of its own: an http or https one opens in the browser.
  wv_->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                  [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT {
                                    a->put_Handled(TRUE);
                                    LPWSTR u = nullptr;
                                    a->get_Uri(&u);
                                    std::wstring uri = take(u);
                                    if (isHttp(uri) && !ours(uri)) viewEvent({ { "type", "navigate" }, { "uri", toUtf8(uri) } });
                                    return S_OK;
                                  }).Get(), &tok);
  wv_->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                  [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
                                    LPWSTR src = nullptr;
                                    a->get_Source(&src);
                                    if (!ours(take(src))) return S_OK;
                                    LPWSTR js = nullptr;
                                    if (FAILED(a->get_WebMessageAsJson(&js))) return S_OK;
                                    json m = json::parse(toUtf8(take(js)), nullptr, false);
                                    if (m.is_object()) viewEvent({ { "type", "message" }, { "message", m } });
                                    return S_OK;
                                  }).Get(), &tok);
  wv_->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                   [this](ICoreWebView2* w, ICoreWebView2NavigationCompletedEventArgs* a) -> HRESULT {
                                     BOOL ok = FALSE;
                                     a->get_IsSuccess(&ok);
                                     pageLoaded_ = ok == TRUE;
                                     LPWSTR u = nullptr;
                                     if (w && SUCCEEDED(w->get_Source(&u))) url_ = take(u);
                                     return S_OK;
                                   }).Get(), &tok);
  wv_->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
                                   [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* a) -> HRESULT {
                                     a->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                     return S_OK;
                                   }).Get(), &tok);
  ComPtr<ICoreWebView2_4> wv4;
  if (SUCCEEDED(wv_.As(&wv4)))
    wv4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>(
                                  [](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* a) -> HRESULT {
                                    a->put_Cancel(TRUE);
                                    return S_OK;
                                  }).Get(), &tok);
  // A crashed page: the core is told, and the host goes on the next turn of
  // the loop (not inside WebView2's own callback).
  wv_->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
                             [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
                               App::log("preview: the WebView2 process failed");
                               viewEvent({ { "type", "gone" } });
                               SetTimer(nullptr, 0, 0, [](HWND, UINT, UINT_PTR id, DWORD) {
                                 KillTimer(nullptr, id);
                                 PreviewHost::instance().destroy();
                               });
                               return S_OK;
                             }).Get(), &tok);
  // The app's chords still work with the preview focused.
  ctl_->add_AcceleratorKeyPressed(Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                                      [](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* a) -> HRESULT {
                                        COREWEBVIEW2_KEY_EVENT_KIND kind{};
                                        a->get_KeyEventKind(&kind);
                                        if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
                                        bool ctrl = GetKeyState(VK_CONTROL) < 0, alt = GetKeyState(VK_MENU) < 0, shift = GetKeyState(VK_SHIFT) < 0;
                                        if (!ctrl && !alt) return S_OK;   // plain keys are the page's
                                        UINT vk = 0;
                                        INT lp = 0;
                                        a->get_VirtualKey(&vk);
                                        a->get_KeyEventLParam(&lp);
                                        std::optional<std::string> cmd = Ui::instance().chordCommand(chordFromMessage(vk, lp, ctrl, alt, shift));
                                        if (!cmd || pageKeeps(*cmd)) return S_OK;
                                        a->put_Handled(TRUE);
                                        App::instance().wire().sendCommand(*cmd);
                                        return S_OK;
                                      }).Get(), &tok);

  phase_ = Phase::Ready;
  place();
  wv_->Navigate(kPage);
  App::log("preview: WebView2 up");
}

void PreviewHost::place() {
  if (phase_ != Phase::Ready || !ctl_) return;
  ctl_->put_Bounds(bounds_);
  ctl_->put_IsVisible(visible_ ? TRUE : FALSE);
}

void PreviewHost::post(const json& cmd) {
  if (!cmd.is_object() || cmd.value("op", "") != "post" || !cmd.contains("message") || !cmd["message"].is_object()) return;
  if (phase_ != Phase::Ready || !wv_) return;   // the page asks again once it is ready
  std::wstring m = fromUtf8(cmd["message"].dump(-1, ' ', false, json::error_handler_t::replace));
  wv_->PostWebMessageAsJson(m.c_str());
}

void PreviewHost::destroy() {
  gen_++;
  if (ctl_) ctl_->Close();
  wv_.Reset();
  ctl_.Reset();
  env_.Reset();   // the last reference: Edge's processes for it exit
  if (phase_ != Phase::None) App::log("preview: WebView2 closed");
  phase_ = Phase::None;
  pageLoaded_ = false;
  url_.clear();
  scripts_.clear();
}

json PreviewHost::state() const {
  return { { "exists", phase_ != Phase::None },
           { "ready", phase_ == Phase::Ready },
           { "loaded", pageLoaded_ },
           { "visible", phase_ == Phase::Ready && visible_ },
           { "bounds", { { "x", bounds_.left }, { "y", bounds_.top }, { "w", bounds_.right - bounds_.left }, { "h", bounds_.bottom - bounds_.top } } },
           { "url", toUtf8(url_) },
           { "failed", failed_ } };
}

int PreviewHost::runScript(const std::string& js) {
  if (phase_ != Phase::Ready || !wv_) return 0;
  int id = nextScript_++;
  scripts_[id] = { { "done", false } };
  unsigned gen = gen_;
  wv_->ExecuteScript(fromUtf8(js).c_str(), Callback<ICoreWebView2ExecuteScriptCompletedHandler>([this, id, gen](HRESULT r, LPCWSTR result) -> HRESULT {
                                             if (gen != gen_) return S_OK;
                                             scripts_[id] = { { "done", true }, { "ok", SUCCEEDED(r) },
                                                              { "result", json::parse(toUtf8(result ? result : L"null"), nullptr, false) } };
                                             return S_OK;
                                           }).Get());
  return id;
}

json PreviewHost::scriptResult(int id) const {
  auto it = scripts_.find(id);
  return it == scripts_.end() ? json{ { "done", false }, { "missing", true } } : it->second;
}
