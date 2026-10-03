# libvterm, vendored

Source: https://github.com/neovim/libvterm, branch `nvim`, commit
`934bc2fbf21800ac3458a499df8820ca5fb45fd3`. Copied: `src/*.c`, `src/*.h`,
`src/*.inc`, `src/encoding/*.inc`, `include/*.h`, `LICENSE` (MIT).
`CMakeLists.txt` and this file are SeaShell's.

## Edits

The changes to upstream are the width hooks (Task 10), the OSC 8 cell field
and the bracketed paste getter (Task 11), the split-cluster fix in `on_text`,
and the SGR 2 faint attribute (Phase 2 Task 19), listed below.

### Width hooks

The width hooks let
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

### OSC 8 links and the bracketed paste getter

For `native/shell/src/grid.cpp` (Task 11):

- `VTermScreenCell` gains `uint16_t uri_id` (0 = none). `screen.c` keeps a
  `cur_uri_id` and an interned table of `{id, uri}` entries. The screen now
  owns the state's unrecognised-sequence fallbacks: its own `osc` handler
  collects `OSC 8 ; <params> ; <uri>` (fragments joined, at most 8 KB),
  sets `cur_uri_id` (an empty uri resets it to 0; a link with the same `id=`
  parameter and uri reuses its entry; at most 65535 entries, after which new
  links get 0), and forwards every other sequence to the fallbacks set through
  `vterm_screen_set_unrecognised_fallbacks`, which now stores them on the
  screen. `putglyph` stamps `cur_uri_id` into the cell, `vterm_screen_get_cell`
  copies it out, a scrollback row popped back on resize restores it, and
  `vterm_screen_reset` clears it. Erased cells get 0.
- `const char *vterm_screen_get_uri(const VTermScreen *, uint16_t id)`: the
  target of an id, NULL for 0 or an unknown id.
- `int vterm_screen_get_bracketpaste(const VTermScreen *)`: whether DECSET
  2004 is on (libvterm tracks it but had no getter).

