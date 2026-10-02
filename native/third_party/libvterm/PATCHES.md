# libvterm, vendored

Source: https://github.com/neovim/libvterm, branch `nvim`, commit
`934bc2fbf21800ac3458a499df8820ca5fb45fd3`. Copied: `src/*.c`, `src/*.h`,
`src/*.inc`, `src/encoding/*.inc`, `include/*.h`, `LICENSE` (MIT).
`CMakeLists.txt` and this file are SeaShell's.

## Edits

The only changes to upstream are the width hooks that let
`native/shell/src/width.cpp` match xterm.js with `@xterm/addon-unicode-graphemes`:

- `vterm_width_hook(cp)`: replaces `vterm_unicode_width` when set.
- `vterm_combining_hook(cp, prev)`: replaces `vterm_unicode_is_combining`
  when set; `vterm_unicode_is_combining` gains the `prev` parameter and every
  call site in `state.c` passes the codepoint before it in the same write
  (0 at the start of a write).
- `vterm_glyph_width_hook(chars, n)`: when set, replaces the sum of member
  widths for a cluster. Added beyond the per-codepoint hooks because libvterm
  sums the width of every codepoint in a cluster, which would give a ZWJ
  family six cells; xterm.js gives a cluster the width of its widest member.

All three are null by default, so an unhooked libvterm behaves as upstream.

```diff
diff -u a/src/state.c b/src/state.c
--- a/src/state.c
+++ b/src/state.c
@@ -332,7 +332,7 @@
 
   /* This is a combining char. that needs to be merged with the previous
    * glyph output */
-  if(vterm_unicode_is_combining(codepoints[i])) {
+  if(vterm_unicode_is_combining(codepoints[i], i > 0 ? codepoints[i - 1] : 0)) {
     /* See if the cursor has moved since */
     if(state->pos.row == state->combine_pos.row && state->pos.col == state->combine_pos.col + state->combine_width) {
 #ifdef DEBUG_GLYPH_COMBINE
@@ -349,7 +349,7 @@
         saved_i++;
 
       /* Add extra ones */
-      while(i < npoints && vterm_unicode_is_combining(codepoints[i])) {
+      while(i < npoints && vterm_unicode_is_combining(codepoints[i], i > 0 ? codepoints[i - 1] : 0)) {
         if(saved_i >= state->combine_chars_size)
           grow_combine_buffer(state);
         state->combine_chars[saved_i++] = codepoints[i++];
@@ -379,7 +379,7 @@
     for(glyph_ends = i + 1;
         (glyph_ends < npoints) && (glyph_ends < glyph_starts + VTERM_MAX_CHARS_PER_CELL);
         glyph_ends++)
-      if(!vterm_unicode_is_combining(codepoints[glyph_ends]))
+      if(!vterm_unicode_is_combining(codepoints[glyph_ends], codepoints[glyph_ends - 1]))
         break;
 
     int width = 0;
@@ -397,8 +397,10 @@
 #endif
       width += this_width;
     }
+    if(vterm_glyph_width_hook)
+      width = vterm_glyph_width_hook(chars, glyph_ends - glyph_starts);
 
-    while(i < npoints && vterm_unicode_is_combining(codepoints[i]))
+    while(i < npoints && vterm_unicode_is_combining(codepoints[i], i > 0 ? codepoints[i - 1] : 0))
       i++;
 
     chars[glyph_ends - glyph_starts] = 0;
diff -u a/src/unicode.c b/src/unicode.c
--- a/src/unicode.c
+++ b/src/unicode.c
@@ -1,5 +1,10 @@
 #include "vterm_internal.h"
 
+/* SeaShell: width hooks installed by native/shell/src/width.cpp (see PATCHES.md). */
+int (*vterm_width_hook)(uint32_t cp) = 0;
+int (*vterm_combining_hook)(uint32_t cp, uint32_t prev) = 0;
+int (*vterm_glyph_width_hook)(const uint32_t *chars, int n) = 0;
+
 // ### The following from http://www.cl.cam.ac.uk/~mgk25/ucs/wcwidth.c
 // With modifications:
 //   made functions static
@@ -301,13 +306,19 @@
 
 INTERNAL int vterm_unicode_width(uint32_t codepoint)
 {
+  if(vterm_width_hook)
+    return vterm_width_hook(codepoint);
+
   if(bisearch(codepoint, fullwidth, sizeof(fullwidth) / sizeof(fullwidth[0]) - 1))
     return 2;
 
   return mk_wcwidth(codepoint);
 }
 
-INTERNAL int vterm_unicode_is_combining(uint32_t codepoint)
+INTERNAL int vterm_unicode_is_combining(uint32_t codepoint, uint32_t prev)
 {
+  if(vterm_combining_hook)
+    return vterm_combining_hook(codepoint, prev);
+
   return bisearch(codepoint, combining, sizeof(combining) / sizeof(struct interval) - 1);
 }
diff -u a/src/vterm_internal.h b/src/vterm_internal.h
--- a/src/vterm_internal.h
+++ b/src/vterm_internal.h
@@ -293,6 +293,7 @@
 VTermEncoding *vterm_lookup_encoding(VTermEncodingType type, char designation);
 
 int vterm_unicode_width(uint32_t codepoint);
-int vterm_unicode_is_combining(uint32_t codepoint);
+int vterm_unicode_is_combining(uint32_t codepoint, uint32_t prev);
+extern int (*vterm_glyph_width_hook)(const uint32_t *chars, int n);
 
 #endif
```
