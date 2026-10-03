#include "app.h"
#include "audio.h"
#include "driver.h"
#include "gfx.h"
#include "log.h"
#include "paths.h"
#include "ui/menu.h"
#include "ui/sheet.h"
#include "ui/ui.h"
#include "window.h"
#include "version.h"
#include <dwmapi.h>
#include <shobjidl.h>
#include <windowsx.h>
#include <cstdarg>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>

using Microsoft::WRL::ComPtr;
using json = nlohmann::json;

namespace {
// The terminal palette every grid draws with: Homebrew, or UiModel.window.palette (Settings).
TermPalette g_palette = kHomebrew;

// What the first instance publishes under Local\SeaShellHost-<instance>-hwnd so
// a second launch finds its window exactly, never by title: Josh's Electron
// SeaShell is also titled "SeaShell".
struct Handoff { uint64_t hwnd; uint32_t pid; };
const char* kSecondInstance = "{\"k\":\"send\",\"ch\":\"app:secondInstance\",\"p\":{}}";
// main's quit drain is capped at 4 s on win32; the core then exits on its own.
const UINT kQuitGraceMs = 5000;
// A core that dies this soon after starting gets one relaunch (spec 4.5).
const ULONGLONG kEarlyDeathMs = 5000;
// Bytes kept for a pane whose grid:cmd create has not arrived yet.
const size_t kMaxEarlyBytes = 4u << 20;
// xterm.js's cursor blink interval.
const UINT kBlinkMs = 530;
// The search addon re-runs the search this long after the last pty write.
const UINT kFindRefreshMs = 200;
// QPC when the UI thread took the core line being handled (the driver's modelMs).
LONGLONG g_lineAt = 0;
}

App& App::instance() { static App a; return a; }
const UiModel& App::model() const { return Ui::instance().model(); }

void App::log(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  logV(fmt, ap);
  va_end(ap);
}

int App::run(HINSTANCE hinst) { return instance().main(hinst); }

void App::quit(int code) {
  App& a = instance();
  a.exitCode_ = code;
  HWND h = Window::instance().hwnd();
  if (h && IsWindow(h)) {
    saveBounds(Window::instance().bounds());
    DestroyWindow(h);   // WM_DESTROY posts the quit
  } else {
    PostQuitMessage(code);
  }
}

// WM_CLOSE: run the core's quit drain (app:beforeQuit, which snapshots the
// session and reaps the panes), then close once it exits or the grace runs out.
void App::requestQuit() {
  log("quit requested");
  if (quitting_) return;
  if (!core_.alive()) { quit(0); return; }
  quitting_ = true;
  core_.beginQuit();
  log("app:beforeQuit sent");
  quitTimer_ = SetTimer(nullptr, 0, kQuitGraceMs, quitTimeout);
}

void CALLBACK App::quitTimeout(HWND, UINT, UINT_PTR id, DWORD) {
  App& a = instance();
  KillTimer(nullptr, id);
  a.quitTimer_ = 0;
  log("core still running %u ms after app:beforeQuit; ending it", kQuitGraceMs);
  a.core_.stop(0);
  quit(0);
}

bool App::startCore() {
  firstModel_ = false;
  wire_.clearModel();   // the driver's model and wait never answer from an earlier core
  if (!core_.start()) {
    coreDead_ = true;
    log("coreDead: the core did not start");
    Ui::instance().setCoreDead(true, 0);
    Window::instance().invalidateBody();
    return false;
  }
  wire_.sendGeometry();   // the controller boots on the first geometry
  sendColorization();
  return true;
}

