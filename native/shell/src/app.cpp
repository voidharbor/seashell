#include "app.h"
#include "driver.h"
#include "gfx.h"
#include "log.h"
#include "paths.h"
#include "window.h"
#include "version.h"
#include <shobjidl.h>
#include <cstdarg>
#include <cstdint>
#include <cstdlib>
#include <memory>

using Microsoft::WRL::ComPtr;

namespace {
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

// "#rrggbb" from the model's token table, else fallback (0x00RRGGBB).
uint32_t tokenColor(const UiModel& m, const char* name, uint32_t fallback) {
  auto it = m.tokens.find(name);
  if (it == m.tokens.end() || it->second.size() != 7 || it->second[0] != '#') return fallback;
  char* end = nullptr;
  unsigned long v = strtoul(it->second.c_str() + 1, &end, 16);
  return end && *end == 0 ? (uint32_t)v : fallback;
}

D2D1_COLOR_F colorF(uint32_t c) {
  return D2D1::ColorF(((c >> 16) & 0xFF) / 255.f, ((c >> 8) & 0xFF) / 255.f, (c & 0xFF) / 255.f, 1.f);
}
}

App& App::instance() { static App a; return a; }

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
    return false;
  }
  wire_.sendGeometry();   // the controller boots on the first geometry
  return true;
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
  // Task 15 paints "core exited" on every pane and shows this as the toast.
  log("coreDead: The SeaShell core stopped (code %lu). Restart a pane or quit.", code);
  Window::instance().invalidateStrip();
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

// Keys go to the focused pane's grid (chords run without one); mouse messages
// to the grid under the pointer. The strip's own targets are Task 15's.
bool App::onInput(HWND from, UINT msg, WPARAM w, LPARAM l) {
  if (msg == WM_SETFOCUS || msg == WM_KILLFOCUS) {
    input_.focus(msg == WM_SETFOCUS);
    return false;
  }
  if (msg >= WM_KEYFIRST && msg <= WM_KEYLAST) {
    if (findKey(msg, w, l)) return true;
    return input_.key(focusedGrid(), msg, w, l);
  }
  if (msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) {
    // Only the body's client coordinates map onto the grids; a wheel carries screen coordinates.
    if (from != Window::instance().body() && msg != WM_MOUSEWHEEL) return false;
    return input_.mouse(msg, w, l);
  }
  return false;
}

LRESULT App::onAppMessage(UINT msg, WPARAM w, LPARAM l) {
  if (msg == Window::WM_APP_CORE_LINE) {
    std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(l));
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
  for (const PaneModel& p : model_.panes)
    if (p.focused && p.kind == "term") return grid(p.id);
  return nullptr;
}

std::string App::defaultPaneId() const {
  for (const PaneModel& p : model_.panes)
    if (p.focused && grids_.count(p.id)) return p.id;
  return grids_.empty() ? std::string() : grids_.begin()->first;
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

// The find bar's keys while it is open. Until Task 15 draws the bar and its
// edit widget, the text lives here: typing and Backspace send the whole query
// as `text` on find:query, Enter, Shift+Enter and Escape go as `key` events.
// Chords still run; nothing else reaches the pty while the bar is open.
bool App::findKey(UINT msg, WPARAM w, LPARAM l) {
  if (!model_.find.open) { findSwallowChar_ = false; return false; }
  bool ctrl = Driver::keyDown(VK_CONTROL), alt = Driver::keyDown(VK_MENU), shift = Driver::keyDown(VK_SHIFT);
  nlohmann::json mods = { { "ctrl", ctrl }, { "alt", alt }, { "shift", shift } };
  auto key = [&](const char* k) {
    findSwallowChar_ = true;
    wire_.sendEvent({ { "type", "key" }, { "target", "find:query" }, { "key", k }, { "mods", mods } });
  };
  if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
    findSwallowChar_ = false;
    if (w == VK_SHIFT || w == VK_CONTROL || w == VK_MENU || w == VK_LWIN || w == VK_RWIN) return false;
    if (findChords_.command(chordFromMessage(w, l, ctrl, alt, shift))) return false;   // GridInput runs it
    if (msg == WM_SYSKEYDOWN) return false;   // Alt+Space and the window menu
    if (w == VK_RETURN) { key(shift ? "Shift+Enter" : "Enter"); return true; }
    if (w == VK_ESCAPE) { key("Escape"); return true; }
    if (w == VK_BACK) {
      findSwallowChar_ = true;
      if (!findQuery_.empty()) {
        size_t n = findQuery_.size() - 1;
        while (n > 0 && ((unsigned char)findQuery_[n] & 0xC0) == 0x80) n--;   // one whole code point
        findQuery_.resize(n);
        sendFindQuery();
      }
      return true;
    }
    return true;   // arrows, Delete, Ctrl+letter: the bar has no caret yet
  }
  if (msg == WM_CHAR) {
    if (findSwallowChar_) { findSwallowChar_ = false; return true; }
    wchar_t ch = (wchar_t)w;
    if (ch < 0x20 || ch == 0x7F) return true;   // control characters type nothing
    std::wstring units;
    if (ch >= 0xD800 && ch <= 0xDBFF) { findHigh_ = ch; return true; }
    if (ch >= 0xDC00 && ch <= 0xDFFF) {
      if (!findHigh_) return true;
      units.push_back(findHigh_);
    }
    findHigh_ = 0;
    units.push_back(ch);
    findQuery_ += toUtf8(units);
    sendFindQuery();
    return true;
  }
  return false;   // key ups and WM_SYSCHAR stay with GridInput
}

