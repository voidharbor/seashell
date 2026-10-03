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

// The file explorer (Phase 2 Task 4). Paths are the core's (Linux) paths.
struct SidebarRow {
  std::string id;                   // 'row:' + path; the target is 'sidebar:' + id
  std::string path, name;
  int depth = 0;
  bool isDir = false, expanded = false, selected = false, ignored = false, flashing = false;
  std::optional<std::string> chip;  // '#rrggbb' for a file's extension chip
  std::optional<std::string> error; // '(ENOENT)' for an open directory that failed to list
  bool truncatedAfter = false;      // the '… too many entries to list' line follows this row
  static SidebarRow parse(const nlohmann::json& j) {
    using namespace model_detail;
    SidebarRow r;
    r.id = str(j, "id"); r.path = str(j, "path"); r.name = str(j, "name");
    r.depth = integer(j, "depth");
    r.isDir = flag(j, "isDir"); r.expanded = flag(j, "expanded"); r.selected = flag(j, "selected");
    r.ignored = flag(j, "ignored"); r.flashing = flag(j, "flashing");
    r.chip = optStr(j, "chip"); r.error = optStr(j, "error");
    r.truncatedAfter = flag(j, "truncatedAfter");
    return r;
  }
};

struct SidebarMenuItem {
  std::string id, label;
  bool enabled = true;
  static SidebarMenuItem parse(const nlohmann::json& j) {
    using namespace model_detail;
    return SidebarMenuItem{ str(j, "id"), str(j, "label"), flag(j, "enabled", true) };
  }
};

struct SidebarMenu {
  std::string rowId;
  double x = 0, y = 0;              // the right click's point, window client DIP
  std::vector<SidebarMenuItem> items;
};

struct SidebarModel {
  bool visible = false;
  Rect rect, gripRect;              // DIP; all zero while hidden
  double width = 260;               // the stored base width (uiScale 1)
  std::vector<SidebarRow> rows;
  double rowsSeq = 0;               // bumps when the rows change; a model whose rowsSeq the core already sent leaves rows out
  bool hasRows = false;             // this model carried rows (Ui::setModel keeps the last ones when it did not)
  double revealSeq = 0;
  std::optional<std::string> revealRowId;
  std::string strip;                // the selected path or the root
  std::optional<SidebarMenu> menu;
  static SidebarModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    SidebarModel s;
    s.visible = flag(j, "visible");
    if (const json* r = field(j, "rect")) s.rect = Rect::parse(*r);
    if (const json* r = field(j, "gripRect")) s.gripRect = Rect::parse(*r);
    s.width = num(j, "width", 260);
    if (const json* r = field(j, "rows"); r && r->is_array()) {
      s.hasRows = true;
      s.rows = list<SidebarRow>(j, "rows");
    }
    s.rowsSeq = num(j, "rowsSeq");
    s.revealSeq = num(j, "revealSeq");
    s.revealRowId = optStr(j, "revealRowId");
    s.strip = str(j, "strip");
    if (const json* m = field(j, "menu"); m && m->is_object()) {
      SidebarMenu menu;
      menu.rowId = str(*m, "rowId");
      menu.x = num(*m, "x"); menu.y = num(*m, "y");
      menu.items = list<SidebarMenuItem>(*m, "items");
      s.menu = std::move(menu);
    }
    return s;
  }
};

// The shell drawer (Phase 2 Task 6): one shell per pane over the bottom of the
// grid area. Its grid is an ordinary grid under ptyId ('drawer:<paneId>').
struct DrawerHeader {
  std::string label;                // 'Shell · <pane label>'
  std::string title;                // the shell's OSC title, else its cwd
  bool showCd = false;              // the drawer:cd button shows
};

struct DrawerModel {
  bool open = false;
  Rect rect, gripRect, gridRect;    // DIP; all zero while closed
  double height = 300;              // the stored base height (uiScale 1)
  std::optional<std::string> paneId, ptyId;
  int cols = 0, rows = 0;
  double fontPx = 0;
  DrawerHeader header;
  std::string status = "starting";  // 'starting' | 'live' | 'exited'
  bool focused = false;             // keys go to the drawer's grid
  static DrawerModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    DrawerModel d;
    d.open = flag(j, "open");
    if (const json* r = field(j, "rect")) d.rect = Rect::parse(*r);
    if (const json* r = field(j, "gripRect")) d.gripRect = Rect::parse(*r);
    if (const json* r = field(j, "gridRect")) d.gridRect = Rect::parse(*r);
    d.height = num(j, "height", 300);
    d.paneId = optStr(j, "paneId"); d.ptyId = optStr(j, "ptyId");
    d.cols = integer(j, "cols"); d.rows = integer(j, "rows"); d.fontPx = num(j, "fontPx");
    if (const json* h = field(j, "header"); h && h->is_object())
      d.header = DrawerHeader{ str(*h, "label"), str(*h, "title"), flag(*h, "showCd") };
    d.status = str(j, "status", "starting");
    d.focused = flag(j, "focused");
    return d;
  }
};

