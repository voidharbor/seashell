// The changes preview: one WebView2, created only while the model's changes
// column has a preview open and destroyed as soon as it has none (a closed
// preview, an un-zoomed pane, a dead core), so nothing of Edge's lives in the
// background (the RAM budget). It shows src/preview's page from
// resources\preview through a virtual host, takes `view:cmd { op: 'post' }`
// from the core and hands it to the page as it is, and sends the page's
// messages back as `view:event`. Every navigation away from the page is
// cancelled; an http or https one goes to the core (`view:event navigate`),
// which opens it in the browser. UI thread only.
#pragma once
#include <windows.h>
#include <wrl/client.h>
#include <WebView2.h>
#include <nlohmann/json.hpp>
#include <cstdint>
#include <map>
#include <string>

class PreviewHost {
public:
  static PreviewHost& instance();
  // Follows the model: `want` a preview at `bounds` (body client pixels),
  // shown or hidden (a sheet or a popup is over it). Not wanted: destroyed.
  // `bg` (0x00RRGGBB) is what shows before the page paints.
  void sync(bool want, RECT bounds, bool visible, uint32_t bg);
  void post(const nlohmann::json& viewCmd);   // view:cmd; dropped while the page is not there
  void destroy();
  // The driver's view: {exists, ready, visible, bounds, url}.
  nlohmann::json state() const;
  // The driver's script: runs `js` in the page; the result (JSON text) lands
  // under the returned id for scriptResult. 0 when there is no page.
  int runScript(const std::string& js);
  nlohmann::json scriptResult(int id) const;

private:
  PreviewHost() = default;
  void create();
  void attach(ICoreWebView2Controller* ctl);
  void place();
  static std::wstring folder();
  static bool ours(const std::wstring& uri);

  enum class Phase { None, Creating, Ready };
  Phase phase_ = Phase::None;
  unsigned gen_ = 0;   // bumped by destroy: a creation that finishes after it is thrown away
  RECT bounds_{};
  bool visible_ = true;
  bool pageLoaded_ = false;
  bool failed_ = false;    // creation failed (no runtime, a bad folder): not retried until the preview closes
  uint32_t bg_ = 0x18191B;
  std::wstring url_;
  Microsoft::WRL::ComPtr<ICoreWebView2Environment> env_;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> ctl_;
  Microsoft::WRL::ComPtr<ICoreWebView2> wv_;
  int nextScript_ = 1;
  std::map<int, nlohmann::json> scripts_;   // id -> {done, result}
};