// The colorization is HKCU\Software\Microsoft\Windows\DWM\ColorizationColor
// (redesign spec 6.2; read only, never written): DwmGetColorizationColor
// returns it already blended by the color balance (#881798 reads back as
// #7C158A here), which would miss the 6.2 table. DWM's value is the fallback.
json App::dwmColorization() {
  DWORD argb = 0, size = sizeof argb;
  BOOL opaque = FALSE, comp = FALSE;
  json out = json::object();
  DWORD dwmArgb = 0;
  bool haveDwm = SUCCEEDED(DwmGetColorizationColor(&dwmArgb, &opaque));
  bool haveReg = RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\DWM", L"ColorizationColor",
                              RRF_RT_REG_DWORD, nullptr, &argb, &size) == ERROR_SUCCESS;
  if (!haveReg && haveDwm) argb = dwmArgb;
  if (haveReg || haveDwm) {
    char hex[16];
    snprintf(hex, sizeof hex, "#%08lX", (unsigned long)argb);
    out["argb"] = hex;
  } else {
    out["argb"] = nullptr;   // the core falls back to the 6.2 table
  }
  out["opaque"] = haveDwm && opaque != FALSE;
  // A failed query paints the opaque strip: readable whatever the frame does.
  // So does a DWM that has no colorization to give (off, a remote session),
  // even with the registry value still there (Review Focus 5).
  out["composition"] = haveDwm && SUCCEEDED(DwmIsCompositionEnabled(&comp)) && comp != FALSE;
  // Windows' app theme (Settings > Personalization > Colors), read only: the
  // core darkens the tab strip on it when the Tab strip setting is System.
  // A missing value is the light theme.
  DWORD light = 1, lsize = sizeof light;
  bool haveTheme = RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                                L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &lsize) == ERROR_SUCCESS;
  out["appsDark"] = haveTheme && light == 0;
  return out;
}

void App::sendColorization() {
  if (!core_.alive() || quitting_) return;
  json p = dwmColorization();
  if (argbForced_) p["argb"] = argbForce_;
  if (compositionOff_) p["composition"] = false;
  if (appsDarkForced_) p["appsDark"] = appsDarkForce_;
  wire_.send("shell:colorization", p);
  log("colorization sent %s", p.dump().c_str());
}

void App::overrideColorization(const json& argb) {
  argbForced_ = argb.is_string();
  argbForce_ = argbForced_ ? argb.get<std::string>() : std::string();
  sendColorization();
}

void App::overrideAppsDark(const json& dark, bool send) {
  appsDarkForced_ = dark.is_boolean();
  appsDarkForce_ = appsDarkForced_ && dark.get<bool>();
  if (send) sendColorization();
}

void App::overrideComposition(bool on) {
  compositionOff_ = !on;
  sendColorization();
}

void App::onCoreExit(DWORD code, LPARAM gen) {
  if (gen != core_.generation()) { log("core exit code %lu from an earlier run; ignored", code); return; }
  ULONGLONG ran = GetTickCount64() - core_.startedTick();
  log("core exit code %lu after %llu ms", code, ran);
  wire_.reset();
  if (quitting_) {
    if (quitTimer_) { KillTimer(nullptr, quitTimer_); quitTimer_ = 0; }
    quit(0);
    return;
  }
  // The shell sent app:beforeQuit or closed the pipe: a normal exit, not a crash.
  if (core_.exitExpected()) return;
  bool first = !coreDied_;
  coreDied_ = true;
  if (first && ran < kEarlyDeathMs) {
    log("core relaunch: it exited within %llu ms of starting", kEarlyDeathMs);
    if (startCore()) return;
  }
  coreDead_ = true;
  // Every pane shows "core exited" with Restart, and this is the toast.
  log("coreDead: The SeaShell core stopped (code %lu). Restart a pane or quit.", code);
  Ui::instance().setCoreDead(true, code);
  Window::instance().invalidateStrip();
  Window::instance().invalidateBody();
}

// Restart on a dead core's pane: a new core run. Its panes arrive with fresh
// grid:cmd creates, so the dead run's grids go now. A death after this one is
// final again (coreDied_ stays set).
void App::restartCore() {
  if (!coreDead_ || quitting_) return;
  log("core restart requested from a pane");
  coreDead_ = false;
  Ui::instance().setCoreDead(false, 0);
  for (const auto& g : grids_) input_.dropPane(g.first);
  views_.clear();
  grids_.clear();
  sbCap_.clear();
  finders_.clear();
  findRuns_.clear();
  feed_.clear();
  startCore();
  Window::instance().invalidateStrip();
  Window::instance().invalidateBody();
}

void App::onActivate(bool active) {
  if (windowActive_ == active) return;
  windowActive_ = active;
  Window::instance().invalidateBody();
}

void App::onResized() {
  HWND h = Window::instance().hwnd();
  if (!core_.alive() || quitting_ || !h || IsIconic(h)) return;
  RECT rc{};
  GetClientRect(h, &rc);
  if (rc.right <= rc.left || rc.bottom <= rc.top) return;
  wire_.sendGeometry();
}

