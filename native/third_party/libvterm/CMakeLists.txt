# libvterm from https://github.com/neovim/libvterm (branch nvim), vendored with
# the SeaShell width hooks; PATCHES.md lists every edit.
cmake_minimum_required(VERSION 3.25)
project(vterm C)
file(GLOB VTERM_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.c)
add_library(vterm STATIC ${VTERM_SRC})
target_include_directories(vterm PUBLIC include PRIVATE src)
# vterm_internal.h defines INTERNAL only under __GNUC__; MSVC takes the empty
# fallback already, so this is belt and braces.
target_compile_definitions(vterm PRIVATE INTERNAL=)
set_target_properties(vterm PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED ON)
if(MSVC)
  target_compile_options(vterm PRIVATE /W3 /utf-8 /wd4244 /wd4267 /wd4018 /wd4996)
endif()
