#include "driver.h"
#include "app.h"
#include "hostapi.h"
#include "paths.h"
#include "window.h"
#include <ws2tcpip.h>
#include <bcrypt.h>
#include <psapi.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "psapi.lib")

using nlohmann::json;

namespace {
const DWORD kUiTimeoutMs = 15000;     // a UI-thread command that has not run by then is reported, not waited on
const ULONGLONG kStatsWindowMs = 5000;
const int kModCtrl = 1, kModShift = 2, kModAlt = 4;

json fail(const std::string& code) { return { { "ok", false }, { "code", code } }; }

std::string strArg(const json& j, const char* k) {
  auto it = j.find(k);
  return it != j.end() && it->is_string() ? it->get<std::string>() : std::string();
}

std::string randomHex(size_t bytes) {
  std::vector<unsigned char> b(bytes);
  if (!BCRYPT_SUCCESS(BCryptGenRandom(nullptr, b.data(), (ULONG)b.size(), BCRYPT_USE_SYSTEM_PREFERRED_RNG))) return {};
  std::string out;
  char hex[3];
  for (unsigned char c : b) { snprintf(hex, sizeof hex, "%02x", c); out += hex; }
  return out;
}

// Constant time, so a wrong token learns nothing from the reply's timing.
bool sameToken(const std::string& a, const std::string& b) {
  if (a.size() != b.size() || a.empty()) return false;
  unsigned char d = 0;
  for (size_t i = 0; i < a.size(); i++) d |= (unsigned char)(a[i] ^ b[i]);
  return d == 0;
}

bool sendAll(SOCKET s, const std::string& data) {
  size_t off = 0;
  while (off < data.size()) {
    int n = ::send(s, data.data() + off, (int)std::min<size_t>(data.size() - off, 1 << 20), 0);
    if (n <= 0) return false;
    off += (size_t)n;
  }
  return true;
}

double percentile(std::vector<double> v, double q) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  size_t i = (size_t)std::min<double>((double)v.size() - 1, q * (double)(v.size() - 1) + 0.5);
  return v[i];
}

// "Ctrl+Shift+T", "Enter", "a", "Alt+F4": the key's virtual-key code and the
// modifier bits, or vk 0 when a part is unknown.
struct KeyChord { UINT vk = 0; int mods = 0; };

KeyChord parseChord(const std::string& chord) {
  static const struct { const char* name; UINT vk; } kNamed[] = {
    { "enter", VK_RETURN }, { "return", VK_RETURN }, { "escape", VK_ESCAPE }, { "esc", VK_ESCAPE },
    { "tab", VK_TAB }, { "backspace", VK_BACK }, { "delete", VK_DELETE }, { "del", VK_DELETE },
    { "insert", VK_INSERT }, { "home", VK_HOME }, { "end", VK_END }, { "pageup", VK_PRIOR },
    { "pagedown", VK_NEXT }, { "arrowup", VK_UP }, { "up", VK_UP }, { "arrowdown", VK_DOWN },
    { "down", VK_DOWN }, { "arrowleft", VK_LEFT }, { "left", VK_LEFT }, { "arrowright", VK_RIGHT },
    { "right", VK_RIGHT }, { "space", VK_SPACE }, { "plus", VK_OEM_PLUS }, { "minus", VK_OEM_MINUS },
  };
  KeyChord c;
  std::vector<std::string> parts;
  size_t start = 0;
  // A trailing "+" is the plus key itself ("Ctrl++").
  for (size_t i = 0; i < chord.size(); i++) {
    if (chord[i] == '+' && i > start) { parts.push_back(chord.substr(start, i - start)); start = i + 1; }
  }
  if (start < chord.size()) parts.push_back(chord.substr(start));
  if (parts.empty()) return c;
  for (size_t i = 0; i + 1 < parts.size(); i++) {
    std::string m = parts[i];
    std::transform(m.begin(), m.end(), m.begin(), [](unsigned char ch) { return (char)tolower(ch); });
    if (m == "ctrl" || m == "control") c.mods |= kModCtrl;
    else if (m == "shift") c.mods |= kModShift;
    else if (m == "alt") c.mods |= kModAlt;
    else return KeyChord{};
  }
  const std::string& k = parts.back();
  std::wstring wk = fromUtf8(k);
  if (wk.size() == 1) {
    SHORT r = VkKeyScanW(wk[0]);
    if (r == -1) return KeyChord{};
    c.vk = LOBYTE(r);
    if (HIBYTE(r) & 1) c.mods |= kModShift;   // "A" or "!" needs Shift on this layout
    return c;
  }
  std::string lk = k;
  std::transform(lk.begin(), lk.end(), lk.begin(), [](unsigned char ch) { return (char)tolower(ch); });
  for (const auto& n : kNamed)
    if (lk == n.name) { c.vk = n.vk; return c; }
  if (lk.size() >= 2 && lk[0] == 'f') {
    int f = atoi(lk.c_str() + 1);
    if (f >= 1 && f <= 24) { c.vk = VK_F1 + (UINT)(f - 1); return c; }
  }
  return KeyChord{};
}