// The chrome first (Ui: the edit widgets, the restore card, the strip and
// title bar targets), then the focused pane's grid for keys (chords run
// without one) and the grid under the pointer for the mouse.
bool App::onInput(HWND from, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_SETFOCUS || msg == WM_KILLFOCUS) {
    input_.focus(msg == WM_SETFOCUS);
    return false;
  }
  Mods mods{ Driver::keyDown(VK_CONTROL), Driver::keyDown(VK_MENU), Driver::keyDown(VK_SHIFT) };
  if (msg >= WM_KEYFIRST && msg <= WM_KEYLAST) {
    if (Ui::instance().key(msg, w, l, mods)) return true;
    return input_.key(focusedGrid(), msg, w, l);
  }
  if (msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) {
    Window& win = Window::instance();
    bool body = from == win.body();
    // Ui takes client pixels of the top-level window; a wheel carries screen coordinates.
    POINT pt{ GET_X_LPARAM(l), GET_Y_LPARAM(l) };
    if (body && msg != WM_MOUSEWHEEL) pt.y += win.bodyRect().top;
    int button = (msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK) ? 2
               : (msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP || msg == WM_MBUTTONDBLCLK) ? 1 : 0;
    if (Ui::instance().mouse(msg, pt, button, mods, msg == WM_MOUSEWHEEL ? GET_WHEEL_DELTA_WPARAM(w) : 0)) return true;
    // Only the body's client coordinates map onto the grids.
    if (!body && msg != WM_MOUSEWHEEL) return false;
    return input_.mouse(msg, w, l);
  }
  return false;
}

LRESULT App::onAppMessage(UINT msg, WPARAM w, LPARAM l) {
  if (msg == Window::WM_APP_CORE_LINE) {
    std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(l));
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    g_lineAt = now.QuadPart;
    lineQueueTicks_ = w ? now.QuadPart - (long long)w : 0;
    size_t n = line->size();
    wire_.onCoreLine(std::move(*line));
    CoreProc::lineHandled(n);
  } else if (msg == Window::WM_APP_CORE_EXIT) {
    onCoreExit((DWORD)w, l);
  } else if (msg == Window::WM_APP_DRIVER) {
    Driver::instance().onCall(reinterpret_cast<DriverCall*>(l));
  } else if (msg == Window::WM_APP_PTY_FEED) {
    drainFeed();
  }
  return 0;
}

Grid* App::grid(const std::string& paneId) {
  auto it = grids_.find(paneId);
  return it == grids_.end() ? nullptr : it->second.get();
}

GridView* App::view(const std::string& paneId) {
  auto it = views_.find(paneId);
  return it == views_.end() ? nullptr : it->second.get();
}

Grid* App::focusedGrid() {
  std::string id = focusedGridId();
  return id.empty() ? nullptr : grid(id);
}

// The drawer has the keys while the model says so, and then never the pane
// behind it, even before its grid exists.
std::string App::focusedGridId() const {
  const DrawerModel& d = model().drawer;
  if (d.open && d.focused) return d.ptyId ? *d.ptyId : std::string();
  for (const PaneModel& p : model().panes)
    if (p.focused && p.kind == "term") return grids_.count(p.id) ? p.id : std::string();
  return std::string();
}

std::string App::defaultPaneId() const {
  for (const PaneModel& p : model().panes)
    if (p.focused && grids_.count(p.id)) return p.id;
  return grids_.empty() ? std::string() : grids_.begin()->first;
}

// The core's one-off orders outside the model (ShellCmd in model.ts). XAudio2
// starts on the first ping, not at launch, so a window that never pings never
// loads the audio engine. `menu` is the application menu (ui/menu.h).
void App::onShellCmd(const nlohmann::json& cmd) {
  std::string op = cmd.is_object() && cmd.contains("op") && cmd["op"].is_string() ? cmd["op"].get<std::string>() : std::string();
  if (op == "ping") Audio::ping();
  else if (op == "menu") AppMenu::instance().set(cmd.contains("items") ? cmd["items"] : nlohmann::json());
  else log("shell:cmd %s ignored", op.c_str());
}

