@echo off
rem Builds native\shell into shell-build\Release\SeaShell.exe (plus the
rem width-test, grid-test and distro-test tools) inside the build tree this
rem script sits in. Run from WSL after scripts/win/sync-tree.sh:
rem   cd /mnt/c && cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd
rem SEASHELL_VCPKG picks the vcpkg checkout (default C:\Users\josh\dev\vcpkg).
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
if not defined SEASHELL_VCPKG set "SEASHELL_VCPKG=C:\Users\josh\dev\vcpkg"
cd /d "%ROOT%"
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cmake -S "%ROOT%\native\shell" -B "%ROOT%\shell-build" -A x64 -DCMAKE_TOOLCHAIN_FILE="%SEASHELL_VCPKG%\scripts\buildsystems\vcpkg.cmake" || exit /b 1
cmake --build "%ROOT%\shell-build" --config Release --parallel 4 || exit /b 1
echo built %ROOT%\shell-build\Release\SeaShell.exe
