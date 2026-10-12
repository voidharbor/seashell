// Unit tests for the pure half of wsl_distro.h (parseWslList, cleanDistroName,
// pickDistro). Prints one line per failure and "distro-test: N passed" at the
// end; exits 1 on any failure.
#include "wsl_distro.h"
#include <cstdio>
#include <string>
#include <vector>

static int g_failed = 0, g_passed = 0;

static void check(bool ok, const char* what) {
  if (ok) g_passed++;
  else { g_failed++; std::printf("FAIL %s\n", what); }
}

static std::string utf16(const std::wstring& w, bool bom) {
  std::string out;
  if (bom) out += "\xFF\xFE";
  for (wchar_t c : w) { out += (char)(c & 0xFF); out += (char)((c >> 8) & 0xFF); }
  return out;
}

using List = std::vector<std::wstring>;

int main() {
  // parseWslList
  check(parseWslList(utf16(L"Ubuntu-24.04\r\nDebian\r\n", false)) == List{ L"Ubuntu-24.04", L"Debian" }, "utf16 crlf");
  check(parseWslList(utf16(L"Ubuntu-24.04\r\n\r\ndocker-desktop\r\n", true)) == List{ L"Ubuntu-24.04", L"docker-desktop" }, "utf16 bom, blank line");
  check(parseWslList(utf16(L"  Arch \r\n", false)) == List{ L"Arch" }, "trims spaces");
  check(parseWslList(utf16(L"Ubuntu", false)) == List{ L"Ubuntu" }, "no trailing newline");
  check(parseWslList("Ubuntu-22.04\nkali-linux\n") == List{ L"Ubuntu-22.04", L"kali-linux" }, "utf8 output (WSL_UTF8=1)");
  check(parseWslList(std::string("U\0b\0u\0n\0t\0u\0\r\0\n\0\0\0", 18)) == List{ L"Ubuntu" }, "stray NUL");
  check(parseWslList("").empty(), "empty output");
  check(parseWslList(utf16(L"\r\n\r\n", true)).empty(), "only blank lines");
  check(parseWslList(utf16(L"Café\r\n", false)) == List{ L"Café" }, "non-ASCII name");

  // cleanDistroName
  check(cleanDistroName(L"  Debian ") == L"Debian", "clean trims");
  check(cleanDistroName(L"").empty(), "clean blank");
  check(cleanDistroName(L"   ").empty(), "clean spaces");
  check(cleanDistroName(L"a\\b").empty(), "clean backslash");
  check(cleanDistroName(L"a/b").empty(), "clean slash");
  check(cleanDistroName(L"C:").empty(), "clean colon");

  const List installed = { L"Ubuntu-24.04", L"Debian", L"SeaShellPortableTest" };

  // pickDistro: the override wins
  DistroPick p = pickDistro(L"SeaShellPortableTest", L"Ubuntu-24.04", installed);
  check(p.name == L"SeaShellPortableTest" && p.source == "SEASHELL_WSL_DISTRO", "override wins");
  p = pickDistro(L" debian ", L"Ubuntu-24.04", installed);
  check(p.name == L"Debian" && p.source == "SEASHELL_WSL_DISTRO", "override matches case-insensitively, installed spelling");
  p = pickDistro(L"Nope", L"Ubuntu-24.04", installed);
  check(p.name.empty() && p.error.find(L"not installed") != std::wstring::npos, "override not installed");
  p = pickDistro(L"Nope", L"", {});
  check(p.name == L"Nope", "override trusted when nothing is listed");
  p = pickDistro(L"a/b", L"Ubuntu-24.04", installed);
  check(p.name.empty() && !p.error.empty(), "override not a name");

  // pickDistro: the default, then the first listed
  p = pickDistro(L"", L"Ubuntu-24.04", installed);
  check(p.name == L"Ubuntu-24.04" && p.source == "default", "registry default");
  p = pickDistro(L"   ", L"Debian", installed);
  check(p.name == L"Debian" && p.source == "default", "blank override ignored");
  p = pickDistro(L"", L"", installed);
  check(p.name == L"Ubuntu-24.04" && p.source == "first listed", "first listed without a default");
  p = pickDistro(L"", L"Gone", installed);
  check(p.name == L"Ubuntu-24.04" && p.source == "first listed", "a stale default falls back");
  p = pickDistro(L"", L"docker-desktop", { L"docker-desktop", L"docker-desktop-data", L"Ubuntu" });
  check(p.name == L"Ubuntu" && p.source == "first listed", "docker-desktop default skipped");
  p = pickDistro(L"", L"", { L"docker-desktop", L"docker-desktop-data" });
  check(p.name.empty() && !p.error.empty(), "only docker distros");
  p = pickDistro(L"docker-desktop", L"", { L"docker-desktop", L"Ubuntu" });
  check(p.name == L"docker-desktop", "docker-desktop when named");
  p = pickDistro(L"", L"", {});
  check(p.name.empty() && p.error.find(L"No WSL") != std::wstring::npos, "nothing installed");

  std::printf("distro-test: %d passed, %d failed\n", g_passed, g_failed);
  return g_failed ? 1 : 0;
}