```diff
diff -u a/include/vterm.h b/include/vterm.h
--- a/include/vterm.h
+++ b/include/vterm.h
@@ -533,6 +533,7 @@
   char     width;
   VTermScreenCellAttrs attrs;
   VTermColor fg, bg;
+  uint16_t uri_id; /* SeaShell: OSC 8 link, 0 = none; vterm_screen_get_uri */
 } VTermScreenCell;
 
 typedef struct {
@@ -605,6 +606,13 @@
 
 int vterm_screen_get_cell(const VTermScreen *screen, VTermPos pos, VTermScreenCell *cell);
 
+/* SeaShell: the target of an OSC 8 link id from VTermScreenCell.uri_id; NULL
+ * for 0 or an unknown id. Valid for the screen's lifetime. */
+const char *vterm_screen_get_uri(const VTermScreen *screen, uint16_t id);
+
+/* SeaShell: 1 while bracketed paste (DECSET 2004) is on. */
+int vterm_screen_get_bracketpaste(const VTermScreen *screen);
+
 int vterm_screen_is_eol(const VTermScreen *screen, VTermPos pos);
 
 /**
diff -u a/src/screen.c b/src/screen.c
--- a/src/screen.c
+++ b/src/screen.c
@@ -32,8 +32,23 @@
   unsigned int protected_cell : 1;
   unsigned int dwl            : 1; /* on a DECDWL or DECDHL line */
   unsigned int dhl            : 2; /* on a DECDHL line (1=top 2=bottom) */
+
+  /* SeaShell: the OSC 8 link this cell belongs to, 0 = none (PATCHES.md).
+   * Only putglyph stamps it; screen->pen.uri_id stays 0. */
+  uint16_t uri_id;
 } ScreenPen;
 
+/* SeaShell: one interned OSC 8 target. `id` is the id= parameter ("" when
+ * absent); a link with the same id and uri reuses the entry. */
+typedef struct
+{
+  char *id;
+  char *uri;
+} ScreenUri;
+
+#define SCREEN_MAX_URIS 65535
+#define SCREEN_MAX_OSC8 8192
+
 /* Internal representation of a screen cell */
 typedef struct
 {
@@ -72,6 +87,20 @@
   VTermScreenCell *sb_buffer;
 
   ScreenPen pen;
+
+  /* SeaShell OSC 8 state: the link putglyph stamps, the interned targets
+   * (uris[0] is unused so id 0 means none), and the OSC being collected. */
+  uint16_t cur_uri_id;
+  ScreenUri *uris;
+  int uris_len, uris_cap;
+  char *osc8_buf;
+  size_t osc8_len;
+  int osc8_overflow;
+
+  /* The fallbacks set through vterm_screen_set_unrecognised_fallbacks; the
+   * state's fallbacks point at screen_fallbacks, which forward here. */
+  const VTermStateFallbacks *user_fallbacks;
+  void *user_fbdata;
 };
 
 static inline void clearcell(const VTermScreen *screen, ScreenCell *cell)
@@ -186,6 +215,7 @@
   }
   if(i < VTERM_MAX_CHARS_PER_CELL)
     cell->chars[i] = 0;
+  cell->pen.uri_id = screen->cur_uri_id;
 
   for(int col = 1; col < info->width; col++)
     getcell(screen, pos.row, pos.col + col)->chars[0] = (uint32_t)-1;
@@ -719,6 +749,7 @@
 
         dst->pen.fg = src->fg;
         dst->pen.bg = src->bg;
+        dst->pen.uri_id = src->uri_id;
 
         if(src->width == 2 && pos.col < (new_cols-1))
           (dst + 1)->chars[0] = (uint32_t) -1;
@@ -852,6 +883,188 @@
   return 0;
 }
 
+/* SeaShell OSC 8 (PATCHES.md) */
+
+static char *screen_strndup(VTerm *vt, const char *s, size_t n)
+{
+  char *out = vterm_allocator_malloc(vt, n + 1);
+  memcpy(out, s, n);
+  out[n] = 0;
+  return out;
+}
+
+/* The entry for (id, uri), added when new; 0 once the table is full. */
+static uint16_t intern_uri(VTermScreen *screen, const char *id, size_t idlen, const char *uri, size_t urilen)
+{
+  for(int i = 1; i < screen->uris_len; i++) {
+    ScreenUri *u = &screen->uris[i];
+    if(strlen(u->id) == idlen && strlen(u->uri) == urilen &&
+       memcmp(u->id, id, idlen) == 0 && memcmp(u->uri, uri, urilen) == 0)
+      return (uint16_t)i;
+  }
+
+  if(screen->uris_len >= SCREEN_MAX_URIS + 1)
+    return 0;
+
+  if(screen->uris_len == screen->uris_cap) {
+    int cap = screen->uris_cap ? screen->uris_cap * 2 : 16;
+    ScreenUri *grown = vterm_allocator_malloc(screen->vt, sizeof(ScreenUri) * cap);
+    if(screen->uris) {
+      memcpy(grown, screen->uris, sizeof(ScreenUri) * screen->uris_len);
+      vterm_allocator_free(screen->vt, screen->uris);
+    }
+    screen->uris = grown;
+    screen->uris_cap = cap;
+    if(screen->uris_len == 0) {
+      screen->uris[0].id = NULL;
+      screen->uris[0].uri = NULL;
+      screen->uris_len = 1;
+    }
+  }
+
+  ScreenUri *u = &screen->uris[screen->uris_len];
+  u->id = screen_strndup(screen->vt, id, idlen);
+  u->uri = screen_strndup(screen->vt, uri, urilen);
+  return (uint16_t)screen->uris_len++;
+}
+
+/* "<params>;<uri>": params are colon separated key=value pairs, of which only
+ * id= matters. An empty uri ends the link. */
+static void apply_osc8(VTermScreen *screen, const char *s, size_t len)
+{
+  const char *semi = memchr(s, ';', len);
+  if(!semi) {
+    screen->cur_uri_id = 0;
+    return;
+  }
+
+  const char *uri = semi + 1;
+  size_t urilen = len - (size_t)(uri - s);
+  if(urilen == 0) {
+    screen->cur_uri_id = 0;
+    return;
+  }
+
+  const char *id = "";
+  size_t idlen = 0;
+  const char *p = s;
+  while(p < semi) {
+    const char *end = memchr(p, ':', (size_t)(semi - p));
+    if(!end)
+      end = semi;
+    if(end - p >= 3 && memcmp(p, "id=", 3) == 0) {
+      id = p + 3;
+      idlen = (size_t)(end - p - 3);
+    }
+    p = end + 1;
+  }
+
+  screen->cur_uri_id = intern_uri(screen, id, idlen, uri, urilen);
+}
+
+static int screen_osc(int command, VTermStringFragment frag, void *user)
+{
+  VTermScreen *screen = user;
+
+  if(command == 8) {
+    if(frag.initial) {
+      screen->osc8_len = 0;
+      screen->osc8_overflow = 0;
+    }
+    if(!screen->osc8_buf)
+      screen->osc8_buf = vterm_allocator_malloc(screen->vt, SCREEN_MAX_OSC8);
+    if(screen->osc8_len + frag.len > SCREEN_MAX_OSC8)
+      screen->osc8_overflow = 1;
+    else {
+      memcpy(screen->osc8_buf + screen->osc8_len, frag.str, frag.len);
+      screen->osc8_len += frag.len;
+    }
+    if(frag.final) {
+      /* A target too long to keep ends any link rather than half-parsing one */
+      if(screen->osc8_overflow)
+        screen->cur_uri_id = 0;
+      else
+        apply_osc8(screen, screen->osc8_buf, screen->osc8_len);
+    }
+    return 1;
+  }
+
+  if(screen->user_fallbacks && screen->user_fallbacks->osc)
+    return (*screen->user_fallbacks->osc)(command, frag, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_control(unsigned char control, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->control)
+    return (*screen->user_fallbacks->control)(control, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_csi(const char *leader, const long args[], int argcount, const char *intermed, char command, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->csi)
+    return (*screen->user_fallbacks->csi)(leader, args, argcount, intermed, command, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_dcs(const char *command, size_t commandlen, VTermStringFragment frag, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->dcs)
+    return (*screen->user_fallbacks->dcs)(command, commandlen, frag, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_apc(VTermStringFragment frag, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->apc)
+    return (*screen->user_fallbacks->apc)(frag, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_pm(VTermStringFragment frag, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->pm)
+    return (*screen->user_fallbacks->pm)(frag, screen->user_fbdata);
+  return 0;
+}
+
+static int screen_fb_sos(VTermStringFragment frag, void *user)
+{
+  VTermScreen *screen = user;
+  if(screen->user_fallbacks && screen->user_fallbacks->sos)
+    return (*screen->user_fallbacks->sos)(frag, screen->user_fbdata);
+  return 0;
+}
+
+static const VTermStateFallbacks screen_fallbacks = {
+  .control = &screen_fb_control,
+  .csi     = &screen_fb_csi,
+  .osc     = &screen_osc,
+  .dcs     = &screen_fb_dcs,
+  .apc     = &screen_fb_apc,
+  .pm      = &screen_fb_pm,
+  .sos     = &screen_fb_sos,
+};
+
+const char *vterm_screen_get_uri(const VTermScreen *screen, uint16_t id)
+{
+  if(id == 0 || id >= screen->uris_len)
+    return NULL;
+  return screen->uris[id].uri;
+}
+
+/* SeaShell: whether DECSET 2004 is on, for the shell's paste path */
+int vterm_screen_get_bracketpaste(const VTermScreen *screen)
+{
+  return screen->state->mode.bracketpaste;
+}
+
 static VTermStateCallbacks state_cbs = {
   .putglyph    = &putglyph,
   .movecursor  = &movecursor,
@@ -900,8 +1113,18 @@
 
   screen->sb_buffer = vterm_allocator_malloc(screen->vt, sizeof(VTermScreenCell) * cols);
 
+  screen->cur_uri_id = 0;
+  screen->uris = NULL;
+  screen->uris_len = screen->uris_cap = 0;
+  screen->osc8_buf = NULL;
+  screen->osc8_len = 0;
+  screen->osc8_overflow = 0;
+  screen->user_fallbacks = NULL;
+  screen->user_fbdata = NULL;
+
   vterm_state_set_callbacks(screen->state, &state_cbs, screen);
   vterm_state_callbacks_has_premove(screen->state);
+  vterm_state_set_unrecognised_fallbacks(screen->state, &screen_fallbacks, screen);
 
   return screen;
 }
@@ -914,6 +1137,15 @@
 
   vterm_allocator_free(screen->vt, screen->sb_buffer);
 
+  for(int i = 1; i < screen->uris_len; i++) {
+    vterm_allocator_free(screen->vt, screen->uris[i].id);
+    vterm_allocator_free(screen->vt, screen->uris[i].uri);
+  }
+  if(screen->uris)
+    vterm_allocator_free(screen->vt, screen->uris);
+  if(screen->osc8_buf)
+    vterm_allocator_free(screen->vt, screen->osc8_buf);
+
   vterm_allocator_free(screen->vt, screen);
 }
 
@@ -921,6 +1153,7 @@
 {
   screen->damaged.start_row = -1;
   screen->pending_scrollrect.start_row = -1;
+  screen->cur_uri_id = 0;
   vterm_state_reset(screen->state, hard);
   vterm_screen_flush_damage(screen);
 }
@@ -1014,6 +1247,7 @@
 
   cell->fg = intcell->pen.fg;
   cell->bg = intcell->pen.bg;
+  cell->uri_id = intcell->pen.uri_id;
 
   if(pos.col < (screen->cols - 1) &&
      getcell(screen, pos.row, pos.col + 1)->chars[0] == (uint32_t)-1)
@@ -1086,12 +1320,14 @@
 
 void vterm_screen_set_unrecognised_fallbacks(VTermScreen *screen, const VTermStateFallbacks *fallbacks, void *user)
 {
-  vterm_state_set_unrecognised_fallbacks(screen->state, fallbacks, user);
+  /* SeaShell: the state keeps screen_fallbacks so OSC 8 is seen first */
+  screen->user_fallbacks = fallbacks;
+  screen->user_fbdata = fallbacks ? user : NULL;
 }
 
 void *vterm_screen_get_unrecognised_fbdata(VTermScreen *screen)
 {
-  return vterm_state_get_unrecognised_fbdata(screen->state);
+  return screen->user_fbdata;
 }
 
 void vterm_screen_flush_damage(VTermScreen *screen)
```

