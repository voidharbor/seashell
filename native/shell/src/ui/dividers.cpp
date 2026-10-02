// The 9 DIP divider strips between panes, a 1 px line in `divider` down the
// middle. Ui::mouse sends their down, move and up events; the cursor comes
// from Ui::cursorFor.
#include "ui/ui.h"
#include <cmath>

void Ui::viewDividers(Painter& p) {
  if (m_.zoomedPaneId) return;   // the zoomed pane hides the dividers
  float d = dpi();
  float one = std::max(1.f, std::round(d));
  for (const DividerModel& dv : m_.dividers) {
    D2D1_RECT_F r = dev(dv.rect);
    std::string target = "divider:" + dv.id;
    hit(false, r, target);
    bool active = hovered(target) || dragDivider_ == target;
    if (dv.orientation == "horizontal") {
      float y = std::round((r.top + r.bottom) / 2 - one / 2);
      p.fillRect(D2D1::RectF(r.left, y, r.right, y + one), active ? t_.accent : t_.divider);
    } else {
      float x = std::round((r.left + r.right) / 2 - one / 2);
      p.fillRect(D2D1::RectF(x, r.top, x + one, r.bottom), active ? t_.accent : t_.divider);
    }
  }
}
