// The WSL distro every wsl.exe run uses (the core and its staging) and every
// \\wsl.localhost path names, worked out once per shell process:
// SEASHELL_WSL_DISTRO when set, else the user's default distro
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss DefaultDistribution),
// else the first `wsl.exe -l -q` line. src/main/platform/win32.ts does the
// same for the Electron build.
#pragma once
#include <string>
#include <vector>

// [pure] The distro names in `wsl.exe -l -q` output: UTF-16LE (a BOM, CRLF
// and stray NULs allowed), one name per line, blanks dropped. Output that is
// not UTF-16 (an old wsl.exe, WSL_UTF8=1) is read as UTF-8.
std::vector<std::wstring> parseWslList(const std::string& raw);

// [pure] A distro name as SEASHELL_WSL_DISTRO gives it, trimmed; "" when it is
// blank or not one path segment (it is spliced into \\wsl.localhost paths).
std::wstring cleanDistroName(const std::wstring& v);

struct DistroPick {
  std::wstring name;     // "" when there is none; error then says why
  std::string source;    // "SEASHELL_WSL_DISTRO", "default" or "first listed"
  std::wstring error;    // for the message box
};

// [pure] The override wins (it must be installed when the installed list is
// known); else the default distro; else the first installed one. Docker
// Desktop's own distros are never picked unless named.
DistroPick pickDistro(const std::wstring& overrideRaw, const std::wstring& defaultName,
                      const std::vector<std::wstring>& installed);

// The pick for this process (the first call does the work and logs it).
const DistroPick& wslDistroPick();
// Its name, "" when there is none.
const std::wstring& wslDistro();
// \\wsl.localhost\ (Windows 11), or \\wsl$\ on Windows 10 builds that predate it.
const wchar_t* wslUncPrefix();
