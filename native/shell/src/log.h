// The shell's log: one timestamped line per call, appended to SEASHELL_SHELL_LOG
// when it is set and always sent to OutputDebugString. Every envelope channel
// and every error goes through here (App::log is the public entry).
#pragma once
#include <cstdarg>
#include <string>

void logOpen(const std::wstring& path);   // empty path: debugger output only
void logV(const char* fmt, va_list ap);