void App::onGridCmd(const nlohmann::json& cmd) {
  std::string op = cmd.value("op", "");
  std::string id = cmd.value("paneId", "");
  if (id.empty()) { log("error: grid:cmd %s without a paneId", op.c_str()); return; }
  auto num = [&](const char* k, int d) { return cmd.contains(k) && cmd[k].is_number() ? cmd[k].get<int>() : d; };
  if (op == "create") {
    // A second create for the same pane (a relaunched core) starts it afresh.
    views_.erase(id);   // it draws the grid about to be replaced
    finders_.erase(id);
    findRuns_.erase(id);
    auto g = std::make_unique<Grid>(id, num("cols", 80), num("rows", 24), num("scrollback", 20000));
    g->setOutput([this, id](const std::string& bytes) { wire_.ptyWrite(id, bytes); });
    g->onTitle = [this, id](const std::string& t) { wire_.sendTerm({ { "type", "title" }, { "paneId", id }, { "title", t } }); };
    g->onCwd = [this, id](const std::string& uri) { wire_.sendTerm({ { "type", "cwd" }, { "paneId", id }, { "cwd", uri } }); };
    g->onBell = [this, id] { wire_.sendTerm({ { "type", "bell" }, { "paneId", id } }); };
    log("grid create %s %dx%d", id.c_str(), g->store().cols(), g->store().rows());
    float scale = Window::instance().dpi().scale();
    views_[id] = std::make_unique<GridView>(*g, (float)(cmd.value("fontPx", 13.0) * scale));
    views_[id]->setPalette(g_palette);
    sbCap_[id] = (size_t)std::max(0, num("scrollback", 20000));
    input_.dropPane(id);   // a selection on the grid being replaced
    grids_[id] = std::move(g);
    if (feed_.count(id) && !feedPosted_) { feedPosted_ = true; Window::instance().post(Window::WM_APP_PTY_FEED); }
  } else if (op == "dispose") {
    input_.dropPane(id);
    views_.erase(id);
    grids_.erase(id);
    sbCap_.erase(id);
    finders_.erase(id);
    findRuns_.erase(id);
    feed_.erase(id);
    log("grid dispose %s", id.c_str());
  } else if (op == "resize") {
    Grid* g = grid(id);
    if (!g) { log("error: grid:cmd resize for unknown pane %s", id.c_str()); return; }
    g->resize(num("cols", g->store().cols()), num("rows", g->store().rows()));
    if (cmd.contains("fontPx") && cmd["fontPx"].is_number() && views_.count(id))
      views_[id]->setFontPx((float)(cmd["fontPx"].get<double>() * Window::instance().dpi().scale()));
  } else if (op == "find") {
    runFind(id, cmd);
  } else if (op == "findClear") {
    // The decorations and the selection go; the viewport stays where the find left it.
    finders_.erase(id);
    findRuns_.erase(id);
    input_.dropPane(id);
  } else if (input_.gridCmd(op, id, cmd)) {
    log("on grid:cmd %s %s", op.c_str(), id.c_str());   // paste, copy, selectAll, clear
    return;   // gridCmd repaints what it changed
  } else {
    // focus (keys follow the model's focused pane), exited: Task 15.
    log("on grid:cmd %s %s", op.c_str(), id.c_str());
    return;
  }
  Window::instance().invalidateBody();
}

// Bytes queue per pane; one WM_APP_PTY_FEED is in flight at a time, so a burst
// of pty:data lines is written into libvterm once.
void App::onPtyData(const std::string& paneId, const std::string& bytes) {
  Driver::instance().notePtyBytes(bytes.size());
  std::string& q = feed_[paneId];
  if (!grids_.count(paneId) && q.size() + bytes.size() > kMaxEarlyBytes) {
    log("error: pty:data for pane %s before its grid; %zu bytes dropped", paneId.c_str(), bytes.size());
    return;
  }
  q += bytes;
  if (!feedPosted_) {
    feedPosted_ = true;
    Window::instance().post(Window::WM_APP_PTY_FEED);
  }
}

void App::drainFeed() {
  feedPosted_ = false;
  bool dirty = false;
  for (auto it = feed_.begin(); it != feed_.end();) {
    Grid* g = grid(it->first);
    if (!g) { ++it; continue; }   // its create is still on the way
    size_t sb = g->store().scrollbackLen();
    std::string newest = g->store().text(-1);
    g->feed(it->second.data(), it->second.size());
    size_t cap = sbCap_.count(it->first) ? sbCap_[it->first] : 20000;
    input_.noteFed(*g, sb, newest, cap);
    auto f = finders_.find(it->first);
    if (f != finders_.end()) {
      size_t after = g->store().scrollbackLen();
      if (after > sb) {
        f->second.onScrollbackPushed((long)(after - sb), after);
      } else if (after >= cap && g->store().text(-1) != newest) {
        // At the cap the count cannot say how many rows moved (as for the
        // selection): drop the decorations and the anchor; the re-search below
        // finds the matches again.
        f->second.clear();
      }
      // Re-search once the output settles, as the addon's onWriteParsed does.
      if (findTimer_) KillTimer(nullptr, findTimer_);
      findTimer_ = SetTimer(nullptr, 0, kFindRefreshMs, findRefresh);
    }
    dirty = true;   // the grid keeps its damage; its GridView takes it on the next paint
    it = feed_.erase(it);
  }
  if (dirty) Window::instance().invalidateBody();
}

