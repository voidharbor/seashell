#include "paths.h"
#include "wsl_distro.h"
#include <windows.h>
#include <shlobj.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

std::wstring envW(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (n == 0) return L"";
  std::wstring v(n, L'\0');
  DWORD got = GetEnvironmentVariableW(name, v.data(), n);
  v.resize(got);
  return v;
}

std::string toUtf8(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring fromUtf8(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
  return out;
}

std::wstring userDataWin() {
  std::wstring v = envW(L"SEASHELL_USER_DATA");
  if (!v.empty()) {
    while (v.size() > 3 && (v.back() == L'\\' || v.back() == L'/')) v.pop_back();
    return v;
  }
  return envW(L"APPDATA") + L"\\seashell";
}

std::string toLinuxPath(const std::wstring& winPath) {
  std::wstring p = winPath;
  std::replace(p.begin(), p.end(), L'/', L'\\');
  for (const wchar_t* prefix : { L"\\\\wsl.localhost\\", L"\\\\wsl$\\" }) {
    size_t len = wcslen(prefix);
    if (p.size() >= len && _wcsnicmp(p.c_str(), prefix, len) == 0) {
      size_t slash = p.find(L'\\', len);   // skip the distro name
      std::wstring rest = slash == std::wstring::npos ? L"" : p.substr(slash);
      std::replace(rest.begin(), rest.end(), L'\\', L'/');
      return rest.empty() ? "/" : toUtf8(rest);
    }
  }
  if (p.size() >= 2 && p[1] == L':' && iswalpha(p[0])) {
    std::wstring rest = p.substr(2);
    std::replace(rest.begin(), rest.end(), L'\\', L'/');
    while (rest.size() > 1 && rest.back() == L'/') rest.pop_back();
    std::wstring out = L"/mnt/";
    out += (wchar_t)towlower(p[0]);
    if (rest != L"/") out += rest;
    return toUtf8(out);
  }
  std::replace(p.begin(), p.end(), L'\\', L'/');
  return toUtf8(p);
}

std::string userDataLinux() { return toLinuxPath(userDataWin()); }

std::wstring toWindowsPath(const std::string& linuxPath) {
  std::wstring p = fromUtf8(linuxPath);
  // /mnt/<letter> or /mnt/<letter>/...
  if (p.size() >= 6 && p.compare(0, 5, L"/mnt/") == 0 && iswalpha(p[5]) && (p.size() == 6 || p[6] == L'/')) {
    std::wstring out;
    out += (wchar_t)towupper(p[5]);
    out += L":";
    std::wstring rest = p.size() > 6 ? p.substr(6) : L"/";
    std::replace(rest.begin(), rest.end(), L'/', L'\\');
    return out + rest;
  }
  std::replace(p.begin(), p.end(), L'/', L'\\');
  if (p.empty() || p[0] != L'\\') p = L"\\" + p;
  return std::wstring(wslUncPrefix()) + wslDistro() + p;
}

std::wstring instanceName() {
  std::wstring v = envW(L"SEASHELL_INSTANCE");
  if (v.empty()) return L"default";
  // Kernel object names after Local\ may not hold a backslash.
  std::replace(v.begin(), v.end(), L'\\', L'_');
  return v;
}

std::wstring boundsFile() { return userDataWin() + L"\\window-bounds.json"; }

// clampToWorkArea from src/main/window-bounds.ts: shrink into the work area,
// then slide so every edge is inside.
static void clampTo(SavedBounds& b, const RECT& wa) {
  int waw = wa.right - wa.left, wah = wa.bottom - wa.top;
  b.width = std::max(1, std::min(b.width, waw));
  b.height = std::max(1, std::min(b.height, wah));
  b.x = std::min(std::max(b.x, (int)wa.left), (int)wa.left + waw - b.width);
  b.y = std::min(std::max(b.y, (int)wa.top), (int)wa.top + wah - b.height);
}

bool loadBounds(SavedBounds& out) {
  std::ifstream f(boundsFile(), std::ios::binary);
  if (!f) return false;
  std::stringstream ss; ss << f.rdbuf();
  nlohmann::json j = nlohmann::json::parse(ss.str(), nullptr, false);
  if (j.is_discarded() || !j.is_object()) return false;
  auto num = [&](const char* k, double& v) {
    auto it = j.find(k);
    if (it == j.end() || !it->is_number()) return false;
    v = it->get<double>();
    return std::isfinite(v);
  };
  double x, y, w, h;
  if (!num("x", x) || !num("y", y) || !num("width", w) || !num("height", h)) return false;
  if (w <= 0 || h <= 0) return false;
  auto mx = j.find("maximized");
  out.x = (int)std::lround(x); out.y = (int)std::lround(y);
  out.width = (int)std::lround(w); out.height = (int)std::lround(h);
  out.maximized = mx != j.end() && mx->is_boolean() && mx->get<bool>();
  return true;
}

bool clampBounds(SavedBounds& b) {
  RECT r{ b.x, b.y, b.x + b.width, b.y + b.height };
  MONITORINFO mi{ sizeof mi };
  if (!GetMonitorInfoW(MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST), &mi)) return false;
  clampTo(b, mi.rcWork);
  return true;
}

void saveBounds(const SavedBounds& b) {
  if (b.width <= 0 || b.height <= 0) return;
  std::wstring dir = userDataWin();
  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);   // fine when it exists
  nlohmann::json j = { { "x", b.x }, { "y", b.y }, { "width", b.width }, { "height", b.height }, { "maximized", b.maximized } };
  std::ofstream f(boundsFile(), std::ios::binary | std::ios::trunc);
  if (f) f << j.dump();   // a lost position is not worth an error on quit
}