### Clusters split across writes

A pty read can end inside a cluster. Upstream asks about the first codepoint
of the next write with no previous codepoint, so a ZWJ family split after the
ZWJ took two glyphs and four cells, and the joined glyph kept the width of
its first part. `on_text` now passes the saved glyph's last codepoint as
`prev` when the cursor has not moved since, asks about the first codepoint
once (the regional-indicator toggle in `width.cpp` counts the questions), and
measures the joined glyph again with `vterm_glyph_width_hook`, moving the
cursor past it when it grew and still fits on the row.

```diff
--- a/src/state.c
+++ b/src/state.c
@@ -330,11 +330,23 @@
 
   int i = 0;
 
+  /* SeaShell: a write that starts inside a cluster (a ZWJ sequence or a flag
+   * split across two pty reads) sees the saved glyph's last codepoint as prev,
+   * and the first codepoint is asked about once. */
+  int combine_here = state->pos.row == state->combine_pos.row && state->pos.col == state->combine_pos.col + state->combine_width;
+  uint32_t prev0 = 0;
+  if(combine_here && state->combine_chars[0]) {
+    int last = 0;
+    while(state->combine_chars[last + 1])
+      last++;
+    prev0 = state->combine_chars[last];
+  }
+
   /* This is a combining char. that needs to be merged with the previous
    * glyph output */
-  if(vterm_unicode_is_combining(codepoints[i], i > 0 ? codepoints[i - 1] : 0)) {
+  if(vterm_unicode_is_combining(codepoints[i], prev0)) {
     /* See if the cursor has moved since */
-    if(state->pos.row == state->combine_pos.row && state->pos.col == state->combine_pos.col + state->combine_width) {
+    if(combine_here) {
 #ifdef DEBUG_GLYPH_COMBINE
       int printpos;
       printf("DEBUG: COMBINING SPLIT GLYPH of chars {");
@@ -349,7 +361,7 @@
         saved_i++;
 
       /* Add extra ones */
-      while(i < npoints && vterm_unicode_is_combining(codepoints[i], i > 0 ? codepoints[i - 1] : 0)) {
+      while(i < npoints && (i == 0 || vterm_unicode_is_combining(codepoints[i], codepoints[i - 1]))) {
         if(saved_i >= state->combine_chars_size)
           grow_combine_buffer(state);
         state->combine_chars[saved_i++] = codepoints[i++];
@@ -365,6 +377,23 @@
 #endif
 
       /* Now render it */
+      /* SeaShell: the joined cluster can be wider than its first part (a
+       * flag's second regional indicator, a late U+FE0F): measure it again
+       * and move the cursor past the wider glyph when it fits. */
+      if(vterm_glyph_width_hook) {
+        int w = vterm_glyph_width_hook(state->combine_chars, saved_i);
+        if(w > state->combine_width && state->combine_pos.col + w <= THISROWWIDTH(state)) {
+          state->combine_width = w;
+          if(state->combine_pos.col + w >= THISROWWIDTH(state)) {
+            state->pos.col = state->combine_pos.col;
+            if(state->mode.autowrap)
+              state->at_phantom = 1;
+          }
+          else
+            state->pos.col = state->combine_pos.col + w;
+        }
+      }
+
       putglyph(state, state->combine_chars, state->combine_width, state->combine_pos);
     }
     else {
```

