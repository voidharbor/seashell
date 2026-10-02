#include "log.h"
#include <windows.h>
#include <cstdio>
#include <mutex>

namespace {
std::mutex g_mu;
HANDLE g_file = INVALID_HANDLE_VALUE;
}

void logOpen(const std::wstring& path) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (g_file != INVALID_HANDLE_VALUE) { CloseHandle(g_file); g_file = INVALID_HANDLE_VALUE; }
  if (path.empty()) return;
  // FILE_APPEND_DATA keeps every write at the end even if a test tails or
  // truncates the file; FILE_SHARE_* lets it be read while the shell runs.
  g_file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

void logV(const char* fmt, va_list ap) {
  char body[2048];
  int n = vsnprintf(body, sizeof body, fmt, ap);
  if (n < 0) return;
  SYSTEMTIME t; GetLocalTime(&t);
  char line[2200];
  int len = snprintf(line, sizeof line, "%02u:%02u:%02u.%03u %s\r\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, body);
  if (len < 0) return;
  if (len >= (int)sizeof line) len = (int)sizeof line - 1;
  std::lock_guard<std::mutex> lock(g_mu);
  OutputDebugStringA(line);
  if (g_file != INVALID_HANDLE_VALUE) { DWORD w = 0; WriteFile(g_file, line, (DWORD)len, &w, nullptr); }
}