namespace {
void sendFindResult(Wire& wire, const std::string& paneId, const Finder::Result& r) {
  wire.sendTerm({ { "type", "findResult" }, { "paneId", paneId }, { "index", r.miss ? 0 : r.index },
                  { "total", r.miss ? 0 : r.total }, { "capped", !r.miss && r.capped } });
}
}

// grid:cmd find: from the pane's anchor (the active match), then the active
// match to mid-viewport when it is off screen. Answers with findResult.
void App::runFind(const std::string& paneId, const nlohmann::json& cmd) {
  auto flag = [&](const char* k) { return cmd.contains(k) && cmd[k].is_boolean() && cmd[k].get<bool>(); };
  std::string query = cmd.contains("query") && cmd["query"].is_string() ? cmd["query"].get<std::string>() : std::string();
  Finder::Options opt{ flag("caseSensitive"), flag("regex"), flag("incremental") };
  bool forward = cmd.value("direction", "next") != "prev";
  Finder::Result r{ 0, 0, false, true };
  LARGE_INTEGER t0, t1, freq;
  QueryPerformanceCounter(&t0);
  if (Grid* g = grid(paneId)) {
    Finder& f = finders_[paneId];
    long ar = LONG_MIN;
    int ac = 0;
    f.anchor(&ar, &ac);
    r = f.find(g->store(), query, opt, forward, ar, ac);
    if (r.miss) {
      finders_.erase(paneId);   // no decorations, no anchor: the next search starts afresh
      findRuns_.erase(paneId);
    } else {
      findRuns_[paneId] = { query, opt, r };
      scrollToMatch(paneId);
    }
  }
  QueryPerformanceCounter(&t1);
  QueryPerformanceFrequency(&freq);
  log("find %s: %s in %.1f ms", paneId.c_str(),
      r.miss ? "miss" : (std::to_string(r.index) + " of " + std::to_string(r.total) + (r.capped ? "+" : "")).c_str(),
      (t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart);
  sendFindResult(wire_, paneId, r);
}

// find-scroll.ts targetScrollLine: nothing when the match is on screen,
// otherwise it goes to mid-viewport (Grid::scrollView clamps).
void App::scrollToMatch(const std::string& paneId) {
  Grid* g = grid(paneId);
  auto f = finders_.find(paneId);
  if (!g || f == finders_.end()) return;
  long row = f->second.activeRow();
  if (row == LONG_MIN) return;
  long top = g->viewTop();
  int rows = g->store().rows();
  if (row >= top && row < top + rows) return;
  g->scrollView(row - rows / 2 - top);
}

// Output settled: every live find runs again from its anchor (incremental, no
// scroll), so the count and the decorations follow the newest buffer while the
// user's match stays put (find-anchor.ts). A changed result goes to the core.
void CALLBACK App::findRefresh(HWND, UINT, UINT_PTR id, DWORD) {
  App& a = instance();
  KillTimer(nullptr, id);
  a.findTimer_ = 0;
  bool any = false;
  for (auto it = a.findRuns_.begin(); it != a.findRuns_.end();) {
    Grid* g = a.grid(it->first);
    auto f = a.finders_.find(it->first);
    if (!g || f == a.finders_.end()) { it = a.findRuns_.erase(it); continue; }
    Finder::Options opt = it->second.opt;
    opt.incremental = true;
    long ar = LONG_MIN;
    int ac = 0;
    f->second.anchor(&ar, &ac);
    Finder::Result r = f->second.find(g->store(), it->second.query, opt, true, ar, ac);
    const Finder::Result& l = it->second.last;
    if (r.miss != l.miss || r.index != l.index || r.total != l.total || r.capped != l.capped)
      sendFindResult(a.wire_, it->first, r);
    it->second.last = r;
    any = true;
    ++it;
  }
  if (any) Window::instance().invalidateBody();
}

// BeginDraw, the chrome background, every visible pane's grid at its model
// rect, the chrome over them (Ui::drawBody, which ends with the drawer's
// panel), the drawer's grid, then the overlays (Ui::drawOverlays), EndDraw.
void App::paintBody() {
  ID2D1HwndRenderTarget* rt = Gfx::instance().bodyTarget();
  if (!rt) return;
  LARGE_INTEGER t0, t1, freq;
  QueryPerformanceCounter(&t0);
  Window& win = Window::instance();
  float scale = win.dpi().scale();
  float top = (float)win.bodyRect().top;   // model rects are in window client DIPs; the body starts below the strip
  rt->BeginDraw();
  rt->SetTransform(D2D1::Matrix3x2F::Identity());
  Ui& ui = Ui::instance();
  ui.drawBackground(rt);
  // The focused pane draws a solid cursor only while this window has the
  // keyboard (and no edit widget does). A test run never activates its window
  // (SW_SHOWNOACTIVATE), so it counts as active.
  bool keys = (windowActive_ || testMode_) && !ui.wantsBlink();
  const DrawerModel& dm = model().drawer;
  bool drawerKeys = dm.open && dm.focused;   // the pane behind keeps its hollow cursor
  auto dev = [&](const Rect& r) {
    return D2D1::RectF((float)(r.x * scale), (float)(r.y * scale) - top, (float)((r.x + r.w) * scale), (float)((r.y + r.h) * scale) - top);
  };
  for (const PaneModel& p : model().panes) {
    if (model().zoomedPaneId && *model().zoomedPaneId != p.id) continue;   // hidden behind the zoomed pane
    if (p.kind != "term") continue;
    auto it = views_.find(p.id);
    if (it == views_.end()) continue;
    GridView& v = *it->second;
    D2D1_RECT_F gr = dev(p.gridRect);
    if (p.fontPx > 0) v.setFontPx((float)(p.fontPx * scale));
    v.setDpiScale(scale);
    v.setRect(gr);
    v.setExited(p.status == "exited");
    v.setBlinkPhase(blinkOn_);
    if (Grid* g = grid(p.id)) v.setAppScrollbar(g->altScreen() && g->mouseMode() != VTERM_PROP_MOUSE_NONE);
    auto f = finders_.find(p.id);
    rt->PushAxisAlignedClip(gr, D2D1_ANTIALIAS_MODE_ALIASED);
    v.draw(rt, p.focused && keys && !drawerKeys, input_.selection(p.id), f == finders_.end() ? nullptr : &f->second.decor(), 0);
    rt->PopAxisAlignedClip();
  }
  ui.drawBody(rt);
  // The drawer's grid floats over the panes, under the find bar, the menu and the overlays.
  if (dm.open && dm.ptyId) {
    auto it = views_.find(*dm.ptyId);
    if (it != views_.end()) {
      GridView& v = *it->second;
      D2D1_RECT_F gr = dev(dm.gridRect);
      if (dm.fontPx > 0) v.setFontPx((float)(dm.fontPx * scale));
      v.setDpiScale(scale);
      v.setRect(gr);
      v.setExited(dm.status == "exited");
      v.setBlinkPhase(blinkOn_);
      if (Grid* g = grid(*dm.ptyId)) v.setAppScrollbar(g->altScreen() && g->mouseMode() != VTERM_PROP_MOUSE_NONE);
      auto f = finders_.find(*dm.ptyId);
      rt->PushAxisAlignedClip(gr, D2D1_ANTIALIAS_MODE_ALIASED);
      v.draw(rt, drawerKeys && keys, input_.selection(*dm.ptyId), f == finders_.end() ? nullptr : &f->second.decor(), 0);
      rt->PopAxisAlignedClip();
    }
  }
  ui.drawOverlays(rt);
  HRESULT hr = rt->EndDraw();
  QueryPerformanceCounter(&t1);
  QueryPerformanceFrequency(&freq);
  Driver::instance().noteFrame((t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart);   // the driver's stats
  Driver::instance().notePaint(false, t0.QuadPart, t1.QuadPart);
  if (hr == D2DERR_RECREATE_TARGET) {
    log("body target lost; recreating");
    Gfx::instance().discardBodyTarget();   // each GridView sees the new target and rebuilds its brushes
    win.invalidateBody();
  } else if (FAILED(hr)) {
    log("error: body EndDraw 0x%08lx", (unsigned long)hr);
  }
}

// Repaints only while some visible pane has a focused, blinking, live cursor.
void CALLBACK App::blinkTick(HWND, UINT, UINT_PTR, DWORD) {
  App& a = instance();
  a.blinkOn_ = !a.blinkOn_;
  Ui::instance().setCaretPhase(a.blinkOn_);
  HWND h = Window::instance().hwnd();
  if (!h || IsIconic(h)) return;
  if (Ui::instance().wantsBlink()) {   // an edit widget's caret
    Window::instance().invalidateStrip();
    Window::instance().invalidateBody();
    return;
  }
  const DrawerModel& d = a.model().drawer;
  bool drawerKeys = d.open && d.focused;
  if (drawerKeys && d.ptyId) {
    auto it = a.views_.find(*d.ptyId);
    if (it != a.views_.end() && it->second->wantsBlink(true)) Window::instance().invalidateBody();
    return;   // the pane behind does not blink
  }
  for (const PaneModel& p : a.model().panes) {
    auto it = a.views_.find(p.id);
    if (it != a.views_.end() && it->second->wantsBlink(p.focused)) { Window::instance().invalidateBody(); return; }
  }
}

// A second launch hands over app:secondInstance; nothing else is relayed.
void App::onPeerEnvelope(const std::string& json) {
  nlohmann::json e = nlohmann::json::parse(json, nullptr, false);
  bool ok = !e.is_discarded() && e.is_object() && e.value("k", "") == "send" && e.value("ch", "") == "app:secondInstance";
  if (!ok) { log("error: peer envelope refused: %.200s", json.c_str()); return; }
  if (!core_.alive()) { log("app:secondInstance dropped: no core"); return; }
  core_.send(json);
  log("app:secondInstance sent to the core");
}

void App::onWindowDestroyed() {
  if (handoff_) { CloseHandle(handoff_); handoff_ = nullptr; }
  PostQuitMessage(exitCode_);
}

void App::publishWindow(const std::wstring& inst) {
  std::wstring name = L"Local\\SeaShellHost-" + inst + L"-hwnd";
  handoff_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Handoff), name.c_str());
  if (!handoff_) { log("error: CreateFileMapping %lu", GetLastError()); return; }
  if (auto* h = static_cast<Handoff*>(MapViewOfFile(handoff_, FILE_MAP_WRITE, 0, 0, sizeof(Handoff)))) {
    h->pid = GetCurrentProcessId();
    h->hwnd = (uint64_t)(uintptr_t)Window::instance().hwnd();
    UnmapViewOfFile(h);
  }
}

