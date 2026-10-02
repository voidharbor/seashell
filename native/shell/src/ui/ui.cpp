#include "ui/ui.h"
#include "app.h"
#include "window.h"
#include <algorithm>
#include <cmath>

namespace {
const UINT kAnimMs = 16;          // the attention border's 60 fps
const UINT kTipMs = 600;          // hover this long before a tooltip shows
const size_t kTabNameMax = 40;    // store.ts MAX_TAB_NAME
const size_t kFindMax = 1000;

bool startsWith(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }
bool endsWith(const std::string& s, const char* p) {
  size_t n = strlen(p);
  return s.size() >= n && s.compare(s.size() - n, n, p) == 0;
}
bool isGrid(const std::string& t) { return startsWith(t, "pane:") && endsWith(t, ":grid"); }
}  // namespace

Ui& Ui::instance() { static Ui u; return u; }

float Ui::dpi() const { return Window::instance().dpi().scale(); }
float Ui::bodyTop() const { return (float)Window::instance().bodyRect().top; }

D2D1_RECT_F Ui::dev(const Rect& r) const {
  float s = dpi(), top = bodyTop();
  return D2D1::RectF(std::round((float)r.x * s), std::round((float)r.y * s - top),
                     std::round((float)(r.x + r.w) * s), std::round((float)(r.y + r.h) * s - top));
}

const PaneModel* Ui::pane(const std::string& id) const {
  for (const PaneModel& p : m_.panes)
    if (p.id == id) return &p;
  return nullptr;
}

bool Ui::paneVisible(const PaneModel& p) const { return !m_.zoomedPaneId || *m_.zoomedPaneId == p.id; }

void Ui::hit(bool strip, D2D1_RECT_F r, const std::string& target) {
  if (!registering_) return;
  (strip ? stripHits_ : bodyHits_).push_back(Hit{ r, target });
}

void Ui::setModel(const UiModel& m) {
  UiModel old = std::move(m_);
  m_ = m;
  haveModel_ = true;
  t_ = Tokens::fromModel(m_.tokens);
  chords_.set(m_.chords);
  if (!m_.restore) restoreFocus_ = 0;
  // Attention start times, for the four-cycle 'done' glow.
  ULONGLONG now = GetTickCount64();
  std::map<std::string, ULONGLONG> done, waiting;
  for (const PaneModel& p : m_.panes) {
    if (p.attention == "done") done[p.id] = doneSince_.count(p.id) ? doneSince_[p.id] : now;
    if (p.attention == "waiting") waiting[p.id] = waitingSince_.count(p.id) ? waitingSince_[p.id] : now;
  }
  doneSince_ = std::move(done);
  waitingSince_ = std::move(waiting);
  syncEdits(old);
  layout();
  updateAnimTimer();
}

void Ui::relayout() { layout(); }

// The find query and the rename field follow the model: opened (and focused)
// when the core opens them, closed when it closes them.
void Ui::syncEdits(const UiModel& old) {
  auto sendEvent = [](const nlohmann::json& e) { App::instance().wire().sendEvent(e); };
  find_.emit = sendEvent;
  rename_.emit = sendEvent;
  std::string renameTarget;
  std::string renameName;
  for (const TabModel& t : m_.tabs)
    if (t.renaming) { renameTarget = "tab:" + t.id + ":rename"; renameName = t.name; }
  if (renameTarget.empty()) {
    if (rename_.isOpen()) rename_.close();
  } else if (rename_.target() != renameTarget) {
    if (rename_.focused()) rename_.blur();
    rename_.open(renameTarget, renameName, L"", kTabNameMax, true);   // app.tsx TabNameInput selects the name
    find_.blur();
    rename_.focus();
  }
  if (!m_.find.open) {
    if (find_.isOpen()) find_.close();
  } else if (!find_.isOpen() || !old.find.open) {
    find_.open("find:query", m_.find.query, L"Find", kFindMax, false);
    if (rename_.focused()) rename_.blur();   // blur commits the rename
    find_.focus();
  }
  (void)old;
}

EditWidget* Ui::focusedEdit() {
  if (find_.focused()) return &find_;
  if (rename_.focused()) return &rename_;
  return nullptr;
}

