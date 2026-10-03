#include "ui/menu.h"
#include "app.h"
#include "paths.h"
#include "version.h"
#include "window.h"
#include <cstring>

using nlohmann::json;

namespace {
// toggleDevTools and the Mac-only roles have nothing to do on this window.
bool omitted(const MenuItemModel& it) {
  static const char* const kOmit[] = {
    "toggleDevTools", "appMenu", "hide", "hideOthers", "unhide", "services", "front", "zoom", "window",
    "recentDocuments", "clearRecentDocuments", "toggleTabBar", "selectNextTab", "selectPreviousTab",
    "showAllTabs", "mergeAllWindows", "moveTabToNewWindow", "shareMenu", "startSpeaking", "stopSpeaking",
  };
  if (!it.role) return false;
  for (const char* r : kOmit)
    if (*it.role == r) return true;
  return false;
}

bool isSubmenu(const MenuItemModel& it) { return it.type == "submenu" || !it.submenu.empty(); }

// The HMENU text: '&' doubled (a single one marks a mnemonic), the
// accelerator as the right-aligned text after a tab.
std::wstring menuText(const MenuItemModel& it) {
  std::wstring s;
  for (wchar_t c : fromUtf8(it.label)) {
    if (c == L'&') s += L"&&";
    else s += c;
  }
  if (it.accelerator && !it.accelerator->empty()) s += L"\t" + fromUtf8(*it.accelerator);
  return s;
}

std::string pathText(const std::vector<int>& path) {
  std::string s = "[";
  for (size_t i = 0; i < path.size(); i++) s += (i ? "," : "") + std::to_string(path[i]);
  return s + "]";
}

json shapeOf(const MenuItemModel& it, UINT id) {
  return { { "label", it.label }, { "accelerator", it.accelerator ? json(*it.accelerator) : json(nullptr) },
           { "role", it.role ? json(*it.role) : json(nullptr) }, { "type", it.type }, { "enabled", it.enabled },
           { "path", it.path }, { "id", id ? json(id) : json(nullptr) }, { "submenu", nullptr } };
}

// Appends `items` to m: no separator first, none twice, none last. Returns
// the entries appended, at every level.
int fill(HMENU m, const std::vector<MenuItemModel>& items, std::vector<std::vector<int>>* ids, json* shape) {
  *shape = json::array();
  int count = 0;
  bool lastSep = true;
  for (const MenuItemModel& it : items) {
    if (omitted(it)) continue;
    if (it.type == "separator") {
      if (lastSep) continue;
      AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
      shape->push_back(shapeOf(it, 0));
      lastSep = true;
      count++;
      continue;
    }
    UINT grey = it.enabled ? 0 : MF_GRAYED;
    if (isSubmenu(it)) {
      HMENU sub = CreatePopupMenu();
      if (!sub) continue;
      json subShape;
      count += fill(sub, it.submenu, ids, &subShape);
      AppendMenuW(m, MF_POPUP | MF_STRING | grey, (UINT_PTR)sub, menuText(it).c_str());
      json e = shapeOf(it, 0);
      e["submenu"] = std::move(subShape);
      shape->push_back(std::move(e));
    } else {
      ids->push_back(it.path);
      UINT id = (UINT)ids->size();   // 0 is TrackPopupMenuEx's "no pick"
      AppendMenuW(m, MF_STRING | grey, id, menuText(it).c_str());
      shape->push_back(shapeOf(it, id));
    }
    lastSep = false;
    count++;
  }
  if (lastSep && !shape->empty()) {
    DeleteMenu(m, (UINT)GetMenuItemCount(m) - 1, MF_BYPOSITION);
    shape->erase(shape->end() - 1);
    count--;
  }
  return count;
}
}  // namespace

AppMenu& AppMenu::instance() { static AppMenu m; return m; }

void AppMenu::set(const json& items) {
  items_.clear();
  if (items.is_array())
    for (const json& j : items) items_.push_back(MenuItemModel::parse(j));
  App::log("menu: %zu top-level items from the core", items_.size());
}

HMENU AppMenu::build(std::vector<std::vector<int>>* ids, json* shape, int* count) const {
  HMENU root = CreatePopupMenu();
  if (!root) return nullptr;
  *count = fill(root, items_, ids, shape);
  return root;
}

