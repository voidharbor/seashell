// Port of src/renderer/term/wheel-ramp.ts: velocity-ramped wheel scrolling.
// Below `onset` px/ms the multiplier is exactly 1; above it the multiplier
// rises with `gain` up to `ceiling`; a pause longer than `decayMs` resets it.
#pragma once

struct WheelRampOptions {
  float ceiling = 8;
  float onset = 1.5f;      // px/ms
  float gain = 1.2f;
  double decayMs = 200;
  float smoothing = 0.3f;  // EMA weight of the newest sample
};

class WheelRamp {
public:
  explicit WheelRamp(WheelRampOptions o = {}) : o_(o) {}
  // The multiplier for one wheel event of dyPx pixels at nowMs (WheelRamp.feed).
  float feed(float dyPx, double nowMs);
  // Whole rows to scroll for dyPx (signed; negative scrolls back) with rows of
  // rowPx pixels, carrying the fraction to the next event. forced1x skips the
  // ramp (alternate screen, mouse tracking).
  int rows(float dyPx, double nowMs);
  void reset();                // focus loss
  float rowPx = 16;
  bool forced1x = false;

private:
  WheelRampOptions o_;
  float velocity_ = 0;
  double lastAt_ = -1;
  float carry_ = 0;
};
