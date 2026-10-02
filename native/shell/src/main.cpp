// SeaShell.exe, the native Windows shell (spec section 4). Everything lives in App.
#include "app.h"

int WINAPI wWinMain(HINSTANCE hinst, HINSTANCE, PWSTR, int) { return App::run(hinst); }
