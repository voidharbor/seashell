cmake_minimum_required(VERSION 3.25)
project(seashell_shell C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(utf8proc CONFIG REQUIRED)   # the vcpkg port exports utf8proc::utf8proc
find_package(nlohmann_json CONFIG REQUIRED)
# add_subdirectory(../third_party/libvterm ${CMAKE_BINARY_DIR}/libvterm)   # Task 10 adds it; comment out until then

# The one version: package.json's, into version.h for app.rc and the sources.
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/../../package.json SEASHELL_PKG)
string(JSON SEASHELL_VERSION GET "${SEASHELL_PKG}" version)
string(REPLACE "." "," SEASHELL_VERSION_CSV "${SEASHELL_VERSION}")
file(CONFIGURE OUTPUT ${CMAKE_BINARY_DIR}/generated/version.h CONTENT
"#pragma once\n#define SEASHELL_VERSION_STR \"${SEASHELL_VERSION}\"\n#define SEASHELL_VERSION_CSV ${SEASHELL_VERSION_CSV},0\n")

file(GLOB SHELL_SRC CONFIGURE_DEPENDS src/*.cpp src/ui/*.cpp)
add_executable(SeaShell WIN32 ${SHELL_SRC} app.rc)
target_include_directories(SeaShell PRIVATE src ${CMAKE_BINARY_DIR}/generated)
# vterm joins this list when Task 10 vendors libvterm.
target_link_libraries(SeaShell PRIVATE utf8proc::utf8proc nlohmann_json::nlohmann_json d2d1 dwrite dwmapi windowscodecs shlwapi ws2_32 shell32 ole32 uxtheme)
target_compile_definitions(SeaShell PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(SeaShell PRIVATE $<$<COMPILE_LANGUAGE:CXX>:/W3 /utf-8 /EHsc>)
# app.rc embeds app.manifest; a linker-generated one would be a duplicate resource.
target_link_options(SeaShell PRIVATE /MANIFEST:NO)
