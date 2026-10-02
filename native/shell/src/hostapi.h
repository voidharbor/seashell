// The channels the shell answers itself (spec 4.2, SHELL_CHANNELS in wire.cpp):
// window controls, the folder picker, the clipboard, ShellExecute, displays,
// the DWM colorization and the test screenshot. Paths arrive as Linux paths and
// leave as Linux paths. UI thread only.
#pragma once
#include <nlohmann/json.hpp>
#include <string>

class HostApi {
public:
  static nlohmann::json handle(const std::string& ch, const nlohmann::json& p);
};