// Sheets (Phase 2 Task 12): one at a time, drawn over a dimmed window.
// Targets: sheet:<kind>:<fieldId>, sheet:<kind>:<fieldId>:<optionId>,
// sheet:<kind>:btn:<id>, sheet:close; key Escape goes to sheet:<kind>.
// A rows field (the Projects sheet, Task 13): sheet:<kind>:row:<id>:<button>.
struct SheetOption {
  std::string id, label;
  bool selected = false, disabled = false;
  std::optional<std::string> tooltip, swatch;   // swatch: '#rrggbb'
  static SheetOption parse(const nlohmann::json& j) {
    using namespace model_detail;
    SheetOption o;
    o.id = str(j, "id"); o.label = str(j, "label");
    o.selected = flag(j, "selected"); o.disabled = flag(j, "disabled");
    o.tooltip = optStr(j, "tooltip"); o.swatch = optStr(j, "swatch");
    return o;
  }
};

struct SheetRow {                   // one saved project: name, 'N tabs · M panes · saved <ago>'
  std::string id, name, meta;
  bool confirming = false;          // Delete was pressed: the row shows Delete (danger) and Cancel
  static SheetRow parse(const nlohmann::json& j) {
    using namespace model_detail;
    return SheetRow{ str(j, "id"), str(j, "name"), str(j, "meta"), flag(j, "confirming") };
  }
};

struct SheetField {
  std::string id;
  std::string kind = "note";        // 'buttons' | 'check' | 'text' | 'button' | 'note' | 'rows'
  std::string label;
  bool check = false;               // value, for a check
  std::string text;                 // value, for a text field or a button's caption (none: the label is the caption)
  std::vector<SheetOption> options;
  std::string placeholder;
  int maxLen = 0;
  std::string note;
  bool disabled = false;            // a button that does nothing yet
  int rev = 0;                      // a text field's value revision: a change reloads the widget from text
  std::vector<SheetRow> rows;
  static SheetField parse(const nlohmann::json& j) {
    using namespace model_detail;
    SheetField f;
    f.id = str(j, "id"); f.kind = str(j, "kind", "note"); f.label = str(j, "label");
    f.check = flag(j, "value"); f.text = str(j, "value");
    f.options = list<SheetOption>(j, "options");
    f.placeholder = str(j, "placeholder"); f.maxLen = integer(j, "maxLen"); f.note = str(j, "note");
    f.disabled = flag(j, "disabled"); f.rev = integer(j, "rev");
    f.rows = list<SheetRow>(j, "rows");
    return f;
  }
};

struct SheetSection {
  std::string title;
  std::vector<SheetField> fields;
  static SheetSection parse(const nlohmann::json& j) {
    using namespace model_detail;
    return SheetSection{ str(j, "title"), list<SheetField>(j, "fields") };
  }
};

struct SheetButton {
  std::string id, label;
  bool isDefault = false, disabled = false;
  static SheetButton parse(const nlohmann::json& j) {
    using namespace model_detail;
    return SheetButton{ str(j, "id"), str(j, "label"), flag(j, "isDefault"), flag(j, "disabled") };
  }
};

struct SheetModel {
  std::string kind, title;
  double width = 620;               // DIP, uiScale in; the shell caps it at 88 percent of the body
  std::vector<SheetSection> sections;
  std::vector<SheetButton> buttons;
  std::optional<std::string> focusField;
  static SheetModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    SheetModel m;
    m.kind = str(j, "kind"); m.title = str(j, "title"); m.width = num(j, "width", 620);
    m.sections = list<SheetSection>(j, "sections");
    m.buttons = list<SheetButton>(j, "buttons");
    m.focusField = optStr(j, "focusField");
    return m;
  }
};

// The update banner (Phase 2 Task 14): a strip above the status bar in the
// band rect the core's layout leaves for it. Targets: update:<button id>.
struct UpdateButton {
  std::string id, label;          // 'download' | 'page' | 'later' | 'install' | 'retry' | 'dismiss'
  static UpdateButton parse(const nlohmann::json& j) {
    using namespace model_detail;
    return UpdateButton{ str(j, "id"), str(j, "label") };
  }
};