bool Ui::wantsBlink() const { return find_.focused() || rename_.focused(); }
bool Ui::modal() const { return haveModel_ && m_.restore.has_value() && !coreDead_; }
void Ui::setCaretPhase(bool on) { caretOn_ = on; }

void Ui::setCoreDead(bool dead, DWORD code) {
  coreDead_ = dead;
  coreCode_ = code;
  layout();
  updateAnimTimer();
}

void Ui::layout() {
  registering_ = true;
  stripHits_.clear();
  bodyHits_.clear();
  Painter none(nullptr, dpi(), (float)m_.window.uiScale);
  viewTabs(none);
  viewPanes(none);
  viewDividers(none);
  viewStatus(none);
  viewFindBar(none);
  viewOverlays(none);
  registering_ = false;
}

std::string Ui::stripTargetAt(POINT pt) const {
  for (auto it = stripHits_.rbegin(); it != stripHits_.rend(); ++it)
    if (contains(it->r, (float)pt.x, (float)pt.y)) return it->target;
  return "strip:empty";
}

std::string Ui::bodyTargetAt(POINT pt) const {
  for (auto it = bodyHits_.rbegin(); it != bodyHits_.rend(); ++it)
    if (contains(it->r, (float)pt.x, (float)pt.y)) return it->target;
  return "";
}

bool Ui::targetRect(const std::string& target, D2D1_RECT_F* out) const {
  for (auto it = stripHits_.rbegin(); it != stripHits_.rend(); ++it)
    if (it->target == target) { *out = it->r; return true; }
  float top = bodyTop();
  for (auto it = bodyHits_.rbegin(); it != bodyHits_.rend(); ++it)
    if (it->target == target) { *out = D2D1::RectF(it->r.left, it->r.top + top, it->r.right, it->r.bottom + top); return true; }
  return false;
}

LPCWSTR Ui::cursorFor(POINT bodyPx) const {
  if (!dragDivider_.empty()) {
    const DividerModel* d = nullptr;
    for (const DividerModel& dv : m_.dividers)
      if ("divider:" + dv.id == dragDivider_) d = &dv;
    return d && d->orientation == "horizontal" ? IDC_SIZENS : IDC_SIZEWE;
  }
  std::string t = bodyTargetAt(bodyPx);
  if (startsWith(t, "divider:")) {
    for (const DividerModel& d : m_.dividers)
      if ("divider:" + d.id == t) return d.orientation == "horizontal" ? IDC_SIZENS : IDC_SIZEWE;
  }
  if (isGrid(t) || t == "find:query") return IDC_IBEAM;
  return IDC_ARROW;
}

BtnState Ui::btn(const std::string& target, bool isDefault) const {
  if (pressed(target)) return BtnState::Pressed;
  if (hovered(target)) return BtnState::Hover;
  return isDefault ? BtnState::Default : BtnState::Normal;
}

void Ui::send(const char* type, const std::string& target, float xDip, float yDip, int button, Mods m) {
  App::instance().wire().sendEvent({ { "type", type }, { "target", target }, { "x", xDip }, { "y", yDip }, { "button", button },
                                     { "mods", { { "ctrl", m.ctrl }, { "alt", m.alt }, { "shift", m.shift } } } });
}

std::wstring Ui::tooltipFor(const std::string& target) const {
  if (target == "web:new" && m_.tabFull) return L"Tab is full (6 panes)";
  // FindBar.tsx's titles.
  if (target == "find:case") return L"Match case";
  if (target == "find:regex") return L"Regular expression";
  if (target == "find:prev") return L"Previous (Shift+Enter)";
  if (target == "find:next") return L"Next (Enter)";
  if (target == "find:close") return L"Close (esc)";
  if (startsWith(target, "pane:") && endsWith(target, ":title")) {
    const PaneModel* p = pane(target.substr(5, target.size() - 5 - 6));
    if (p && !p->tooltip.empty()) return fromUtf8(p->tooltip);
  }
  return L"";
}

