// The C++ mirror of src/core/controller/model.ts: the ui:model snapshot the
// core sends after every change. Field names match the TypeScript exactly.
// parse() tolerates missing or mistyped fields (defaults) and ignores unknown
// ones; it never throws.
#pragma once
#include <nlohmann/json.hpp>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace model_detail {
using nlohmann::json;
inline const json* field(const json& j, const char* k) {
  if (!j.is_object()) return nullptr;
  auto it = j.find(k);
  return it == j.end() ? nullptr : &*it;
}
inline std::string str(const json& j, const char* k, const std::string& d = {}) {
  const json* v = field(j, k);
  return v && v->is_string() ? v->get<std::string>() : d;
}
inline std::optional<std::string> optStr(const json& j, const char* k) {
  const json* v = field(j, k);
  if (v && v->is_string()) return v->get<std::string>();
  return std::nullopt;
}
inline double num(const json& j, const char* k, double d = 0) {
  const json* v = field(j, k);
  return v && v->is_number() ? v->get<double>() : d;
}
inline std::optional<double> optNum(const json& j, const char* k) {
  const json* v = field(j, k);
  if (v && v->is_number()) return v->get<double>();
  return std::nullopt;
}
inline int integer(const json& j, const char* k, int d = 0) { return (int)num(j, k, d); }
inline bool flag(const json& j, const char* k, bool d = false) {
  const json* v = field(j, k);
  return v && v->is_boolean() ? v->get<bool>() : d;
}
template <class T>
std::vector<T> list(const json& j, const char* k) {
  std::vector<T> out;
  const json* v = field(j, k);
  if (v && v->is_array())
    for (const json& e : *v) out.push_back(T::parse(e));
  return out;
}
}  // namespace model_detail

struct Rect {
  double x = 0, y = 0, w = 0, h = 0;
  static Rect parse(const nlohmann::json& j) {
    using namespace model_detail;
    return Rect{ num(j, "x"), num(j, "y"), num(j, "w"), num(j, "h") };
  }
};

struct TabModel {
  std::string id, name;
  bool active = false, renaming = false;
  static TabModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    TabModel t;
    t.id = str(j, "id"); t.name = str(j, "name");
    t.active = flag(j, "active"); t.renaming = flag(j, "renaming");
    return t;
  }
};

struct PaneExit {
  std::string text;
  bool failed = false;
};

struct PaneModel {
  std::string id;
  std::string kind = "term";        // 'term' | 'file' | 'web'
  Rect rect, gridRect;
  int cols = 0, rows = 0, index = 0;
  std::string label, tooltip, badge;
  std::optional<std::string> memBadge;
  bool memHigh = false;
  std::optional<double> zoomPercent;
  double fontPx = 0;
  std::optional<std::string> color;
  bool focused = false;
  std::string attention = "none";   // 'none' | 'waiting' | 'done'
  std::string status = "starting";  // 'starting' | 'live' | 'exited'
  std::optional<PaneExit> exit;
  bool linked = false, linkEnabled = false;
  static PaneModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    PaneModel p;
    p.id = str(j, "id"); p.kind = str(j, "kind", "term");
    if (const json* r = field(j, "rect")) p.rect = Rect::parse(*r);
    if (const json* r = field(j, "gridRect")) p.gridRect = Rect::parse(*r);
    p.cols = integer(j, "cols"); p.rows = integer(j, "rows"); p.index = integer(j, "index");
    p.label = str(j, "label"); p.tooltip = str(j, "tooltip"); p.badge = str(j, "badge");
    p.memBadge = optStr(j, "memBadge"); p.memHigh = flag(j, "memHigh");
    p.zoomPercent = optNum(j, "zoomPercent"); p.fontPx = num(j, "fontPx");
    p.color = optStr(j, "color"); p.focused = flag(j, "focused");
    p.attention = str(j, "attention", "none"); p.status = str(j, "status", "starting");
    if (const json* e = field(j, "exit"); e && e->is_object()) p.exit = PaneExit{ str(*e, "text"), flag(*e, "failed") };
    p.linked = flag(j, "linked"); p.linkEnabled = flag(j, "linkEnabled");
    return p;
  }
};