void App::sendFindQuery() {
  wire_.sendEvent({ { "type", "text" }, { "target", "find:query" }, { "text", findQuery_ } });
}

// BeginDraw, the chrome background, every visible pane's grid at its model
// rect, a plain title bar per pane until Task 15 draws the chrome, EndDraw.
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
  rt->Clear(colorF(tokenColor(model_, "--chrome", 0xece2f0)));
  ComPtr<ID2D1SolidColorBrush> title;
  rt->CreateSolidColorBrush(colorF(tokenColor(model_, "--chromeAlt", 0xe1d3e8)), title.GetAddressOf());
  auto dev = [&](const Rect& r) {
    return D2D1::RectF((float)(r.x * scale), (float)(r.y * scale) - top, (float)((r.x + r.w) * scale), (float)((r.y + r.h) * scale) - top);
  };
  for (const PaneModel& p : model_.panes) {
    if (model_.zoomedPaneId && *model_.zoomedPaneId != p.id) continue;   // hidden behind the zoomed pane
    if (p.kind != "term") continue;
    auto it = views_.find(p.id);
    if (it == views_.end()) continue;
    GridView& v = *it->second;
    D2D1_RECT_F pr = dev(p.rect), gr = dev(p.gridRect);
    if (title && gr.top > pr.top) rt->FillRectangle(D2D1::RectF(pr.left, pr.top, pr.right, gr.top), title.Get());
    if (p.fontPx > 0) v.setFontPx((float)(p.fontPx * scale));
    v.setDpiScale(scale);
    v.setRect(gr);
    v.setExited(p.status == "exited");
    v.setBlinkPhase(blinkOn_);
    if (Grid* g = grid(p.id)) v.setAppScrollbar(g->altScreen() && g->mouseMode() != VTERM_PROP_MOUSE_NONE);
    auto f = finders_.find(p.id);
    v.draw(rt, p.focused, input_.selection(p.id), f == finders_.end() ? nullptr : &f->second.decor(), 0);
  }
  HRESULT hr = rt->EndDraw();
  QueryPerformanceCounter(&t1);
  QueryPerformanceFrequency(&freq);
  Driver::instance().noteFrame((t1.QuadPart - t0.QuadPart) * 1000.0 / freq.QuadPart);   // the driver's stats
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
  HWND h = Window::instance().hwnd();
  if (!h || IsIconic(h)) return;
  for (const PaneModel& p : a.model_.panes) {
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
  wire_.onModel = [this](const UiModel& m) {
    double oldFont = model_.window.fontPx;
    model_ = m;
    input_.setChords(m.chords);
    findChords_.set(m.chords);
    // The find bar opened: its text starts from the core's query (empty after a close).
    if (m.find.open && !findWasOpen_) findQuery_ = m.find.query;
    if (!m.find.open) { findQuery_.clear(); findHigh_ = 0; }
    findWasOpen_ = m.find.open;
    Window::instance().invalidateStrip();   // Task 15 draws it
    Window::instance().invalidateBody();
    if (!firstModel_) {
      firstModel_ = true;
      wire_.sendGeometry();
    } else if (m.window.fontPx > 0 && m.window.fontPx != oldFont) {
      wire_.sendGeometry();   // the core re-lays out with the cell of the new font
    }
  };
  wire_.onPtyData = [this](const std::string& paneId, const std::string& bytes) { onPtyData(paneId, bytes); };
  wire_.onGridCmd = [this](const nlohmann::json& cmd) { onGridCmd(cmd); };
  startCore();
  SetTimer(nullptr, 0, kBlinkMs, blinkTick);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  Driver::instance().stop();
  core_.stop(2000);   // a no-op once the drain above let it exit
  log("shell exit %d", exitCode_);
  CoUninitialize();
  CloseHandle(mutex_);
  return exitCode_;
}