void Ui::setHover(const std::string& target, bool strip, POINT pt) {
  pointer_ = pt;
  if (target == hover_ && strip == hoverStrip_) return;
  bool wasStrip = hoverStrip_;
  hover_ = target;
  hoverStrip_ = strip;
  bool hadTip = tipShown_;
  tipShown_ = false;
  tip_ = tooltipFor(target);
  if (tipTimer_) { KillTimer(nullptr, tipTimer_); tipTimer_ = 0; }
  if (!tip_.empty()) tipTimer_ = SetTimer(nullptr, 0, kTipMs, tipTick);
  Window& w = Window::instance();
  if (strip || wasStrip) w.invalidateStrip();
  if (!strip || !wasStrip || hadTip) w.invalidateBody();
}

void CALLBACK Ui::tipTick(HWND, UINT, UINT_PTR id, DWORD) {
  Ui& u = instance();
  KillTimer(nullptr, id);
  u.tipTimer_ = 0;
  if (u.tip_.empty()) return;
  u.tipShown_ = true;
  Window::instance().invalidateBody();
}

void Ui::mouseLeave(bool strip) {
  if (!hover_.empty() && hoverStrip_ == strip) setHover("", strip, POINT{ -1, -1 });
  if (strip && !pressed_.empty() && hoverStrip_) pressed_.clear();
}

void Ui::captionPress() {
  if (EditWidget* e = focusedEdit()) { e->blur(); Window::instance().invalidateStrip(); Window::instance().invalidateBody(); }
}

void Ui::captionDblClick() {
  if (modal()) return;
  send("dblclick", "strip:empty", 0, 0, 0, Mods{});
}

// A click the shell answers itself, or the ui:event the core acts on.
void Ui::activate(const std::string& target, Mods m, float xDip, float yDip) {
  if (target == "menu") {
    App::instance().wire().send("app:toast", { { "message", "The menu arrives in phase 2" } });
    return;
  }
  if (target == "web:new" && m_.tabFull) return;   // dimmed: the tab already holds six panes
  if (coreDead_) {
    // Nothing is listening; Restart starts a new core (spec 4.5: the user's call).
    if (startsWith(target, "pane:") && endsWith(target, ":restart")) App::instance().restartCore();
    return;
  }
  if (target == "find:bar" || target == "restore:card" || target == "toast" || target == "status" || target == "splash" ||
      startsWith(target, "tip"))
    return;
  send("click", target, xDip, yDip, 0, m);
}

void Ui::targetClick(const std::string& target, bool dbl, int button, Mods m) {
  EditWidget* e = target == find_.target() ? &find_ : target == rename_.target() ? &rename_ : nullptr;
  EditWidget* fe = focusedEdit();
  if (fe && fe != e) fe->blur();
  if (e) {
    e->focus();
    if (dbl) e->selectAll();
  } else if (dbl || button != 0) {
    send(dbl ? "dblclick" : "click", target, 0, 0, button, m);
  } else {
    activate(target, m, 0, 0);
  }
  Window::instance().invalidateStrip();
  Window::instance().invalidateBody();
}

