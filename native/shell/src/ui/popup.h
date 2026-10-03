// A popup menu drawn by the Painter with redesign spec 6.3's menu values:
// #f0f0f0 face, 1 px #979797 border, highlight #dcebfc with a 1 px #7da2ce
// border and 3 px radius, separators #e0e0e0 over #ffffff, a 2 px drop shadow.
// The menu's contents come from the model; the popup keeps only the keyboard
// highlight. It registers `base` (the whole menu, base = prefix without its
// trailing ':') and `prefix + id` for each item, and takes Up, Down, Enter and
// Escape while open (Escape sends `key <base> Escape`, Enter a click on the
// highlighted item). The explorer's context menu uses it ("sidebar:menu:"),
// as will the colour and link pickers and the menu button.
#pragma once
#include <windows.h>
#include <d2d1_1.h>
#include <nlohmann/json.hpp>
#include <functional>
#include <string>
#include <vector>
#include "ui/edit.h"
#include "ui/painter.h"

struct PopupItem {
  std::string id;
  std::wstring label;
  bool enabled = true;
  bool separator = false;   // a separator line; id and label unused
  bool operator==(const PopupItem& o) const { return id == o.id && label == o.label && enabled == o.enabled && separator == o.separator; }
};

class Popup {
public:
  // Shows `items` with the top-left corner at a window client DIP point (moved
  // left and up as far as needed to stay inside the body). The same menu set
  // again keeps its keyboard highlight.
  void set(const std::string& prefix, const std::vector<PopupItem>& items, float xDip, float yDip);
  void close();
  bool isOpen() const { return !prefix_.empty(); }
  const std::string& prefix() const { return prefix_; }
  std::string base() const { return prefix_.empty() ? std::string() : prefix_.substr(0, prefix_.size() - 1); }
  bool owns(const std::string& target) const;          // base, or one of the items
  bool enabled(const std::string& target) const;       // one of the enabled items
  // `body` is the body's client rect in device pixels, `bodyTop` the body's
  // top in client pixels of the window (the model's DIP are window client DIP).
  void draw(Painter& p, D2D1_RECT_F body, float bodyTop, const std::string& hoverTarget);
  // WM_KEYDOWN, WM_CHAR, WM_KEYUP: true when consumed. Called for every key,
  // open or not, so the WM_CHAR of an Escape that closed it is still eaten.
  bool key(UINT msg, WPARAM w, Mods m);
  std::function<void(D2D1_RECT_F, const std::string&)> hit;   // Ui::hit for the body
  std::function<void(const nlohmann::json&)> emit;             // Wire::sendEvent

private:
  void step(int dir);

  std::string prefix_;
  std::vector<PopupItem> items_;
  float xDip_ = 0, yDip_ = 0;
  int kb_ = -1;               // the keyboard's highlighted item, -1 for none
  bool swallowChar_ = false;  // the WM_CHAR of a key handled on WM_KEYDOWN
};
