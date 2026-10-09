// The chrome's colors, from the model's token table (Task 16 fills it from the
// desktop colorization; colorization.ts themeTokens for the other themes). A
// missing or malformed key falls back to the Aero defaults for colorization
// #881798 (redesign spec sections 6.2 and 6.3); the 6.3 faces below them are
// the literals the views painted before they were tokens, so Aero is the same
// with or without them.
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

  // The 6.3 faces (colorization.ts FACE_KEYS).
  uint32_t tabSheen = 0xFFFFFF;          // win7Tab's sheen over the inactive face (#3A3A3A on the dark strip)
  uint32_t tabEdge = 0x8E8F8F;           // 6.3 tabs: the 1 px border (#0A0A0A on the dark strip)
  uint32_t stripBadgeText = 0xD0D0D0;    // the zoom badge's text on the dark strip, whose fill is tabSheen
  uint32_t hoverFace = 0xFFFFFF;         // the link toggle's and refresh's hover face
  uint32_t titleSheen = 0xFFFFFF;        // mixed over titleBar for the focused pane's title gradient
  uint32_t statusSheen = 0xFFFFFF;       // mixed over statusBg for the status bar's top stop and its hint
  uint32_t statusSep = 0xC0C0C0;         // the status bar's separators
  uint32_t warn = 0xA86400;              // styles.css --warn #e5a83c, darkened to read on the light bar
  uint32_t dangerText = 0xCC4C45;        // danger at 80 percent over black: the exit and find miss text
  uint32_t shadow = 0x000000;            // drop shadows and the modal dims
  uint32_t cardBorder = 0xA0A0A0;        // 6.3 cards and dialogs; the status bar's and banner's top line
  uint32_t tipBg = 0xFFFFFF, tipBorder = 0x767676, tipText = 0x575757;
  uint32_t menuBg = 0xF0F0F0;            // 6.3 menu face
  uint32_t menuBorder = 0x979797;
  uint32_t menuHi = 0xDCEBFC, menuHiBorder = 0x7DA2CE;
  uint32_t menuSep = 0xE0E0E0, menuSepShine = 0xFFFFFF;
  uint32_t menuText = 0x1E1E1E;          // Win7 menu text
  uint32_t menuGray = 0x6D6D6D;          // GrayText
  uint32_t editBg = 0xFFFFFF;            // the Win7 text box
  uint32_t editText = 0x1E1E1E;
  uint32_t editBorder = 0xABADB3, editFocus = 0x3C7FB1;
  uint32_t editPlaceholder = 0x6D6D6D;
  uint32_t editMissBg = 0xFFD9D9, editMissBorder = 0xE04040;   // the find query with no match
  uint32_t checkTop = 0xDCDCDC, checkBottom = 0xFFFFFF, checkBorder = 0x8E8F8F;   // 6.3 check box
  uint32_t dotTrack = 0xE6E6E6;          // the tutorial's step dots mix toastText into this
  uint32_t scrollTrack = 0xF0F0F0, scrollLine = 0xE3E3E3;      // 6.3 scrollbar
  uint32_t scrollArrow = 0x4D4D4D, scrollArrowHot = 0x1C4E7C;
  uint32_t scrollThumbTop = 0xF0F0F0, scrollThumbBottom = 0xE3E3E3, scrollThumbBorder = 0xA0A0A0;
  uint32_t scrollThumbHot = 0xDCEBFC, scrollThumbHotBorder = 0x7DA2CE;
  uint32_t scrollGrip = 0x8A8A8A, scrollGripHot = 0x5B7FA6, scrollGripShine = 0xFFFFFF;
  // 6.3 button faces: top, upper middle, lower middle, bottom; the border.
  uint32_t btn0 = 0xF2F2F2, btn1 = 0xEBEBEB, btn2 = 0xDDDDDD, btn3 = 0xCFCFCF, btnBorder = 0x707070;
  uint32_t btnHover0 = 0xEAF6FD, btnHover1 = 0xD9F0FC, btnHover2 = 0xBEE6FD, btnHover3 = 0xA7D9F5, btnHoverBorder = 0x3C7FB1;
  uint32_t btnPress0 = 0xE5F4FC, btnPress1 = 0xC4E5F6, btnPress2 = 0x98D1EF, btnPress3 = 0x68B3DB, btnPressBorder = 0x2C628B;
  uint32_t btnDisabled = 0xF4F4F4, btnDisabledBorder = 0xADB2B5;
  uint32_t btnShine = 0xFFFFFF;          // the inner highlight
  uint32_t btnText = 0x1E1E1E, btnDisabledText = 0x838383;

  float radius = 6;                 // --paneRadius, --cardRadius
  float glyphGlow = 0.65f;          // the strip glyphs' white glow on glass, an alpha (0 on the dark strip)

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
    rgb("tabSheen", t.tabSheen); rgb("tabEdge", t.tabEdge); rgb("stripBadgeText", t.stripBadgeText);
    rgb("hoverFace", t.hoverFace); rgb("titleSheen", t.titleSheen); rgb("statusSheen", t.statusSheen);
    rgb("statusSep", t.statusSep); rgb("warn", t.warn); rgb("dangerText", t.dangerText);
    rgb("shadow", t.shadow); rgb("cardBorder", t.cardBorder);
    rgb("tipBg", t.tipBg); rgb("tipBorder", t.tipBorder); rgb("tipText", t.tipText);
    rgb("menuBg", t.menuBg); rgb("menuBorder", t.menuBorder); rgb("menuHi", t.menuHi); rgb("menuHiBorder", t.menuHiBorder);
    rgb("menuSep", t.menuSep); rgb("menuSepShine", t.menuSepShine); rgb("menuText", t.menuText); rgb("menuGray", t.menuGray);
    rgb("editBg", t.editBg); rgb("editText", t.editText); rgb("editBorder", t.editBorder); rgb("editFocus", t.editFocus);
    rgb("editPlaceholder", t.editPlaceholder); rgb("editMissBg", t.editMissBg); rgb("editMissBorder", t.editMissBorder);
    rgb("checkTop", t.checkTop); rgb("checkBottom", t.checkBottom); rgb("checkBorder", t.checkBorder); rgb("dotTrack", t.dotTrack);
    rgb("scrollTrack", t.scrollTrack); rgb("scrollLine", t.scrollLine); rgb("scrollArrow", t.scrollArrow);
    rgb("scrollArrowHot", t.scrollArrowHot); rgb("scrollThumbTop", t.scrollThumbTop); rgb("scrollThumbBottom", t.scrollThumbBottom);
    rgb("scrollThumbBorder", t.scrollThumbBorder); rgb("scrollThumbHot", t.scrollThumbHot);
    rgb("scrollThumbHotBorder", t.scrollThumbHotBorder); rgb("scrollGrip", t.scrollGrip); rgb("scrollGripHot", t.scrollGripHot);
    rgb("scrollGripShine", t.scrollGripShine);
    rgb("btn0", t.btn0); rgb("btn1", t.btn1); rgb("btn2", t.btn2); rgb("btn3", t.btn3); rgb("btnBorder", t.btnBorder);
    rgb("btnHover0", t.btnHover0); rgb("btnHover1", t.btnHover1); rgb("btnHover2", t.btnHover2); rgb("btnHover3", t.btnHover3);
    rgb("btnHoverBorder", t.btnHoverBorder);
    rgb("btnPress0", t.btnPress0); rgb("btnPress1", t.btnPress1); rgb("btnPress2", t.btnPress2); rgb("btnPress3", t.btnPress3);
    rgb("btnPressBorder", t.btnPressBorder);
    rgb("btnDisabled", t.btnDisabled); rgb("btnDisabledBorder", t.btnDisabledBorder); rgb("btnShine", t.btnShine);
    rgb("btnText", t.btnText); rgb("btnDisabledText", t.btnDisabledText);
    auto r = tokens.find("radius");
    if (r != tokens.end()) {
      float v = strtof(r->second.c_str(), nullptr);
      if (v >= 0 && v <= 24) t.radius = v;
    }
    auto gg = tokens.find("glyphGlow");
    if (gg != tokens.end()) {
      char* end = nullptr;
      float v = strtof(gg->second.c_str(), &end);
      if (end != gg->second.c_str() && v >= 0 && v <= 1) t.glyphGlow = v;
    }
    return t;
  }
};
