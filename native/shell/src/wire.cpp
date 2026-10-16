#include "wire.h"
#include "app.h"
#include "fonts.h"
#include "hostapi.h"
#include "window.h"

#include <set>

// Identical to src/core/protocol.ts (Task 18 compares the two literals).
// clang-format off
static const std::set<std::string> SHELL_CHANNELS = {
  "window:minimize", "window:toggleMaximize", "window:close", "window:isMaximized", "window:maximized",
  "app:pickFolder", "clip:read", "clip:write",
  "open:withDefaultApp", "open:revealInFinder", "open:externalHttp",
  "display:list", "display:colorization", "grid:cmd", "test:screenshot",
};
static const std::set<std::string> CORE_PUSH_TO_SHELL = { "pty:data", "ui:model", "grid:cmd", "shell:cmd", "view:cmd" };
// clang-format on

using nlohmann::json;

namespace {
// The per-model log line: the first model, then at most one line a second
// with the count of models not logged since the line before. A drag pushes
// models at pointer rate, and each line is OutputDebugStringA plus a blocking
// WriteFile on the UI thread, inside the driver's moveMs. UI thread only.
void logModel(const UiModel& m) {
  static ULONGLONG lastAt = 0;
  static unsigned skipped = 0;
  ULONGLONG now = GetTickCount64();
  if (lastAt && now - lastAt < 1000) { skipped++; return; }
  App::log("on ui:model seq=%.0f tabs=%zu panes=%zu (%u not logged since the last line)", m.seq, m.tabs.size(), m.panes.size(), skipped);
  lastAt = now;
  skipped = 0;
}
}  // namespace

std::string base64Decode(const std::string& in) {
  static const signed char* table = [] {
    static signed char t[256];
    for (int i = 0; i < 256; i++) t[i] = -1;
    const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) t[(unsigned char)a[i]] = (signed char)i;
    return t;
  }();
  std::string out;
  out.reserve(in.size() / 4 * 3);
  unsigned acc = 0;
  int bits = 0;
  for (unsigned char c : in) {
    signed char v = table[c];
    if (v < 0) continue;   // padding, whitespace
    acc = (acc << 6) | (unsigned)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((char)((acc >> bits) & 0xFF));
    }
  }
  return out;
}

void Wire::writeEnvelope(const json& e) {
  if (!write) return;
  // Invalid UTF-8 (a split surrogate from a grid) is replaced, never thrown.
  write(e.dump(-1, ' ', false, json::error_handler_t::replace));
}

void Wire::send(const std::string& ch, const json& p) {
  if (ch != "pty:write") App::log("send %s", ch.c_str());   // keystrokes stay out of the log
  writeEnvelope({ { "k", "send" }, { "ch", ch }, { "p", p } });
}

void Wire::sendEvent(const json& p) { send("ui:event", p); }

void Wire::sendCommand(const std::string& cmd, json extra) {
  json p = extra.is_object() ? std::move(extra) : json::object();
  p["command"] = cmd;
  send("ui:command", p);
}

void Wire::sendTerm(const json& p) { send("term:event", p); }

void Wire::sendGeometry() {
  Window& w = Window::instance();
  RECT rc{};
  GetClientRect(w.hwnd(), &rc);
  // The cell of the model's window.fontPx (13 before the first ui:model),
  // measured at device pixels and sent in DIPs like the font size itself.
  const WindowModel& wm = App::instance().model().window;
  float scale = w.dpi().scale();
  float fontPx = wm.fontPx > 0 ? (float)wm.fontPx : 13.f;
  FontMetrics m = Fonts::metrics(fontPx * scale);
  json p = { { "clientW", rc.right - rc.left }, { "clientH", rc.bottom - rc.top }, { "dpi", w.dpi().dpi },
             { "cellW", m.cellW / scale }, { "cellH", m.cellH / scale }, { "uiScale", wm.uiScale > 0 ? wm.uiScale : 1.0 } };
  send("shell:geometry", p);
  App::log("geometry sent %ldx%ld dpi %.0f cell %.3fx%.3f at %.1f px", rc.right - rc.left, rc.bottom - rc.top, w.dpi().dpi,
           m.cellW / scale, m.cellH / scale, fontPx);
}

void Wire::ptyWrite(const std::string& paneId, const std::string& utf8) {
  send("pty:write", { { "paneId", paneId }, { "data", utf8 } });
}

void Wire::ptyResize(const std::string& paneId, int cols, int rows) {
  send("pty:resize", { { "paneId", paneId }, { "cols", cols }, { "rows", rows } });
}

void Wire::reply(int id, const std::string& ch, const json& p) {
  writeEnvelope({ { "k", "reply" }, { "ch", ch }, { "id", id }, { "p", p } });
}