struct UpdateBannerModel {
  std::string phase;              // 'available' | 'downloading' | 'ready' | 'error'
  std::string text;
  std::vector<UpdateButton> buttons;
  std::optional<double> progress; // 0..1 while a download of known size runs
  Rect rect;                      // DIP, client coordinates
  static UpdateBannerModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    UpdateBannerModel u;
    u.phase = str(j, "phase"); u.text = str(j, "text");
    u.buttons = list<UpdateButton>(j, "buttons");
    u.progress = optNum(j, "progress");
    if (const json* r = field(j, "rect")) u.rect = Rect::parse(*r);
    return u;
  }
};

// A pane's colour or link popover (Phase 2 Task 15), drawn through Popup with
// its top-left at the anchor's bottom-left. Targets: popover:<item id>, and
// popover itself for key Escape.
struct PopoverItem {
  std::string id, label;
  std::optional<std::string> swatch;   // '#rrggbb'
  bool selected = false, disabled = false;
  std::optional<std::string> note;     // 'no agent' | 'linked'
  static PopoverItem parse(const nlohmann::json& j) {
    using namespace model_detail;
    PopoverItem i;
    i.id = str(j, "id"); i.label = str(j, "label");
    i.swatch = optStr(j, "swatch");
    i.selected = flag(j, "selected"); i.disabled = flag(j, "disabled");
    i.note = optStr(j, "note");
    return i;
  }
};

struct PopoverModel {
  std::string kind;                    // 'color' | 'link'
  std::string paneId;
  Rect anchor;                         // DIP, client coordinates
  std::optional<std::string> title;    // 'Share notes with'
  std::vector<PopoverItem> items;
  static PopoverModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    PopoverModel m;
    m.kind = str(j, "kind"); m.paneId = str(j, "paneId");
    if (const json* a = field(j, "anchor")) m.anchor = Rect::parse(*a);
    m.title = optStr(j, "title");
    m.items = list<PopoverItem>(j, "items");
    return m;
  }
};

// One application menu item (MenuItemModel in model.ts), from shell:cmd
// { op: 'menu', items }, outside the ui:model. `path` is what menu:click sends back.
struct MenuItemModel {
  std::string label;
  std::optional<std::string> accelerator;   // the item's right text ('Ctrl+Shift+T')
  std::optional<std::string> role;          // 'about' | 'togglefullscreen' | 'quit' | 'help' | ...
  std::string type = "normal";              // 'normal' | 'separator' | 'submenu'
  bool enabled = true;
  std::vector<int> path;
  std::vector<MenuItemModel> submenu;
  static MenuItemModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    MenuItemModel m;
    m.label = str(j, "label");
    m.accelerator = optStr(j, "accelerator");
    m.role = optStr(j, "role");
    m.type = str(j, "type", "normal");
    m.enabled = flag(j, "enabled", true);
    if (const json* p = field(j, "path"); p && p->is_array())
      for (const json& i : *p)
        if (i.is_number_integer()) m.path.push_back(i.get<int>());
    m.submenu = list<MenuItemModel>(j, "submenu");
    return m;
  }
};

struct WindowModel {
  std::string title;
  double uiScale = 1, fontPx = 0, tabStripH = 0, statusH = 0;
  // The terminal palette override as xterm ITheme keys ('background',
  // 'green', 'brightBlack', ...); absent for 'native' (the shell's own table).
  std::optional<std::map<std::string, std::string>> palette;
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
  SidebarModel sidebar;
  DrawerModel drawer;
  std::optional<SheetModel> sheet;
  std::optional<UpdateBannerModel> update;
  std::optional<PopoverModel> popover;

  static UiModel parse(const nlohmann::json& j) {
    using namespace model_detail;
    UiModel m;
    if (!j.is_object()) return m;
    m.seq = num(j, "seq");
    if (const json* w = field(j, "window")) {
      m.window.title = str(*w, "title"); m.window.uiScale = num(*w, "uiScale", 1);
      m.window.fontPx = num(*w, "fontPx"); m.window.tabStripH = num(*w, "tabStripH"); m.window.statusH = num(*w, "statusH");
      if (const json* pal = field(*w, "palette"); pal && pal->is_object()) {
        std::map<std::string, std::string> keys;
        for (auto it = pal->begin(); it != pal->end(); ++it)
          if (it.value().is_string()) keys[it.key()] = it.value().get<std::string>();
        m.window.palette = std::move(keys);
      }
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
    if (const json* s = field(j, "sidebar")) m.sidebar = SidebarModel::parse(*s);
    if (const json* d = field(j, "drawer")) m.drawer = DrawerModel::parse(*d);
    if (const json* sh = field(j, "sheet"); sh && sh->is_object()) m.sheet = SheetModel::parse(*sh);
    if (const json* u = field(j, "update"); u && u->is_object()) m.update = UpdateBannerModel::parse(*u);
    if (const json* po = field(j, "popover"); po && po->is_object()) m.popover = PopoverModel::parse(*po);
    return m;
  }
};
