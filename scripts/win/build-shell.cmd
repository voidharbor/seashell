@echo off
rem Builds native\shell into shell-build\Release\SeaShell.exe. Run from WSL
rem after scripts/win/sync-tree.sh: cd /mnt/c && cmd.exe /c C:\seashell-build\redesign\scripts\win\build-shell.cmd
cd /d C:\seashell-build\redesign
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cmake -S C:\seashell-build\redesign\native\shell -B C:\seashell-build\redesign\shell-build -A x64 -DCMAKE_TOOLCHAIN_FILE=C:\Users\josh\dev\vcpkg\scripts\buildsystems\vcpkg.cmake || exit /b 1
cmake --build C:\seashell-build\redesign\shell-build --config Release || exit /b 1
echo built C:\seashell-build\redesign\shell-build\Release\SeaShell.exe