bool Ui::mouse(UINT msg, POINT pt, int button, Mods mods) {
  Window& win = Window::instance();
  if (msg == WM_MOUSEWHEEL) {
    ScreenToClient(win.hwnd(), &pt);
    return modal();
  }
  bool inStrip = pt.y < win.stripHeightPx();
  std::string target = inStrip ? stripTargetAt(pt) : bodyTargetAt(POINT{ pt.x, pt.y - (LONG)bodyTop() });
  float xd = pt.x / dpi(), yd = pt.y / dpi();

  // A divider drag owns the pointer until the button comes up. The core takes
  // the divider's leading edge, so the grab offset inside the strip is kept.
  if (!dragDivider_.empty()) {
    const DividerModel* d = nullptr;
    for (const DividerModel& dv : m_.dividers)
      if ("divider:" + dv.id == dragDivider_) d = &dv;
    bool vertical = !d || d->orientation != "horizontal";
    float ex = vertical ? xd - dragGrabDip_ : xd, ey = vertical ? yd : yd - dragGrabDip_;
    if (msg == WM_MOUSEMOVE) { send("move", dragDivider_, ex, ey, 0, mods); return true; }
    if (msg == WM_LBUTTONUP) {
      send("up", dragDivider_, ex, ey, 0, mods);
      dragDivider_.clear();
      if (GetCapture() == win.body()) ReleaseCapture();
      return true;
    }
    return true;
  }

  if (msg == WM_MOUSEMOVE) {
    setHover(target, inStrip, pt);
    if (!pressed_.empty() && !inStrip) win.invalidateBody();
    return modal() || inStrip;
  }

  bool down = msg == WM_LBUTTONDOWN || msg == WM_LBUTTONDBLCLK || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN ||
              msg == WM_RBUTTONDBLCLK || msg == WM_MBUTTONDBLCLK;
  bool up = msg == WM_LBUTTONUP || msg == WM_RBUTTONUP || msg == WM_MBUTTONUP;

  if (modal()) {
    // The restore card takes every press; only its two buttons act.
    if (down && button == 0) pressed_ = target;
    if (up && button == 0) {
      if (pressed_ == target && (target == "restore:yes" || target == "restore:fresh")) activate(target, mods, xd, yd);
      pressed_.clear();
    }
    win.invalidateBody();
    return true;
  }

  if (down) {
    pointer_ = pt;
    EditWidget* fe = focusedEdit();
    if (fe && fe->target() != target) { fe->blur(); win.invalidateStrip(); win.invalidateBody(); }
    if (target.empty() || isGrid(target)) return false;   // GridInput's
    if (button != 0) return true;                        // the chrome has no context menu yet
    if (target == "strip:empty") return true;
    if (startsWith(target, "divider:")) {
      for (const DividerModel& d : m_.dividers) {
        if ("divider:" + d.id != target) continue;
        bool vertical = d.orientation != "horizontal";
        float edge = (float)(vertical ? d.rect.x : d.rect.y);
        dragGrabDip_ = (vertical ? xd : yd) - edge;
        dragDivider_ = target;
        SetCapture(win.body());
        send("down", target, vertical ? edge : xd, vertical ? yd : edge, 0, mods);
      }
      return true;
    }
    EditWidget* e = target == find_.target() ? &find_ : target == rename_.target() ? &rename_ : nullptr;
    if (e) {
      e->focus();
      e->pointer((float)pt.x, mods.shift);
      if (msg == WM_LBUTTONDBLCLK) e->selectAll();
      if (inStrip) win.invalidateStrip(); else win.invalidateBody();
      return true;
    }
    bool dblTarget = (startsWith(target, "tab:") && std::count(target.begin(), target.end(), ':') == 1 && target != "tab:new") ||
                     (startsWith(target, "pane:") && endsWith(target, ":title"));
    if (msg == WM_LBUTTONDBLCLK && dblTarget) {
      send("dblclick", target, xd, yd, 0, mods);
      pressed_.clear();
      return true;
    }
    pressed_ = target;
    // Tabs select and panes focus on press (app.tsx onMouseDown); the rest act on click.
    if (startsWith(target, "tab:") || startsWith(target, "pane:")) {
      if (!coreDead_ && !endsWith(target, ":close") && !endsWith(target, ":restart")) send("down", target, xd, yd, 0, mods);
    }
    if (inStrip) win.invalidateStrip(); else win.invalidateBody();
    return true;
  }
  if (up) {
    if (pressed_.empty()) return inStrip;   // a grid gesture's release stays with GridInput
    std::string was = pressed_;
    pressed_.clear();
    if (button == 0 && was == target) activate(target, mods, xd, yd);
    win.invalidateStrip();
    win.invalidateBody();
    return true;
  }
  return inStrip;
}