bool extendedKey(UINT vk) {
  switch (vk) {
    case VK_INSERT: case VK_DELETE: case VK_HOME: case VK_END: case VK_PRIOR: case VK_NEXT:
    case VK_UP: case VK_DOWN: case VK_LEFT: case VK_RIGHT: return true;
    default: return false;
  }
}

// The lParam a real keystroke carries: repeat 1, scan code, extended, context
// (Alt held), previous state and transition.
LPARAM keyLParam(UINT vk, bool up, bool alt) {
  UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  LPARAM l = 1 | ((LPARAM)(scan & 0xFF) << 16);
  if (extendedKey(vk)) l |= (LPARAM)1 << 24;
  if (alt) l |= (LPARAM)1 << 29;
  if (up) l |= ((LPARAM)1 << 30) | ((LPARAM)1 << 31);
  return l;
}

// A JSON pointer into the model; nullptr when it does not resolve.
const json* resolve(const json& doc, const std::string& ptr) {
  try {
    json::json_pointer p(ptr);
    if (!doc.contains(p)) return nullptr;
    return &doc.at(p);
  } catch (const std::exception&) {
    return nullptr;
  }
}
}  // namespace

Driver& Driver::instance() { static Driver d; return d; }

bool Driver::keyDown(int vk) {
  int held = instance().heldMods_;
  if (held >= 0) {
    if (vk == VK_CONTROL || vk == VK_LCONTROL) return (held & kModCtrl) != 0;
    if (vk == VK_SHIFT || vk == VK_LSHIFT) return (held & kModShift) != 0;
    if (vk == VK_MENU || vk == VK_LMENU) return (held & kModAlt) != 0;
    if (vk == VK_RCONTROL || vk == VK_RSHIFT || vk == VK_RMENU) return false;
  }
  return GetKeyState(vk) < 0;
}

bool Driver::start() {
  std::wstring portStr = envW(L"SEASHELL_TEST_PORT");
  int port = _wtoi(portStr.c_str());
  if (port < 0 || port > 65535) { App::log("error: driver: SEASHELL_TEST_PORT %s is not a port", toUtf8(portStr).c_str()); return false; }
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { App::log("error: driver: WSAStartup %d", WSAGetLastError()); return false; }
  token_ = randomHex(32);
  if (token_.empty()) { App::log("error: driver: BCryptGenRandom failed"); return false; }
  listen_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listen_ == INVALID_SOCKET) { App::log("error: driver: socket %d", WSAGetLastError()); return false; }
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // loopback only, never another interface
  addr.sin_port = htons((u_short)port);
  int alen = sizeof addr;
  if (bind(listen_, (sockaddr*)&addr, sizeof addr) != 0 || ::listen(listen_, 8) != 0 ||
      getsockname(listen_, (sockaddr*)&addr, &alen) != 0) {
    App::log("error: driver: listen on 127.0.0.1:%d failed %d", port, WSAGetLastError());
    closesocket(listen_);
    listen_ = INVALID_SOCKET;
    return false;
  }
  int bound = ntohs(addr.sin_port);

  std::wstring dir = userDataWin();
  CreateDirectoryW(dir.c_str(), nullptr);   // saveBounds and the core create it too; fine when it exists
  testJson_ = dir + L"\\test.json";
  std::string body = json{ { "port", bound }, { "token", token_ } }.dump();
  HANDLE f = CreateFileW(testJson_.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  DWORD wrote = 0;
  bool ok = f != INVALID_HANDLE_VALUE && WriteFile(f, body.data(), (DWORD)body.size(), &wrote, nullptr) && wrote == body.size();
  if (f != INVALID_HANDLE_VALUE) CloseHandle(f);
  if (!ok) {
    App::log("error: driver: writing %s failed %lu", toUtf8(testJson_).c_str(), GetLastError());
    closesocket(listen_);
    listen_ = INVALID_SOCKET;
    return false;
  }
  running_ = true;
  acceptor_ = std::thread([this] { acceptLoop(); });
  App::log("driver listening on 127.0.0.1:%d", bound);
  return true;
}