// The mutex is taken: find the first instance's window through its handoff
// mapping (checking class and pid), hand it the envelope, and exit.
bool App::signalFirstInstance(const std::wstring& inst) {
  std::wstring name = L"Local\\SeaShellHost-" + inst + L"-hwnd";
  for (int tries = 0; tries < 50; tries++, Sleep(100)) {   // the first may still be creating its window
    HANDLE m = OpenFileMappingW(FILE_MAP_READ, FALSE, name.c_str());
    if (!m) continue;
    Handoff ho{};
    if (auto* v = static_cast<const Handoff*>(MapViewOfFile(m, FILE_MAP_READ, 0, 0, sizeof(Handoff)))) { ho = *v; UnmapViewOfFile(v); }
    CloseHandle(m);
    HWND h = (HWND)(uintptr_t)ho.hwnd;
    if (!h || !IsWindow(h)) continue;
    wchar_t cls[64] = {};
    DWORD pid = 0;
    GetClassNameW(h, cls, 64);
    GetWindowThreadProcessId(h, &pid);
    if (wcscmp(cls, L"SeaShellHost") != 0 || pid != ho.pid) { log("error: handoff window %p is not ours", (void*)h); return false; }
    COPYDATASTRUCT cds{ Window::kCopyDataEnvelope, (DWORD)strlen(kSecondInstance), (PVOID)kSecondInstance };
    DWORD_PTR res = 0;
    if (!SendMessageTimeoutW(h, WM_COPYDATA, 0, (LPARAM)&cds, SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &res)) {
      log("error: WM_COPYDATA to pid %lu failed %lu", pid, GetLastError());
      return false;
    }
    log("second instance: app:secondInstance sent to pid %lu", pid);
    return true;
  }
  log("error: instance %s is running but published no window", toUtf8(inst).c_str());
  return false;
}