### SGR 2 faint

Upstream parses SGR 2 and drops it, so faint text drew at full strength where
xterm.js draws it at half opacity (the VT parity gate's `dim` field, corpus
04-sgr). The pen, the screen pen and `VTermScreenCellAttrs` gain a `dim` bit,
`VTERM_ATTR_DIM` and `VTERM_ATTR_DIM_MASK` are appended after the upstream
values, SGR 2 sets it and SGR 22 clears it with bold (as xterm.js does), and the
reflow pop path, `vterm_screen_get_cell`, `attrs_differ`, the saved pen,
DECRQSS and `vterm_get_attr_type` carry it.

```diff
--- a/include/vterm.h
+++ b/include/vterm.h
@@ -245,6 +245,7 @@
   VTERM_ATTR_BACKGROUND, // color:  40-49 100-107
   VTERM_ATTR_SMALL,      // bool:   73, 74, 75
   VTERM_ATTR_BASELINE,   // number: 73, 74, 75
+  VTERM_ATTR_DIM,        // bool:   2, 22 (SeaShell, PATCHES.md)
 
   VTERM_N_ATTRS
 } VTermAttr;
@@ -513,6 +514,7 @@
     unsigned int dhl       : 2; /* On a DECDHL line (1=top 2=bottom) */
     unsigned int small     : 1;
     unsigned int baseline  : 2;
+    unsigned int dim       : 1; /* SGR 2 faint (SeaShell, PATCHES.md) */
 } VTermScreenCellAttrs;
 
 enum {
@@ -598,8 +600,9 @@
   VTERM_ATTR_CONCEAL_MASK    = 1 << 9,
   VTERM_ATTR_SMALL_MASK      = 1 << 10,
   VTERM_ATTR_BASELINE_MASK   = 1 << 11,
+  VTERM_ATTR_DIM_MASK        = 1 << 12,
 
-  VTERM_ALL_ATTRS_MASK = (1 << 12) - 1
+  VTERM_ALL_ATTRS_MASK = (1 << 13) - 1
 } VTermAttrMask;
 
 int vterm_screen_get_attrs_extent(const VTermScreen *screen, VTermRect *extent, VTermPos pos, VTermAttrMask attrs);
--- a/src/vterm_internal.h
+++ b/src/vterm_internal.h
@@ -50,6 +50,7 @@
   unsigned int font:4; /* To store 0-9 */
   unsigned int small:1;
   unsigned int baseline:2;
+  unsigned int dim:1;   /* SeaShell: SGR 2 faint */
 };
 
 struct VTermState
--- a/src/pen.c
+++ b/src/pen.c
@@ -179,6 +179,7 @@
   state->pen.font = 0;      setpenattr_int (state, VTERM_ATTR_FONT, 0);
   state->pen.small = 0;     setpenattr_bool(state, VTERM_ATTR_SMALL, 0);
   state->pen.baseline = 0;  setpenattr_int (state, VTERM_ATTR_BASELINE, 0);
+  state->pen.dim = 0;       setpenattr_bool(state, VTERM_ATTR_DIM, 0);
 
   state->pen.fg = state->default_fg;  setpenattr_col(state, VTERM_ATTR_FOREGROUND, state->default_fg);
   state->pen.bg = state->default_bg;  setpenattr_col(state, VTERM_ATTR_BACKGROUND, state->default_bg);
@@ -193,6 +194,7 @@
     state->pen = state->saved.pen;
 
     setpenattr_bool(state, VTERM_ATTR_BOLD,      state->pen.bold);
+    setpenattr_bool(state, VTERM_ATTR_DIM,       state->pen.dim);
     setpenattr_int (state, VTERM_ATTR_UNDERLINE, state->pen.underline);
     setpenattr_bool(state, VTERM_ATTR_ITALIC,    state->pen.italic);
     setpenattr_bool(state, VTERM_ATTR_BLINK,     state->pen.blink);
@@ -301,6 +303,11 @@
       break;
     }
 
+    case 2: // Faint on (SeaShell)
+      state->pen.dim = 1;
+      setpenattr_bool(state, VTERM_ATTR_DIM, 1);
+      break;
+
     case 3: // Italic on
       state->pen.italic = 1;
       setpenattr_bool(state, VTERM_ATTR_ITALIC, 1);
@@ -359,9 +366,11 @@
       setpenattr_int(state, VTERM_ATTR_UNDERLINE, state->pen.underline);
       break;
 
-    case 22: // Bold off
+    case 22: // Bold and faint off
       state->pen.bold = 0;
       setpenattr_bool(state, VTERM_ATTR_BOLD, 0);
+      state->pen.dim = 0;
+      setpenattr_bool(state, VTERM_ATTR_DIM, 0);
       break;
 
     case 23: // Italic and Gothic (currently unsupported) off
@@ -508,6 +517,9 @@
   if(state->pen.bold)
     args[argi++] = 1;
 
+  if(state->pen.dim)
+    args[argi++] = 2;
+
   if(state->pen.italic)
     args[argi++] = 3;
 
@@ -555,6 +567,10 @@
     val->boolean = state->pen.bold;
     return 1;
 
+  case VTERM_ATTR_DIM:
+    val->boolean = state->pen.dim;
+    return 1;
+
   case VTERM_ATTR_UNDERLINE:
     val->number = state->pen.underline;
     return 1;
--- a/src/screen.c
+++ b/src/screen.c
@@ -27,6 +27,7 @@
   unsigned int font      : 4; /* 0 to 9 */
   unsigned int small     : 1;
   unsigned int baseline  : 2;
+  unsigned int dim       : 1; /* SeaShell: SGR 2 faint */
 
   /* Extra state storage that isn't strictly pen-related */
   unsigned int protected_cell : 1;
@@ -488,6 +489,9 @@
   case VTERM_ATTR_BASELINE:
     screen->pen.baseline = val->number;
     return 1;
+  case VTERM_ATTR_DIM:
+    screen->pen.dim = val->boolean;
+    return 1;
 
   case VTERM_N_ATTRS:
     return 0;
@@ -746,6 +750,7 @@
         dst->pen.font      = src->attrs.font;
         dst->pen.small     = src->attrs.small;
         dst->pen.baseline  = src->attrs.baseline;
+        dst->pen.dim       = src->attrs.dim;
 
         dst->pen.fg = src->fg;
         dst->pen.bg = src->bg;
@@ -1241,6 +1246,7 @@
   cell->attrs.font      = intcell->pen.font;
   cell->attrs.small     = intcell->pen.small;
   cell->attrs.baseline  = intcell->pen.baseline;
+  cell->attrs.dim       = intcell->pen.dim;
 
   cell->attrs.dwl = intcell->pen.dwl;
   cell->attrs.dhl = intcell->pen.dhl;
@@ -1357,6 +1363,8 @@
 {
   if((attrs & VTERM_ATTR_BOLD_MASK)       && (a->pen.bold != b->pen.bold))
     return 1;
+  if((attrs & VTERM_ATTR_DIM_MASK)        && (a->pen.dim != b->pen.dim))
+    return 1;
   if((attrs & VTERM_ATTR_UNDERLINE_MASK)  && (a->pen.underline != b->pen.underline))
     return 1;
   if((attrs & VTERM_ATTR_ITALIC_MASK)     && (a->pen.italic != b->pen.italic))
--- a/src/vterm.c
+++ b/src/vterm.c
@@ -278,6 +278,7 @@
     case VTERM_ATTR_BACKGROUND: return VTERM_VALUETYPE_COLOR;
     case VTERM_ATTR_SMALL:      return VTERM_VALUETYPE_BOOL;
     case VTERM_ATTR_BASELINE:   return VTERM_VALUETYPE_INT;
+    case VTERM_ATTR_DIM:        return VTERM_VALUETYPE_BOOL;
 
     case VTERM_N_ATTRS: return 0;
   }
```