struct DividerModel {
  std::string id;
  Rect rect;
  std::string orientation = "vertical";   // 'vertical' | 'horizontal'
  static DividerModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    DividerModel d;
    d.id = str(j, "id");
    if (const json* r = field(j, "rect")) d.rect = Rect::parse(*r);
    d.orientation = str(j, "orientation", "vertical");
    return d;
  }
};

struct FindCount {
  int index = 0, total = 0;
  bool capped = false;
};

struct FindModel {
  bool open = false;
  std::optional<std::string> paneId;
  std::string query;
  bool caseSensitive = false, regex = false;
  std::optional<FindCount> count;
  bool miss = false;
  static FindModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    FindModel f;
    f.open = flag(j, "open"); f.paneId = optStr(j, "paneId"); f.query = str(j, "query");
    f.caseSensitive = flag(j, "caseSensitive"); f.regex = flag(j, "regex");
    if (const json* c = field(j, "count"); c && c->is_object())
      f.count = FindCount{ integer(*c, "index"), integer(*c, "total"), flag(*c, "capped") };
    f.miss = flag(j, "miss");
    return f;
  }
};

struct RestoreCardModel {
  int tabs = 0, panes = 0;
  std::string savedAt;
  static RestoreCardModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    return RestoreCardModel{ integer(j, "tabs"), integer(j, "panes"), str(j, "savedAt") };
  }
};

struct ChordModel {
  std::string chord, command;
  static ChordModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    return ChordModel{ str(j, "chord"), str(j, "command") };
  }
};

struct WindowModel {
  std::string title;
  double uiScale = 1, fontPx = 0, tabStripH = 0, statusH = 0;
};

struct StatusModel {
  std::string panes, inPanes, used;
  std::string usedLevel = "ok";   // 'ok' | 'warn' | 'crit'
  std::optional<std::string> compressed, swap;
  bool swapWarn = false;
  std::string hint;
};

struct UiModel {
  double seq = 0;
  WindowModel window;
  std::vector<TabModel> tabs;
  bool tabFull = false, sleep = false;
  std::optional<std::string> zoomBadge;
  std::vector<PaneModel> panes;
  std::vector<DividerModel> dividers;
  std::optional<std::string> zoomedPaneId;
  bool emptyState = false, starting = false;
  FindModel find;
  std::optional<RestoreCardModel> restore;
  std::optional<std::string> toast;
  StatusModel status;
  std::vector<ChordModel> chords;
  std::map<std::string, std::string> tokens;   // the Aero token table (Task 16)

  static UiModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    UiModel m;
    if (!j.is_object()) return m;
    m.seq = num(j, "seq");
    if (const json* w = field(j, "window")) {
      m.window.title = str(*w, "title"); m.window.uiScale = num(*w, "uiScale", 1);
      m.window.fontPx = num(*w, "fontPx"); m.window.tabStripH = num(*w, "tabStripH"); m.window.statusH = num(*w, "statusH");
    }
    m.tabs = list<TabModel>(j, "tabs");
    m.tabFull = flag(j, "tabFull"); m.sleep = flag(j, "sleep");
    m.zoomBadge = optStr(j, "zoomBadge");
    m.panes = list<PaneModel>(j, "panes");
    m.dividers = list<DividerModel>(j, "dividers");
    m.zoomedPaneId = optStr(j, "zoomedPaneId");
    m.emptyState = flag(j, "emptyState"); m.starting = flag(j, "starting");
    if (const json* f = field(j, "find")) m.find = FindModel::parse(*f);
    if (const json* r = field(j, "restore"); r && r->is_object()) m.restore = RestoreCardModel::parse(*r);
    m.toast = optStr(j, "toast");
    if (const json* s = field(j, "status")) {
      m.status.panes = str(*s, "panes"); m.status.inPanes = str(*s, "inPanes"); m.status.used = str(*s, "used");
      m.status.usedLevel = str(*s, "usedLevel", "ok");
      m.status.compressed = optStr(*s, "compressed"); m.status.swap = optStr(*s, "swap");
      m.status.swapWarn = flag(*s, "swapWarn"); m.status.hint = str(*s, "hint");
    }
    m.chords = list<ChordModel>(j, "chords");
    if (const json* t = field(j, "tokens"); t && t->is_object())
      for (auto it = t->begin(); it != t->end(); ++it)
        if (it.value().is_string()) m.tokens[it.key()] = it.value().get<std::string>();
    return m;
  }
};