void Driver::stop() {
  if (!running_.exchange(false)) return;
  if (listen_ != INVALID_SOCKET) { closesocket(listen_); listen_ = INVALID_SOCKET; }   // accept() returns
  if (acceptor_.joinable()) acceptor_.join();
  if (!testJson_.empty()) DeleteFileW(testJson_.c_str());
  App::log("driver stopped");
}

void Driver::acceptLoop() {
  while (running_) {
    SOCKET s = accept(listen_, nullptr, nullptr);
    if (s == INVALID_SOCKET) {
      if (!running_) break;
      Sleep(50);
      continue;
    }
    // One thread per connection: `wait` blocks its own connection only.
    std::thread([this, s] { serve(s); }).detach();
  }
}

void Driver::serve(SOCKET s) {
  std::string buf;
  char chunk[4096];
  bool open = true;
  while (open && running_) {
    int n = recv(s, chunk, sizeof chunk, 0);
    if (n <= 0) break;
    buf.append(chunk, (size_t)n);
    if (buf.size() > (8u << 20)) { App::log("error: driver: request over 8 MB; closed"); break; }
    size_t nl;
    while (open && (nl = buf.find('\n')) != std::string::npos) {
      std::string line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      json req = json::parse(line, nullptr, false);
      if (req.is_discarded() || !req.is_object()) {
        sendAll(s, fail("EBADJSON").dump() + "\n");
        continue;
      }
      if (!sameToken(strArg(req, "token"), token_)) {
        App::log("error: driver: request with a bad token refused");
        sendAll(s, fail("ETOKEN").dump() + "\n");
        open = false;
        break;
      }
      std::string cmd = strArg(req, "cmd");
      json reply = handle(req);
      if (!sendAll(s, reply.dump(-1, ' ', false, json::error_handler_t::replace) + "\n")) { open = false; break; }
      if (cmd == "quit") {
        // After the reply is on the wire: WM_CLOSE runs the core's drain and ends the process.
        Window::instance().post(WM_CLOSE);
        open = false;
      }
    }
  }
  shutdown(s, SD_SEND);
  closesocket(s);
}

json Driver::handle(const json& req) {
  std::string cmd = strArg(req, "cmd");
  if (cmd != "model" && cmd != "stats") App::log("driver %s", cmd.c_str());
  if (cmd == "quit") return { { "ok", true } };
  if (cmd == "wait") {
    std::string ptr = strArg(req, "path");
    auto eq = req.find("equals");
    bool hasEq = eq != req.end();
    int timeoutMs = req.contains("timeoutMs") && req["timeoutMs"].is_number() ? req["timeoutMs"].get<int>() : 10000;
    ULONGLONG end = GetTickCount64() + (ULONGLONG)std::max(0, timeoutMs);
    json last;
    for (;;) {
      json m = onUi({ { "cmd", "model" } });
      if (const json* v = resolve(m, ptr)) {
        last = *v;
        // Without `equals`, any non-null value at the pointer satisfies the wait.
        if (hasEq ? (*v == *eq) : !v->is_null()) return { { "ok", true }, { "value", *v } };
      }
      if (GetTickCount64() >= end) return { { "ok", false }, { "code", "ETIMEOUT" }, { "value", last } };
      Sleep(50);
    }
  }
  if (cmd == "waitText") {
    std::string want = strArg(req, "contains");
    json gridReq = { { "cmd", "grid" }, { "paneId", strArg(req, "paneId") } };
    int timeoutMs = req.contains("timeoutMs") && req["timeoutMs"].is_number() ? req["timeoutMs"].get<int>() : 10000;
    ULONGLONG end = GetTickCount64() + (ULONGLONG)std::max(0, timeoutMs);
    json last;
    for (;;) {
      json g = onUi(gridReq);
      if (g.value("ok", false)) {
        last = g["text"];
        std::string all;
        for (const json& row : g["text"]) { all += row.get<std::string>(); all += '\n'; }
        if (all.find(want) != std::string::npos) return { { "ok", true }, { "paneId", g["paneId"] } };
      }
      if (GetTickCount64() >= end) return { { "ok", false }, { "code", "ETIMEOUT" }, { "text", last } };
      Sleep(50);
    }
  }
  return onUi(req);
}

