// The pure half of wsl_distro.h; tools/distro-test.cpp links only this file.
#include "wsl_distro.h"
#include <algorithm>
#include <cwctype>

namespace {
std::wstring trim(const std::wstring& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::iswspace(s[a])) a++;
  while (b > a && std::iswspace(s[b - 1])) b--;
  return s.substr(a, b - a);
}

bool sameName(const std::wstring& a, const std::wstring& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); i++)
    if (std::towlower(a[i]) != std::towlower(b[i])) return false;
  return true;
}

bool isDocker(const std::wstring& n) {
  const std::wstring prefix = L"docker-desktop";
  return n.size() >= prefix.size() && sameName(n.substr(0, prefix.size()), prefix);
}

// UTF-8 to UTF-16 without the Windows API, for output that is not UTF-16.
std::wstring fromUtf8Bytes(const std::string& s) {
  std::wstring out;
  for (size_t i = 0; i < s.size();) {
    unsigned char c = (unsigned char)s[i];
    unsigned cp = 0;
    size_t n = 0;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c >> 5) == 6) { cp = c & 0x1F; n = 2; }
    else if ((c >> 4) == 14) { cp = c & 0x0F; n = 3; }
    else if ((c >> 3) == 30) { cp = c & 0x07; n = 4; }
    else { i++; continue; }
    if (i + n > s.size()) break;
    for (size_t k = 1; k < n; k++) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3F);
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += (wchar_t)(0xD800 + (cp >> 10));
      out += (wchar_t)(0xDC00 + (cp & 0x3FF));
    } else {
      out += (wchar_t)cp;
    }
  }
  return out;
}
}  // namespace

std::vector<std::wstring> parseWslList(const std::string& raw) {
  std::wstring text;
  // UTF-16LE: a BOM, or a NUL in an odd byte of the first character.
  bool utf16 = raw.size() >= 2 && (((unsigned char)raw[0] == 0xFF && (unsigned char)raw[1] == 0xFE) || raw[1] == '\0');
  if (utf16) {
    for (size_t i = 0; i + 1 < raw.size(); i += 2)
      text += (wchar_t)((unsigned char)raw[i] | ((unsigned char)raw[i + 1] << 8));
  } else {
    text = fromUtf8Bytes(raw);
  }
  std::vector<std::wstring> out;
  std::wstring line;
  auto flush = [&] {
    std::wstring t = trim(line);
    line.clear();
    if (!t.empty()) out.push_back(t);
  };
  for (wchar_t c : text) {
    if (c == 0xFEFF || c == L'\0' || c == L'\r') continue;
    if (c == L'\n') { flush(); continue; }
    line += c;
  }
  flush();
  return out;
}

std::wstring cleanDistroName(const std::wstring& v) {
  std::wstring t = trim(v);
  if (t.empty() || t.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos) return L"";
  for (wchar_t c : t)
    if (c < 0x20) return L"";
  return t;
}

DistroPick pickDistro(const std::wstring& overrideRaw, const std::wstring& defaultName,
                      const std::vector<std::wstring>& installed) {
  DistroPick p;
  auto find = [&](const std::wstring& n) -> const std::wstring* {
    for (const auto& i : installed)
      if (sameName(i, n)) return &i;
    return nullptr;
  };
  if (!trim(overrideRaw).empty()) {
    std::wstring o = cleanDistroName(overrideRaw);
    if (o.empty()) {
      p.error = L"SEASHELL_WSL_DISTRO is set to \"" + trim(overrideRaw) + L"\", which is not a WSL distro name.";
      return p;
    }
    if (!installed.empty() && !find(o)) {
      std::wstring list;
      for (const auto& i : installed) list += (list.empty() ? L"" : L", ") + i;
      p.error = L"SEASHELL_WSL_DISTRO names \"" + o + L"\", which is not installed. Installed: " + list + L".";
      return p;
    }
    p.name = find(o) ? *find(o) : o;
    p.source = "SEASHELL_WSL_DISTRO";
    return p;
  }
  std::wstring d = cleanDistroName(defaultName);
  if (!d.empty() && !isDocker(d) && (installed.empty() || find(d))) {
    p.name = find(d) ? *find(d) : d;
    p.source = "default";
    return p;
  }
  for (const auto& i : installed) {
    if (!isDocker(i) && !cleanDistroName(i).empty()) {
      p.name = i;
      p.source = "first listed";
      return p;
    }
  }
  p.error = L"No WSL Linux distribution is installed.";
  return p;
}
