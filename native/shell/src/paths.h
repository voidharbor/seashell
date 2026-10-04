// Environment, userData and the Windows/Linux path mapping, plus the saved
// window bounds (src/main/window-bounds.ts, same file and keys).
#pragma once
#include <string>

std::wstring envW(const wchar_t* name);               // "" when unset
std::string toUtf8(const std::wstring& s);
std::wstring fromUtf8(const std::string& s);

std::wstring userDataWin();                           // SEASHELL_USER_DATA, default %APPDATA%\seashell
std::string userDataLinux();                          // C:\a\b to /mnt/c/a/b
std::string toLinuxPath(const std::wstring& winPath);  // C:\x to /mnt/c/x, \\wsl.localhost\<distro>\x to /x
std::wstring toWindowsPath(const std::string& linuxPath);   // /mnt/c/x to C:\x, else \\wsl.localhost\Ubuntu-24.04\x
std::wstring instanceName();                          // SEASHELL_INSTANCE, default "default"

// The window's last normal (unmaximized) rect plus whether it was maximized.
// On disk it is DIPs with Electron's keys (x, y, width, height, maximized), so
// the file Electron left in %APPDATA%\seashell reads back the same; Window
// converts with its DPI scale (window.cpp), and clampBounds works in pixels.
struct SavedBounds { int x = 0, y = 0, width = 0, height = 0; bool maximized = false; };
std::wstring boundsFile();                            // <userData>\window-bounds.json
bool loadBounds(SavedBounds& out);                    // the file's DIPs; false when missing or unusable
bool clampBounds(SavedBounds& b);                     // pixels, into the work area of the nearest monitor
void saveBounds(const SavedBounds& b);                // DIPs; never throws, creates userData if needed