void Wire::invoke(const std::string& ch, const json& p, std::function<void(const json&)> cb) {
  int id = nextId_++;
  if (cb) pending_[id] = std::move(cb);
  writeEnvelope({ { "k", "invoke" }, { "ch", ch }, { "id", id }, { "p", p } });
}

void Wire::reset() {
  for (auto& [id, cb] : pending_) cb(json{ { "ok", false }, { "code", "ECOREEXIT" } });
  pending_.clear();
}

// A model without rows (its rowsSeq unchanged, SidebarModel.rowsSeq) takes
// the last model's, so the driver's model still lists them. A move, not a copy.
void Wire::keepRows(nlohmann::json& prev) {
  auto sidebar = [](json& m) -> json* {
    if (!m.is_object()) return nullptr;
    auto it = m.find("sidebar");
    return it != m.end() && it->is_object() ? &*it : nullptr;
  };
  json* now = sidebar(lastModel_);
  json* was = sidebar(prev);
  if (!now || !was || now->contains("rows") || !was->contains("rows")) return;
  if (now->value("rowsSeq", -1.0) != was->value("rowsSeq", -2.0)) return;
  (*now)["rows"] = std::move((*was)["rows"]);
}

void Wire::onCoreLine(std::string line) {
  LARGE_INTEGER t0, t1, t2;
  QueryPerformanceCounter(&t0);
  json e = json::parse(line, nullptr, false);
  QueryPerformanceCounter(&t1);
  if (e.is_discarded() || !e.is_object() || !e.contains("k") || !e["k"].is_string() || !e.contains("ch") || !e["ch"].is_string()) {
    App::log("error: malformed core line (%zu bytes): %.200s", line.size(), line.c_str());
    return;
  }
  const std::string k = e["k"].get<std::string>();
  const std::string ch = e["ch"].get<std::string>();
  static const json kNull;
  const json& p = e.contains("p") ? e["p"] : kNull;
  try {
    if (k == "on") {
      if (ch == "ui:model") {
        UiModel m = UiModel::parse(p);
        QueryPerformanceCounter(&t2);
        parseTicks = t1.QuadPart - t0.QuadPart;
        buildTicks = t2.QuadPart - t1.QuadPart;
        // Kept for the driver's model reply. Moved, not copied: p is not read
        // again. App's apply clock (the driver's modelMs) counts this and the
        // log line from where build ends.
        json prev = std::move(lastModel_);
        lastModel_ = e.contains("p") ? std::move(e["p"]) : json();
        keepRows(prev);
        logModel(m);
        if (onModel) onModel(std::move(m));
      } else if (ch == "pty:data") {
        const json* batches = p.is_object() && p.contains("batches") ? &p["batches"] : nullptr;
        if (!batches || !batches->is_array()) { App::log("error: pty:data without batches"); return; }
        for (const json& b : *batches) {
          if (!b.is_object() || !b.contains("paneId") || !b["paneId"].is_string() || !b.contains("data") || !b["data"].is_string()) continue;
          std::string bytes = base64Decode(b["data"].get_ref<const std::string&>());
          if (onPtyData) onPtyData(b["paneId"].get<std::string>(), bytes);
        }
      } else if (ch == "grid:cmd") {
        if (onGridCmd) onGridCmd(p);
      } else if (ch == "shell:cmd") {
        if (onShellCmd) onShellCmd(p);
      } else {
        App::log("on %s ignored: not a core push the shell takes", ch.c_str());
      }
    } else if (k == "invoke") {
      int id = e.contains("id") && e["id"].is_number_integer() ? e["id"].get<int>() : 0;
      if (SHELL_CHANNELS.count(ch)) {
        App::log("invoke %s id %d", ch.c_str(), id);
        reply(id, ch, HostApi::handle(ch, p));
      } else {
        App::log("error: invoke %s id %d is not a shell channel", ch.c_str(), id);
        reply(id, ch, { { "ok", false }, { "code", "ENOTSHELL" } });
      }
    } else if (k == "reply") {
      int id = e.contains("id") && e["id"].is_number_integer() ? e["id"].get<int>() : 0;
      auto it = pending_.find(id);
      if (it == pending_.end()) { App::log("reply %s id %d has no pending invoke", ch.c_str(), id); return; }
      auto cb = std::move(it->second);
      pending_.erase(it);
      cb(p);
    } else {
      App::log("error: core sent k=%s ch=%s; ignored", k.c_str(), ch.c_str());
    }
  } catch (const std::exception& ex) {
    App::log("error: core line %s %s failed: %s", k.c_str(), ch.c_str(), ex.what());
  }
}