json Driver::onUi(const json& req) {
  HWND h = Window::instance().hwnd();
  if (!h || !IsWindow(h)) return fail("ENOWINDOW");
  auto* c = new DriverCall();
  c->req = req;
  c->done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  c->refs = 2;   // this thread and the UI thread
  if (!c->done || !PostMessageW(h, Window::WM_APP_DRIVER, 0, (LPARAM)c)) {
    c->release();
    c->release();
    return fail("EPOST");
  }
  json reply;
  if (WaitForSingleObject(c->done, kUiTimeoutMs) == WAIT_OBJECT_0) reply = c->reply;
  else reply = fail("EUITIMEOUT");
  c->release();
  return reply;
}

void Driver::onCall(DriverCall* c) {
  try {
    c->reply = execute(c->req);
  } catch (const std::exception& ex) {
    App::log("error: driver %s failed: %s", strArg(c->req, "cmd").c_str(), ex.what());
    c->reply = { { "ok", false }, { "code", "EFAILED" }, { "error", ex.what() } };
  }
  SetEvent(c->done);
  c->release();
}

json Driver::execute(const json& req) {
  std::string cmd = strArg(req, "cmd");
  if (cmd == "model") {
    const json& m = App::instance().wire().lastModelJson();
    return m.is_object() ? m : fail("ENOMODEL");
  }
  if (cmd == "shot") {
    std::string path = strArg(req, "path");
    if (path.empty()) return fail("ENOPATH");
    return HostApi::handle("test:screenshot", { { "path", path } });   // PrintWindow with PW_RENDERFULLCONTENT to PNG
  }
  if (cmd == "key") return key(strArg(req, "chord"));
  if (cmd == "text") return text(strArg(req, "s"));
  if (cmd == "click") return click(req, "click");
  if (cmd == "dblclick") return click(req, "dblclick");
  if (cmd == "stats") return stats();
  if (cmd == "coreKill") return coreKill();
  if (cmd == "grid") return grid(strArg(req, "paneId"));
  // width arrives with libvterm's driver hook, drag and click by point with
  // the hit rects (Task 15).
  if (cmd == "width" || cmd == "drag") return fail("ENOTYET");
  return fail("EUNKNOWN");
}

// Through the shell's own window procedure (WM_KEYDOWN, WM_CHAR, WM_KEYUP to
// the body, the window that holds keyboard focus), never SendInput. Modifier
// state for the chord comes from Driver::keyDown, since sent messages leave the
// real keyboard state alone.
json Driver::key(const std::string& chordText) {
  KeyChord c = parseChord(chordText);
  if (!c.vk) return fail("EBADCHORD");
  HWND body = Window::instance().body();
  if (!body) return fail("ENOWINDOW");
  bool alt = (c.mods & kModAlt) != 0;
  struct Mod { int bit; UINT vk; } mods[] = { { kModCtrl, VK_CONTROL }, { kModShift, VK_SHIFT }, { kModAlt, VK_MENU } };
  heldMods_ = 0;
  for (const Mod& m : mods) {
    if (!(c.mods & m.bit)) continue;
    heldMods_ |= m.bit;
    bool sys = (heldMods_ & kModAlt) != 0;   // Alt and anything pressed while it is held are system keys
    SendMessageW(body, sys ? WM_SYSKEYDOWN : WM_KEYDOWN, m.vk, keyLParam(m.vk, false, sys));
  }
  SendMessageW(body, alt ? WM_SYSKEYDOWN : WM_KEYDOWN, c.vk, keyLParam(c.vk, false, alt));
  // The character TranslateMessage would produce for this key and modifier
  // state on the current layout (Ctrl+A gives 0x01, Shift+a gives 'A').
  BYTE ks[256] = {};
  if (c.mods & kModCtrl) ks[VK_CONTROL] = ks[VK_LCONTROL] = 0x80;
  if (c.mods & kModShift) ks[VK_SHIFT] = ks[VK_LSHIFT] = 0x80;
  if (alt) ks[VK_MENU] = ks[VK_LMENU] = 0x80;
  wchar_t chars[8] = {};
  int n = ToUnicode(c.vk, MapVirtualKeyW(c.vk, MAPVK_VK_TO_VSC), ks, chars, 8, 0x4 /* keep the keyboard state */);
  for (int i = 0; i < n; i++) SendMessageW(body, alt ? WM_SYSCHAR : WM_CHAR, chars[i], keyLParam(c.vk, false, alt));
  SendMessageW(body, alt ? WM_SYSKEYUP : WM_KEYUP, c.vk, keyLParam(c.vk, true, alt));
  for (int i = 2; i >= 0; i--) {
    if (!(c.mods & mods[i].bit)) continue;
    heldMods_ &= ~mods[i].bit;
    bool sys = mods[i].vk == VK_MENU;
    SendMessageW(body, sys ? WM_SYSKEYUP : WM_KEYUP, mods[i].vk, keyLParam(mods[i].vk, true, (heldMods_ & kModAlt) != 0));
  }
  heldMods_ = -1;
  return { { "ok", true } };
}

