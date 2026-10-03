// The Win7 scrollbar (redesign spec 6.3): 17 DIP wide, arrow buttons with the
// button face, track #f0f0f0 with a 1 px inset #e3e3e3 line, thumb #f0f0f0 to
// #e3e3e3 with a #a0a0a0 border, 2 px radius and three grip lines; hover thumb
// #dcebfc with a #7da2ce border. One per scrolling view; the view owns the offset.
//
// Units: ScrollState is in DIP (the model's, uiScale already in), the bar's
// rect in device pixels of the body; layout's `scale` converts (the DPI scale).
#pragma once
#include <windows.h>
#include <d2d1_1.h>
#include <functional>
#include <string>
#include "ui/painter.h"

struct ScrollState { float offset = 0; float content = 0; float viewport = 0; bool dragging = false; float grab = 0; };

class ScrollBar {
public:
  static constexpr float kWidthDip = 17;
  void layout(D2D1_RECT_F track, float scale);          // the bar's rect in device pixels (right edge of the view)
  void draw(Painter& p, const ScrollState& s, const std::string& hoverTarget, const std::string& base);   // registers base + ":up", ":down", ":thumb", ":track"
  // Returns true when consumed; `s.offset` updated and clamped. Line = one row height.
  bool mouse(UINT msg, float x, float y, ScrollState& s, float lineDip, const std::string& target);
  static float clampOffset(float offset, float content, float viewport);
  static bool needed(const ScrollState& s) { return s.content > s.viewport + 0.5f; }
  D2D1_RECT_F rect() const { return bar_; }
  // Where draw registers its parts (Ui::hit for the body); unset registers nothing.
  std::function<void(D2D1_RECT_F, const std::string&)> hit;

private:
  D2D1_RECT_F thumb(const ScrollState& s) const;        // device pixels
  float trackTop() const { return bar_.top + side_; }
  float trackBottom() const { return bar_.bottom - side_; }
  D2D1_RECT_F bar_{};
  float scale_ = 1;
  float side_ = 0;                                      // an arrow button's height: the bar's width, or half the bar when it is short
};