json AppMenu::built() const {
  std::vector<std::vector<int>> ids;
  json shape = json::array();
  int n = 0;
  HMENU h = build(&ids, &shape, &n);
  if (h) DestroyMenu(h);
  return { { "items", shape }, { "count", n }, { "commands", ids.size() } };
}

const MenuItemModel* AppMenu::find(const std::vector<int>& path) const {
  const std::vector<MenuItemModel>* level = &items_;
  const MenuItemModel* it = nullptr;
  for (int i : path) {
    if (!level || i < 0 || (size_t)i >= level->size()) return nullptr;
    it = &(*level)[(size_t)i];
    level = &it->submenu;
  }
  return it;
}

void AppMenu::pop(HWND owner, POINT at, const RECT* avoid) {
  if (tracking_) return;
  if (items_.empty()) { App::log("menu: the core has sent no menu yet"); return; }
  std::vector<std::vector<int>> ids;
  json shape;
  int n = 0;
  HMENU h = build(&ids, &shape, &n);
  if (!h) { App::log("error: CreatePopupMenu %lu", GetLastError()); return; }
  App::log("menu: built %d items", n);
  if (App::instance().testMode()) {
    // Built exactly as for a real pop, never shown: a menu loop would take
    // the mouse and the keyboard from whoever is at the machine.
    DestroyMenu(h);
    testOpen_ = true;
    swallowUp_ = false;
    App::log("menu: popped (test mode, not shown)");
    return;
  }
  // KB135788: a popup menu closes on a click elsewhere only while its owner
  // is the foreground window (it is, after a click or a key on it).
  if (GetForegroundWindow() != owner) SetForegroundWindow(owner);
  TPMPARAMS tp{ sizeof tp };
  if (avoid) tp.rcExclude = *avoid;
  App::log("menu: popped");
  tracking_ = true;
  UINT cmd = (UINT)TrackPopupMenuEx(h, TPM_RETURNCMD | TPM_NONOTIFY | TPM_LEFTALIGN | TPM_TOPALIGN | TPM_LEFTBUTTON | TPM_VERTICAL,
                                    at.x, at.y, owner, avoid ? &tp : nullptr);
  tracking_ = false;
  PostMessageW(owner, WM_NULL, 0, 0);
  DestroyMenu(h);
  if (cmd == 0 || cmd > ids.size()) { App::log("menu: closed"); return; }
  pick(ids[cmd - 1]);
}

bool AppMenu::pick(const std::vector<int>& path) {
  const MenuItemModel* it = find(path);
  if (!it || omitted(*it) || isSubmenu(*it) || it->type == "separator" || !it->enabled) {
    App::log("menu: pick %s refused", pathText(path).c_str());
    return false;
  }
  testOpen_ = false;
  App& app = App::instance();
  std::string role = it->role.value_or("");
  App::log("menu: pick %s %s", pathText(path).c_str(), it->label.c_str());
  if (role == "about") {
    std::wstring text = L"SeaShell " + fromUtf8(SEASHELL_VERSION_STR);
    if (app.testMode()) App::log("menu: about: %s (test mode, no MessageBox)", toUtf8(text).c_str());
    else MessageBoxW(Window::instance().hwnd(), text.c_str(), L"About SeaShell", MB_OK | MB_ICONINFORMATION);
    return true;
  }
  if (role == "togglefullscreen") {
    // Every maximizing show command activates the window, so a test run leaves it be.
    HWND h = Window::instance().hwnd();
    if (app.testMode()) App::log("menu: togglefullscreen not run (test mode never activates the window)");
    else if (h) ShowWindow(h, IsZoomed(h) ? SW_RESTORE : SW_MAXIMIZE);
    return true;
  }
  app.wire().send("menu:click", { { "path", path } });
  return true;
}

void AppMenu::dismiss(const char* why) {
  if (!testOpen_) return;
  testOpen_ = false;
  App::log("menu: closed (%s)", why);
}

void AppMenu::noteDown() { dismiss("press"); }

bool AppMenu::key(UINT msg, WPARAM w) {
  if (swallowUp_) {
    // The closing Escape's WM_CHAR and key-up.
    if (msg == WM_CHAR || msg == WM_SYSCHAR) return true;
    if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && w == VK_ESCAPE) { swallowUp_ = false; return true; }
  }
  if (!testOpen_) return false;
  if (msg == WM_KEYDOWN && w == VK_ESCAPE) {
    dismiss("Escape");
    swallowUp_ = true;
  }
  return true;
}