int App::main(HINSTANCE hinst) {
  hinst_ = hinst;
  logOpen(envW(L"SEASHELL_SHELL_LOG"));
  testMode_ = !envW(L"SEASHELL_TEST_PORT").empty();
  std::wstring inst = instanceName();
  log("shell %s start pid %lu instance %s userData %s%s", SEASHELL_VERSION_STR, GetCurrentProcessId(),
      toUtf8(inst).c_str(), toUtf8(userDataWin()).c_str(), testMode_ ? " test" : "");

  mutex_ = CreateMutexW(nullptr, FALSE, (L"Local\\SeaShellHost-" + inst).c_str());
  if (!mutex_) { log("error: CreateMutex %lu", GetLastError()); return 1; }
  if (GetLastError() == ERROR_ALREADY_EXISTS) return signalFirstInstance(inst) ? 0 : 1;

  SetCurrentProcessExplicitAppUserModelID(L"dev.seashell.app");
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(hr)) { log("error: CoInitializeEx 0x%08lx", (unsigned long)hr); return 1; }
  if (!Gfx::instance().init()) return 1;
  if (!Window::instance().create(hinst, testMode_)) return 1;
  publishWindow(inst);
  if (testMode_) Driver::instance().start();   // a failed listener is logged; the shell still runs

  wire_.write = [this](const std::string& line) { core_.send(line); };
  wire_.onModel = [this](UiModel&& in) {
    // apply runs from where build ends (the line taken plus parse and build),
    // so the model Wire keeps for the driver and its log line count in it and
    // queue + parse + build + apply is the post to the end of this.
    LARGE_INTEGER l0, l1, a1;
    LONGLONG a0 = g_lineAt + wire_.parseTicks + wire_.buildTicks;
    double oldFont = model().window.fontPx;
    double oldStrip = model().window.tabStripH;
    input_.setChords(in.chords);
    QueryPerformanceCounter(&l0);
    Ui::instance().setModel(std::move(in));   // the one copy: model() reads it there
    QueryPerformanceCounter(&l1);
    const UiModel& m = model();
    if (m.window.tabStripH > 0 && m.window.tabStripH != oldStrip) Window::instance().onStripHeightChanged();
    // The Settings palette reaches every grid, the drawer's too; setPalette repaints only on a change.
    TermPalette pal = m.window.palette ? termPaletteFrom(*m.window.palette) : kHomebrew;
    if (memcmp(&pal, &g_palette, sizeof pal) != 0) {
      g_palette = pal;
      for (auto& [vid, v] : views_) v->setPalette(g_palette);
    }
    bool strip = Ui::instance().stripChanged();
    if (strip) Window::instance().invalidateStrip();   // a divider move leaves the strip alone
    Window::instance().invalidateBody();
    QueryPerformanceCounter(&a1);
    Driver& d = Driver::instance();
    d.noteModelInvalidated(strip);
    d.noteModelPath(Driver::ticksMs(lineQueueTicks_), Driver::ticksMs(wire_.parseTicks), Driver::ticksMs(wire_.buildTicks),
                    Driver::ticksMs(l1.QuadPart - l0.QuadPart), Driver::ticksMs(a1.QuadPart - a0));
    d.noteModel(m.seq);   // applied: a driver drag step waiting for it stops its clock here
    if (!firstModel_) {
      firstModel_ = true;
      wire_.sendGeometry();
    } else if (m.window.fontPx > 0 && m.window.fontPx != oldFont) {
      wire_.sendGeometry();   // the core re-lays out with the cell of the new font
    }
  };
  wire_.onPtyData = [this](const std::string& paneId, const std::string& bytes) { onPtyData(paneId, bytes); };
  wire_.onGridCmd = [this](const nlohmann::json& cmd) { onGridCmd(cmd); };
  wire_.onShellCmd = [this](const nlohmann::json& cmd) { onShellCmd(cmd); };
  startCore();
  SetTimer(nullptr, 0, kBlinkMs, blinkTick);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  Driver::instance().stop();
  core_.stop(2000);   // a no-op once the drain above let it exit
  Audio::shutdown();
  log("shell exit %d", exitCode_);
  CoUninitialize();
  CloseHandle(mutex_);
  return exitCode_;
}