// One WM_CHAR per UTF-16 unit, as TranslateMessage delivers typed text.
json Driver::text(const std::string& s) {
  HWND body = Window::instance().body();
  if (!body) return fail("ENOWINDOW");
  for (wchar_t ch : fromUtf8(s)) SendMessageW(body, WM_CHAR, ch, 1);
  return { { "ok", true } };
}

// By target: the ui:event the view would send for a click on that target.
// By point: x, y in client DIPs, or row, col (a viewport cell of paneId, the
// focused pane by default), as the button messages a real click sends to the
// body, so the grid input path (Task 13) sees exactly what a mouse would do.
json Driver::click(const json& req, const char* type) {
  std::string target = strArg(req, "target");
  int button = req.contains("button") && req["button"].is_number_integer() ? req["button"].get<int>() : 0;
  if (button < 0 || button > 2) return fail("EBADBUTTON");
  json mods = { { "ctrl", false }, { "alt", false }, { "shift", false } };
  if (req.contains("mods") && req["mods"].is_object())
    for (const char* k : { "ctrl", "alt", "shift" })
      if (req["mods"].contains(k) && req["mods"][k].is_boolean()) mods[k] = req["mods"][k];
  if (!target.empty()) {
    App::instance().wire().sendEvent({ { "type", type }, { "target", target }, { "x", 0 }, { "y", 0 }, { "button", button }, { "mods", mods } });
    return { { "ok", true }, { "target", target } };
  }
  Window& win = Window::instance();
  HWND body = win.body();
  if (!body) return fail("ENOWINDOW");
  float scale = win.dpi().scale();
  float bx, by;
  if (req.contains("row") && req["row"].is_number() && req.contains("col") && req["col"].is_number()) {
    App& a = App::instance();
    std::string id = strArg(req, "paneId");
    if (id.empty()) id = a.defaultPaneId();
    Grid* g = id.empty() ? nullptr : a.grid(id);
    GridView* v = id.empty() ? nullptr : a.view(id);
    if (!g || !v) return fail("ENOGRID");
    D2D1_RECT_F c = v->cellRect(g->viewTop() + req["row"].get<long>(), req["col"].get<int>());
    bx = (c.left + c.right) / 2;
    by = (c.top + c.bottom) / 2;
  } else if (req.contains("x") && req["x"].is_number() && req.contains("y") && req["y"].is_number()) {
    bx = req["x"].get<float>() * scale;
    by = req["y"].get<float>() * scale - (float)win.bodyRect().top;
    if (by < 0) return fail("ENOTYET");   // the strip's hit rects are Task 15's
  } else {
    return fail("ENOTARGET");
  }
  heldMods_ = (mods["ctrl"].get<bool>() ? kModCtrl : 0) | (mods["shift"].get<bool>() ? kModShift : 0) |
              (mods["alt"].get<bool>() ? kModAlt : 0);
  static const UINT kDown[] = { WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN };
  static const UINT kUp[] = { WM_LBUTTONUP, WM_MBUTTONUP, WM_RBUTTONUP };
  static const UINT kDbl[] = { WM_LBUTTONDBLCLK, WM_MBUTTONDBLCLK, WM_RBUTTONDBLCLK };
  static const WPARAM kMk[] = { MK_LBUTTON, MK_MBUTTON, MK_RBUTTON };
  WPARAM mk = kMk[button] | (heldMods_ & kModCtrl ? MK_CONTROL : 0) | (heldMods_ & kModShift ? MK_SHIFT : 0);
  WPARAM upMk = mk & ~kMk[button];
  LPARAM pt = MAKELPARAM((int)std::lround(bx), (int)std::lround(by));
  SendMessageW(body, WM_MOUSEMOVE, upMk, pt);
  SendMessageW(body, kDown[button], mk, pt);
  SendMessageW(body, kUp[button], upMk, pt);
  if (strcmp(type, "dblclick") == 0) {
    SendMessageW(body, kDbl[button], mk, pt);
    SendMessageW(body, kUp[button], upMk, pt);
  }
  heldMods_ = -1;
  return { { "ok", true }, { "x", bx / scale }, { "y", (by + win.bodyRect().top) / scale } };
}

