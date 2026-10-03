// The application menu (Phase 2 Task 16): the core's src/main/menu.ts template,
// sent once at boot as shell:cmd { op: 'menu', items }, built into a real
// HMENU tree and popped with TrackPopupMenuEx(TPM_RETURNCMD) under the `≡`
// button (a click on the `menu` target, or an Alt tap). A pick sends
// menu:click { path } to the core, which runs the item's click; `about` and
// `togglefullscreen` are the shell's own, and toggleDevTools and the Mac roles
// are left out.
//
// Test mode (SEASHELL_TEST_PORT) never shows the menu: a modal menu loop would
// capture the mouse and keyboard and want the foreground. A pop there builds
// the same HMENU tree, logs it, destroys it and counts as open (stats'
// menuOpen) until Escape, an Alt tap or the next press; while open it takes
// the keyboard, as the real menu loop would. UI thread only.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include "model.h"

class AppMenu {
public:
  static AppMenu& instance();
  void set(const nlohmann::json& items);           // shell:cmd { op: 'menu' }: the items, replacing any before
  // The items as the HMENU holds them (the driver's `menu`): the shell's
  // roles kept, the omitted ones gone, each with its command id.
  nlohmann::json built() const;
  // Pops the menu with its top-left at `at` (screen pixels), keeping clear of
  // `avoid` (the `≡` button, screen pixels) when given. Returns once the menu
  // closed and its pick ran (test mode: at once, see above).
  void pop(HWND owner, POINT at, const RECT* avoid);
  bool pick(const std::vector<int>& path);         // a pick of that item; false for no such item, a separator, a submenu or a greyed one
  bool open() const { return testOpen_ || tracking_; }
  // Test mode's open menu: a press anywhere closes it.
  void noteDown();
  // The keyboard while the test-mode menu is open: Escape closes it, every
  // key message is taken. True when the message was the menu's.
  bool key(UINT msg, WPARAM w);
  void dismiss(const char* why);                   // test mode: closes the menu that is not shown

private:
  // A new HMENU tree from items_; ids_[id - 1] is the path of command id.
  // *count is every entry appended, separators and submenus included.
  HMENU build(std::vector<std::vector<int>>* ids, nlohmann::json* shape, int* count) const;
  const MenuItemModel* find(const std::vector<int>& path) const;

  std::vector<MenuItemModel> items_;
  bool testOpen_ = false;    // test mode: popped, not shown
  bool tracking_ = false;    // TrackPopupMenuEx is running
  bool swallowUp_ = false;   // the Escape that closed it: its WM_CHAR and key-up stay out of the pane
};
