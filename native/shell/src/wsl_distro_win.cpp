// The Windows half of wsl_distro.h: the registry, wsl.exe -l -q and the log.
#include "wsl_distro.h"
#include "app.h"
#include "core_proc.h"
#include "paths.h"
#include <windows.h>
#include <algorithm>

namespace {
const wchar_t* kLxss = L"Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
const DWORD kListTimeoutMs = 10000;

std::wstring regString(const std::wstring& key, const wchar_t* value) {
  DWORD size = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), value, RRF_RT_REG_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS ||
      size < sizeof(wchar_t))
    return L"";
  std::wstring v(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), value, RRF_RT_REG_SZ, nullptr, v.data(), &size) != ERROR_SUCCESS)
    return L"";
  v.resize(wcsnlen(v.c_str(), v.size()));
  return v;
}

// Every distro registered for this user (each Lxss subkey's DistributionName)
// and, through DefaultDistribution, which one is the default.
std::vector<std::wstring> registryDistros(std::wstring& def) {
  std::vector<std::wstring> out;
  HKEY h = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kLxss, 0, KEY_READ, &h) != ERROR_SUCCESS) return out;
  std::wstring defGuid = regString(kLxss, L"DefaultDistribution");
  for (DWORD i = 0;; i++) {
    wchar_t sub[256];
    DWORD n = 256;
    LONG r = RegEnumKeyExW(h, i, sub, &n, nullptr, nullptr, nullptr, nullptr);
    if (r == ERROR_NO_MORE_ITEMS) break;
    if (r != ERROR_SUCCESS) continue;
    std::wstring name = regString(std::wstring(kLxss) + L"\\" + sub, L"DistributionName");
    if (name.empty()) continue;
    out.push_back(name);
    if (!defGuid.empty() && _wcsicmp(sub, defGuid.c_str()) == 0) def = name;
  }
  RegCloseKey(h);
  return out;
}

// `wsl.exe -l -q`'s raw stdout, or "" when it fails, times out or exits non-zero
// (with no distro it prints help text and exits 1).
std::string runWslList() {
  SECURITY_ATTRIBUTES sa{ sizeof sa, nullptr, TRUE };
  HANDLE outR = nullptr, outW = nullptr;
  if (!CreatePipe(&outR, &outW, &sa, 64 * 1024)) return "";
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  std::wstring exe = wslExe();
  PROCESS_INFORMATION pi{};
  DWORD err = 0;
  bool ok = spawnHidden(exe, L"wsl.exe -l -q", nul, outW, nul, pi, err);
  CloseHandle(outW);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!ok) {
    App::log("wsl distro: wsl.exe -l -q did not start (%lu)", err);
    CloseHandle(outR);
    return "";
  }
  CloseHandle(pi.hThread);
  std::string out;
  ULONGLONG end = GetTickCount64() + kListTimeoutMs;
  bool exited = false;
  for (;;) {
    DWORD avail = 0;
    while (PeekNamedPipe(outR, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
      char buf[4096];
      DWORD got = 0;
      if (!ReadFile(outR, buf, std::min<DWORD>(avail, sizeof buf), &got, nullptr) || got == 0) break;
      out.append(buf, got);
    }
    if (exited) break;
    if (WaitForSingleObject(pi.hProcess, 50) == WAIT_OBJECT_0) { exited = true; continue; }
    if (GetTickCount64() >= end) break;
  }
  DWORD code = 1;
  if (exited) GetExitCodeProcess(pi.hProcess, &code);
  else TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hProcess);
  CloseHandle(outR);
  if (code != 0) {
    App::log("wsl distro: wsl.exe -l -q exit %lu", code);
    return "";
  }
  return out;
}
}  // namespace

const DistroPick& wslDistroPick() {
  static const DistroPick pick = [] {
    std::wstring def;
    std::vector<std::wstring> installed = registryDistros(def);
    const char* from = "registry";
    if (installed.empty() || def.empty()) {
      std::vector<std::wstring> listed = parseWslList(runWslList());
      if (!listed.empty()) { installed = listed; from = "wsl -l -q"; }
    }
    DistroPick p = pickDistro(envW(L"SEASHELL_WSL_DISTRO"), def, installed);
    std::wstring all;
    for (const auto& i : installed) all += (all.empty() ? L"" : L",") + i;
    if (p.name.empty()) App::log("error: wsl distro: none (%s): %s; installed [%s]", from, toUtf8(p.error).c_str(), toUtf8(all).c_str());
    else App::log("wsl distro %s (%s; installed [%s] from %s)", toUtf8(p.name).c_str(), p.source.c_str(), toUtf8(all).c_str(), from);
    return p;
  }();
  return pick;
}

const std::wstring& wslDistro() { return wslDistroPick().name; }

const wchar_t* wslUncPrefix() {
  static const wchar_t* prefix = [] {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    RTL_OSVERSIONINFOW v{};
    v.dwOSVersionInfoSize = sizeof v;
    auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    // Windows 10 serves the distros as \\wsl$; \\wsl.localhost arrived with Windows 11.
    if (fn && fn(&v) == 0 && v.dwBuildNumber < 22000) return L"\\\\wsl$\\";
    return L"\\\\wsl.localhost\\";
  }();
  return prefix;
}
