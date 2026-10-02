// Keyboard chords in the keys.ts spelling ("Ctrl+Shift+T", "Ctrl+=",
// "Ctrl+Shift+]", "Ctrl+,", "Ctrl+Shift+Return") and the table the model's
// `chords` list builds. UI thread only.
#pragma once
#include <windows.h>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "model.h"

// The plan's `Chord`; wingdi.h already declares a function of that name.
struct InputChord {
  bool ctrl = false, alt = false, shift = false;
  std::string key;   // "T", "=", "]", ",", "Return", "F5"; empty for a bare modifier
  bool operator==(const InputChord& o) const { return ctrl == o.ctrl && alt == o.alt && shift == o.shift && key == o.key; }
};

// The chord a WM_KEYDOWN or WM_SYSKEYDOWN makes with the given modifier state.
// The key is the unshifted key cap ("Ctrl+Shift+=", never "Ctrl++").
InputChord chordFromMessage(WPARAM vk, LPARAM l, bool ctrl, bool alt, bool shift);
std::string chordText(const InputChord& c);                   // Ctrl, Alt, Shift, key, joined with '+'
std::optional<InputChord> parseAccelerator(const std::string& s);   // an Electron accelerator in any modifier order

class ChordTable {
public:
  void set(const std::vector<ChordModel>& chords);       // from each ui:model
  std::optional<std::string> command(const InputChord& c) const;
  size_t size() const { return table_.size(); }

private:
  std::vector<std::pair<InputChord, std::string>> table_;
};