void Driver::noteFrame(double ms) {
  if (!running_) return;
  ULONGLONG now = GetTickCount64();
  frames_.push_back({ now, ms });
  while (!frames_.empty() && now - frames_.front().at > kStatsWindowMs) frames_.pop_front();
}

void Driver::notePtyBytes(size_t n) {
  if (!running_) return;
  ULONGLONG now = GetTickCount64();
  ptyBytes_.push_back({ now, (double)n });
  while (!ptyBytes_.empty() && now - ptyBytes_.front().at > kStatsWindowMs) ptyBytes_.pop_front();
}

json Driver::stats() {
  ULONGLONG now = GetTickCount64();
  std::vector<double> ms;
  for (const Sample& f : frames_) if (now - f.at <= kStatsWindowMs) ms.push_back(f.v);
  double bytes = 0;
  for (const Sample& b : ptyBytes_) if (now - b.at <= kStatsWindowMs) bytes += b.v;
  PROCESS_MEMORY_COUNTERS pmc{ sizeof pmc };
  double wsMB = GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc) ? pmc.WorkingSetSize / (1024.0 * 1024.0) : 0;
  // The focused pane's grid: its mouse tracking mode (VTERM_PROP_MOUSE_*, 0 is
  // none) and its selection's text ("" when nothing is selected).
  App& a = App::instance();
  std::string id = a.defaultPaneId();
  Grid* g = id.empty() ? nullptr : a.grid(id);
  return { { "frameMs", { { "p50", percentile(ms, 0.5) }, { "p95", percentile(ms, 0.95) } } },
           { "framesLast5s", ms.size() }, { "ptyBytesLast5s", (long long)bytes }, { "shellWsMB", std::round(wsMB * 10) / 10 },
           { "paneId", id }, { "mouseMode", g ? g->mouseMode() : 0 }, { "selection", a.input().selectionText(id) } };
}

// The visible rows of a pane's grid (the focused pane when paneId is empty),
// trailing spaces trimmed, as the viewport shows them.
json Driver::grid(const std::string& paneIdArg) {
  App& a = App::instance();
  std::string id = paneIdArg.empty() ? a.defaultPaneId() : paneIdArg;
  Grid* g = id.empty() ? nullptr : a.grid(id);
  if (!g) return fail("ENOGRID");
  const GridStore& s = g->store();
  json text = json::array();
  for (long r = g->viewTop(); r < g->viewTop() + s.rows(); r++) {
    std::string t = s.text(r);
    while (!t.empty() && t.back() == ' ') t.pop_back();
    text.push_back(t);
  }
  return { { "ok", true }, { "paneId", id }, { "text", text },
           { "cursor", { { "row", g->cursor().row }, { "col", g->cursor().col } } },
           { "scrollback", s.scrollbackLen() }, { "cols", s.cols() }, { "rows", s.rows() },
           { "viewTop", g->viewTop() }, { "storeBytes", s.bytes() } };
}

// TerminateProcess on wsl.exe, the shell's own child, exactly as a crash looks
// to the shell (Review Focus 1): the exit is not expected, so it relaunches or
// marks the core dead by the spec 4.5 rule.
json Driver::coreKill() {
  App& a = App::instance();
  if (!a.coreAlive()) return fail("ENOCORE");
  DWORD pid = a.corePid();   // the live run still holds its process handle, so the pid cannot be reused
  HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
  if (!h) return { { "ok", false }, { "code", "EOPEN" }, { "error", std::to_string(GetLastError()) } };
  BOOL ok = TerminateProcess(h, 1);
  DWORD err = GetLastError();
  CloseHandle(h);
  if (!ok) return { { "ok", false }, { "code", "ETERMINATE" }, { "error", std::to_string(err) } };
  App::log("driver coreKill: wsl.exe pid %lu terminated", pid);
  return { { "ok", true }, { "pid", pid } };
}
