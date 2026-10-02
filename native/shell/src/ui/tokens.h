// The chrome's colors, from the model's token table (Task 16 fills it from the
// desktop colorization). A missing or malformed key falls back to the Aero
// defaults for colorization #881798 (redesign spec sections 6.2 and 6.3).
#pragma once
#include <cstdint>
#include <cstdlib>
#include <map>
#include <string>

struct Tokens {
  // 0x00RRGGBB, except glassTint (0xAARRGGBB).
  uint32_t frame = 0xB685BD;        // #881798 at 43 percent over the Win7 base grey #D9D9D9 (balances 8/43/49): the opaque strip
  uint32_t frameText = 0x1D0F22;    // --text
  uint32_t tabActive = 0xFFFFFF;    // 6.3 tabs: active face #ffffff to #f3f3f3
  uint32_t tabInactive = 0xDCDCDC;  // 6.3 tabs: inactive face #f2f2f2 to #dcdcdc
  uint32_t tabText = 0x1D0F22;      // --text
  uint32_t body = 0xECE2F0;         // --chrome
  uint32_t panel = 0xFAF5FC;        // --cardBg
  uint32_t panelBorder = 0x8F5FA0;  // --paneBorder
  uint32_t titleBar = 0xEAD9F0;     // --paneTitleBg
  uint32_t titleText = 0x1D0F22;    // --text
  uint32_t badge = 0xE1D3E8;        // --chromeAlt
  uint32_t badgeText = 0x5A3F66;    // --dim
  uint32_t divider = 0xB48FC0;      // --line
  uint32_t statusBg = 0xECECEC;     // 6.3 status bar: #f7f7f7 to #ececec
  uint32_t statusText = 0x1D0F22;   // --text
  uint32_t toastBg = 0xF0F0F0;      // 6.3 cards and dialogs: #f0f0f0 face
  uint32_t toastText = 0x1D0F22;    // --cardText
  uint32_t accent = 0x881798;       // --accent
  uint32_t accentText = 0xFFFFFF;   // --onAccent
  uint32_t danger = 0xFF5F56;       // styles.css --danger (6.2 does not retune it)
  uint32_t selection = 0x3399FF;    // --select, the Windows 7 selection blue
  uint32_t glassTint = 0x38881798;  // --barBg rgba(136, 23, 152, .22)
  float radius = 6;                 // --paneRadius, --cardRadius

  static Tokens fromModel(const std::map<std::string, std::string>& tokens) {
    Tokens t;
    auto rgb = [&](const char* k, uint32_t& out) {
      auto it = tokens.find(k);
      if (it == tokens.end()) return;
      const std::string& s = it->second;
      if ((s.size() != 7 && s.size() != 9) || s[0] != '#') return;
      char* end = nullptr;
      unsigned long v = strtoul(s.c_str() + 1, &end, 16);
      if (!end || *end != 0) return;
      // #RRGGBB keeps the default's alpha (only glassTint has one); #AARRGGBB
      // sets it for glassTint and is taken as its RGB elsewhere.
      if (s.size() == 7) out = (out & 0xFF000000u) | (uint32_t)v;
      else out = out > 0xFFFFFF ? (uint32_t)v : (uint32_t)(v & 0xFFFFFF);
    };
    rgb("frame", t.frame); rgb("frameText", t.frameText); rgb("tabActive", t.tabActive);
    rgb("tabInactive", t.tabInactive); rgb("tabText", t.tabText); rgb("body", t.body);
    rgb("panel", t.panel); rgb("panelBorder", t.panelBorder); rgb("titleBar", t.titleBar);
    rgb("titleText", t.titleText); rgb("badge", t.badge); rgb("badgeText", t.badgeText);
    rgb("divider", t.divider); rgb("statusBg", t.statusBg); rgb("statusText", t.statusText);
    rgb("toastBg", t.toastBg); rgb("toastText", t.toastText); rgb("accent", t.accent);
    rgb("accentText", t.accentText); rgb("danger", t.danger); rgb("selection", t.selection);
    rgb("glassTint", t.glassTint);
    auto r = tokens.find("radius");
    if (r != tokens.end()) {
      float v = strtof(r->second.c_str(), nullptr);
      if (v >= 0 && v <= 24) t.radius = v;
    }
    return t;
  }
};
