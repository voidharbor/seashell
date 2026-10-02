#include "wheel_ramp.h"
#include <algorithm>
#include <cmath>

float WheelRamp::feed(float dyPx, double now) {
  float px = std::fabs(dyPx);
  if (lastAt_ < 0 || now - lastAt_ > o_.decayMs) {
    velocity_ = 0;
    lastAt_ = now;
    return 1;
  }
  double dt = std::max(1.0, now - lastAt_);
  lastAt_ = now;
  float inst = (float)(px / dt);
  velocity_ += (inst - velocity_) * o_.smoothing;
  if (velocity_ <= o_.onset) return 1;
  return std::min(o_.ceiling, 1 + (velocity_ - o_.onset) * o_.gain);
}

int WheelRamp::rows(float dyPx, double nowMs) {
  float mult = feed(dyPx, nowMs);
  if (forced1x) mult = 1;
  if ((dyPx < 0) != (carry_ < 0)) carry_ = 0;   // a reversal starts the fraction afresh
  carry_ += dyPx / std::max(1.f, rowPx) * mult;
  int n = (int)carry_;   // toward zero
  carry_ -= (float)n;
  return n;
}

void WheelRamp::reset() {
  velocity_ = 0;
  lastAt_ = -1;
  carry_ = 0;
}