bool Ui::key(UINT msg, WPARAM w, LPARAM l, Mods m) {
  Window& win = Window::instance();
  if (modal()) {
    if (msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP || msg == WM_SYSCHAR) return false;   // Alt+F4 still closes
    if (msg == WM_KEYDOWN) {
      if (w == VK_TAB || w == VK_LEFT || w == VK_RIGHT) {
        restoreFocus_ = 1 - restoreFocus_;
        win.invalidateBody();
      } else if (w == VK_RETURN || w == VK_SPACE) {
        send("click", restoreFocus_ == 0 ? "restore:yes" : "restore:fresh", 0, 0, 0, m);
      } else if (w == VK_ESCAPE) {
        App::instance().wire().sendEvent({ { "type", "key" }, { "target", "restore" }, { "key", "Escape" },
                                           { "mods", { { "ctrl", m.ctrl }, { "alt", m.alt }, { "shift", m.shift } } } });
      }
    }
    return true;
  }
  if (EditWidget* e = focusedEdit()) {
    if (!e->key(msg, w, l, m, chords_)) return false;
    if (e == &rename_) win.invalidateStrip(); else win.invalidateBody();
    return true;
  }
  // The find chord with the bar open but not focused gives it the keys back.
  if (msg == WM_KEYDOWN && find_.isOpen()) {
    std::optional<std::string> cmd = chords_.command(chordFromMessage(w, l, m.ctrl, m.alt, m.shift));
    if (cmd && *cmd == "edit.find") {
      find_.focus();
      find_.selectAll();
      win.invalidateBody();
    }
  }
  return false;
}

// 0..1 for the attention border now; *on is false once it should not draw.
float Ui::attentionLevel(const PaneModel& p, ULONGLONG now, bool* on) const {
  *on = false;
  if (m_.sleep || coreDead_) return 0;
  const double kPi = 3.14159265358979;
  if (p.attention == "waiting") {
    auto it = waitingSince_.find(p.id);
    double t = (double)(now - (it == waitingSince_.end() ? now : it->second)) / 2800.0;
    *on = true;
    return (float)(0.5 - 0.5 * std::cos(2 * kPi * t));
  }
  if (p.attention == "done") {
    auto it = doneSince_.find(p.id);
    double t = (double)(now - (it == doneSince_.end() ? now : it->second)) / 1800.0;
    if (t >= 4) return 0;   // four cycles, then still
    *on = true;
    return (float)(0.5 - 0.5 * std::cos(2 * kPi * t));
  }
  return 0;
}

void Ui::updateAnimTimer() {
  BOOL anim = TRUE;
  SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &anim, 0);
  ULONGLONG now = GetTickCount64();
  bool want = false;
  if (anim) {
    for (const PaneModel& p : m_.panes) {
      bool on = false;
      if (paneVisible(p)) attentionLevel(p, now, &on);
      want = want || on;
    }
  }
  if (want && !animTimer_) animTimer_ = SetTimer(nullptr, 0, kAnimMs, animTick);
  if (!want && animTimer_) { KillTimer(nullptr, animTimer_); animTimer_ = 0; }
}

void CALLBACK Ui::animTick(HWND, UINT, UINT_PTR, DWORD) {
  Ui& u = instance();
  HWND h = Window::instance().hwnd();
  if (h && !IsIconic(h)) Window::instance().invalidateBody();
  u.updateAnimTimer();   // the 'done' glow stops after four cycles
}

void Ui::drawBackground(ID2D1RenderTarget* rt) {
  if (!rt) return;
  rt->Clear(D2D1::ColorF(((t_.body >> 16) & 0xFF) / 255.f, ((t_.body >> 8) & 0xFF) / 255.f, (t_.body & 0xFF) / 255.f, 1.f));
}

void Ui::drawStrip(ID2D1RenderTarget* rt) {
  Painter p(rt, dpi(), (float)m_.window.uiScale);
  if (!p.live()) return;
  // Gray-scale text: ClearType needs an opaque background, the glass is not.
  rt->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
  RECT rc{};
  GetClientRect(Window::instance().hwnd(), &rc);
  auto comp = m_.tokens.find("composition");
  if (comp != m_.tokens.end() && comp->second == "0")
    p.fillRect(D2D1::RectF(0, 0, (float)rc.right, (float)Window::instance().stripHeightPx()), t_.frame);   // no glass: the opaque frame
  viewTabs(p);
}

void Ui::drawBody(ID2D1RenderTarget* rt) {
  Painter p(rt, dpi(), (float)m_.window.uiScale);
  if (!p.live()) return;
  viewPanes(p);
  viewDividers(p);
  viewStatus(p);
  viewFindBar(p);
  viewOverlays(p);
}
