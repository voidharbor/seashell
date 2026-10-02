#include "chords.h"
#include <algorithm>
#include <cctype>

namespace {
std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)tolower(c); });
  return s;
}

// The punctuation keys of the US layout, used when the active layout maps
// none of its own.
const char* usOem(UINT vk) {
  switch (vk) {
    case VK_OEM_PLUS: return "=";
    case VK_OEM_MINUS: return "-";
    case VK_OEM_COMMA: return ",";
    case VK_OEM_PERIOD: return ".";
    case VK_OEM_1: return ";";
    case VK_OEM_2: return "/";
    case VK_OEM_3: return "`";
    case VK_OEM_4: return "[";
    case VK_OEM_5: return "\\";
    case VK_OEM_6: return "]";
    case VK_OEM_7: return "'";
    default: return nullptr;
  }
}

// Electron's names for the non-character keys, in the spelling menu.ts uses.
const struct { UINT vk; const char* name; } kNamed[] = {
  { VK_RETURN, "Return" }, { VK_TAB, "Tab" }, { VK_SPACE, "Space" }, { VK_BACK, "Backspace" },
  { VK_DELETE, "Delete" }, { VK_INSERT, "Insert" }, { VK_HOME, "Home" }, { VK_END, "End" },
  { VK_PRIOR, "PageUp" }, { VK_NEXT, "PageDown" }, { VK_UP, "Up" }, { VK_DOWN, "Down" },
  { VK_LEFT, "Left" }, { VK_RIGHT, "Right" }, { VK_ESCAPE, "Escape" },
};

// Accelerator key names that mean the same key ("Enter" is "Return").
std::string canonicalKey(const std::string& k) {
  std::string l = lower(k);
  if (l == "enter" || l == "return") return "Return";
  if (l == "esc" || l == "escape") return "Escape";
  if (l == "plus") return "=";
  if (l == "arrowup") return "Up";
  if (l == "arrowdown") return "Down";
  if (l == "arrowleft") return "Left";
  if (l == "arrowright") return "Right";
  for (const auto& n : kNamed)
    if (l == lower(n.name)) return n.name;
  if (l.size() >= 2 && l[0] == 'f' && isdigit((unsigned char)l[1])) return "F" + l.substr(1);
  if (k.size() == 1) return std::string(1, (char)toupper((unsigned char)k[0]));
  return k;
}
}  // namespace

InputChord chordFromMessage(WPARAM w, LPARAM, bool ctrl, bool alt, bool shift) {
  InputChord c;
  c.ctrl = ctrl; c.alt = alt; c.shift = shift;
  UINT vk = (UINT)w;
  if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) { c.key = std::string(1, (char)vk); return c; }
  if (vk >= VK_F1 && vk <= VK_F24) { c.key = "F" + std::to_string(vk - VK_F1 + 1); return c; }
  for (const auto& n : kNamed)
    if (n.vk == vk) { c.key = n.name; return c; }
  if (const char* us = usOem(vk)) {
    // The layout's own unshifted character for this key cap, else the US one.
    UINT ch = MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) & 0x7FFF;
    if (ch >= 0x21 && ch < 0x7F) c.key = std::string(1, (char)ch);
    else c.key = us;
    return c;
  }
  return c;   // a bare modifier or an unnamed key: no chord
}

std::string chordText(const InputChord& c) {
  std::string s;
  if (c.ctrl) s += "Ctrl+";
  if (c.alt) s += "Alt+";
  if (c.shift) s += "Shift+";
  return s + c.key;
}

std::optional<InputChord> parseAccelerator(const std::string& s) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (size_t i = 0; i < s.size(); i++) {
    // A '+' right after another separator is the plus key itself ("Ctrl++").
    if (s[i] == '+' && i > start) { parts.push_back(s.substr(start, i - start)); start = i + 1; }
  }
  if (start < s.size()) parts.push_back(s.substr(start));
  if (parts.empty()) return std::nullopt;
  InputChord c;
  for (size_t i = 0; i + 1 < parts.size(); i++) {
    std::string m = lower(parts[i]);
    if (m == "ctrl" || m == "control" || m == "cmdorctrl" || m == "commandorcontrol") c.ctrl = true;
    else if (m == "alt" || m == "option") c.alt = true;
    else if (m == "shift") c.shift = true;
    else return std::nullopt;   // Cmd, Super, Meta: never a Windows chord
  }
  c.key = canonicalKey(parts.back());
  if (c.key.empty()) return std::nullopt;
  return c;
}

void ChordTable::set(const std::vector<ChordModel>& chords) {
  table_.clear();
  for (const ChordModel& m : chords)
    if (auto c = parseAccelerator(m.chord); c && !m.command.empty()) table_.emplace_back(*c, m.command);
}

std::optional<std::string> ChordTable::command(const InputChord& c) const {
  if (c.key.empty()) return std::nullopt;
  for (const auto& [chord, cmd] : table_)
    if (chord == c) return cmd;
  return std::nullopt;
}
