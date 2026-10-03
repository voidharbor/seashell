#include "droptarget.h"
#include "app.h"
#include "paths.h"
#include "ui/ui.h"
#include "window.h"
#include <shellapi.h>
#include <shlobj.h>
#include <wrl/client.h>
#include <cstring>

using nlohmann::json;
using Microsoft::WRL::ComPtr;

namespace {
const size_t kMaxPaths = 4096;            // files in one drop
const size_t kMaxTextUnits = 1u << 20;    // UTF-16 units of dropped text (1 Mi)

DropTarget* g_target = nullptr;           // the registered instance (one reference held here)
HWND g_body = nullptr;

bool startsWith(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }
bool endsWith(const std::string& s, const char* p) {
  size_t n = strlen(p);
  return s.size() >= n && s.compare(s.size() - n, n, p) == 0;
}

CLIPFORMAT urlFormat() {
  static CLIPFORMAT f = (CLIPFORMAT)RegisterClipboardFormatW(L"UniformResourceLocatorW");
  return f;
}

FORMATETC fmt(CLIPFORMAT cf) { return FORMATETC{ cf, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL }; }

// A NUL-terminated UTF-16 string in an HGLOBAL, bounded by its size.
bool globalText(IDataObject* data, CLIPFORMAT cf, std::wstring* out) {
  FORMATETC fe = fmt(cf);
  STGMEDIUM sm{};
  if (FAILED(data->GetData(&fe, &sm))) return false;
  bool ok = false;
  if (sm.tymed == TYMED_HGLOBAL && sm.hGlobal) {
    size_t units = GlobalSize(sm.hGlobal) / sizeof(wchar_t);
    if (const auto* p = static_cast<const wchar_t*>(GlobalLock(sm.hGlobal))) {
      size_t n = 0;
      while (n < units && p[n]) n++;
      if (n <= kMaxTextUnits) {
        out->assign(p, n);
        ok = true;
      } else {
        App::log("drop: text of %zu units refused (over %zu)", n, kMaxTextUnits);
      }
      GlobalUnlock(sm.hGlobal);
    }
  }
  ReleaseStgMedium(&sm);
  return ok;
}

// A data object for the driver: CF_HDROP from the paths, CF_UNICODETEXT from the text.
ComPtr<IDataObject> makeData(const std::vector<std::string>& paths, const std::string* text) {
  ComPtr<IDataObject> obj;
  if (FAILED(SHCreateDataObject(nullptr, 0, nullptr, nullptr, IID_PPV_ARGS(obj.GetAddressOf())))) return nullptr;
  if (!paths.empty()) {
    std::wstring list;
    for (const std::string& p : paths) {
      list += fromUtf8(p);
      list.push_back(L'\0');
    }
    list.push_back(L'\0');
    size_t bytes = sizeof(DROPFILES) + list.size() * sizeof(wchar_t);
    HGLOBAL g = GlobalAlloc(GHND, bytes);
    if (!g) return nullptr;
    auto* df = static_cast<DROPFILES*>(GlobalLock(g));
    df->pFiles = sizeof(DROPFILES);
    df->fWide = TRUE;
    memcpy(reinterpret_cast<char*>(df) + sizeof(DROPFILES), list.data(), list.size() * sizeof(wchar_t));
    GlobalUnlock(g);
    FORMATETC fe = fmt(CF_HDROP);
    STGMEDIUM sm{};
    sm.tymed = TYMED_HGLOBAL;
    sm.hGlobal = g;
    if (FAILED(obj->SetData(&fe, &sm, TRUE))) { GlobalFree(g); return nullptr; }
  }
  if (text) {
    std::wstring w = fromUtf8(*text);
    HGLOBAL g = GlobalAlloc(GHND, (w.size() + 1) * sizeof(wchar_t));
    if (!g) return nullptr;
    memcpy(GlobalLock(g), w.c_str(), (w.size() + 1) * sizeof(wchar_t));
    GlobalUnlock(g);
    FORMATETC fe = fmt(CF_UNICODETEXT);
    STGMEDIUM sm{};
    sm.tymed = TYMED_HGLOBAL;
    sm.hGlobal = g;
    if (FAILED(obj->SetData(&fe, &sm, TRUE))) { GlobalFree(g); return nullptr; }
  }
  return obj;
}
}  // namespace

bool DropTarget::registerOn(HWND body) {
  if (g_target || !body) return false;
  auto* t = new DropTarget();
  HRESULT hr = RegisterDragDrop(body, t);
  if (FAILED(hr)) {
    App::log("error: drop: RegisterDragDrop 0x%08lx", (unsigned long)hr);
    t->Release();
    return false;
  }
  g_target = t;
  g_body = body;
  App::log("drop: registered (RegisterDragDrop 0x%08lx)", (unsigned long)hr);
  return true;
}

void DropTarget::revoke() {
  if (!g_target) return;
  HRESULT hr = RevokeDragDrop(g_body);
  if (FAILED(hr)) App::log("error: drop: RevokeDragDrop 0x%08lx", (unsigned long)hr);
  g_target->Release();
  g_target = nullptr;
  g_body = nullptr;
}

std::string DropTarget::targetAt(POINTL screen, std::string* hit) {
  if (hit) hit->clear();
  HWND body = g_body ? g_body : Window::instance().body();
  if (!body) return {};
  POINT p{ screen.x, screen.y };
  ScreenToClient(body, &p);
  Ui& ui = Ui::instance();
  std::string t = ui.bodyTargetAt(p);
  if (hit) *hit = t;
  App& a = App::instance();
  if (a.coreDead() || ui.modal()) return {};
  if (t == "drawer:grid") return a.model().drawer.open ? t : std::string();
  if (!startsWith(t, "pane:") || !endsWith(t, ":grid")) return {};
  // Only a terminal pane registers :grid; the model says so too.
  std::string id = t.substr(5, t.size() - 5 - 5);
  for (const PaneModel& pm : a.model().panes)
    if (pm.id == id) return pm.kind == "term" && a.grid(id) ? t : std::string();
  return {};
}

bool DropTarget::offers(IDataObject* data) {
  if (!data) return false;
  for (CLIPFORMAT cf : { (CLIPFORMAT)CF_HDROP, (CLIPFORMAT)CF_UNICODETEXT, urlFormat() }) {
    FORMATETC fe = fmt(cf);
    if (cf && data->QueryGetData(&fe) == S_OK) return true;
  }
  return false;
}

DropTarget::Payload DropTarget::read(IDataObject* data) {
  Payload out;
  FORMATETC fe = fmt(CF_HDROP);
  STGMEDIUM sm{};
  if (SUCCEEDED(data->GetData(&fe, &sm))) {
    if (sm.tymed == TYMED_HGLOBAL && sm.hGlobal) {
      HDROP h = static_cast<HDROP>(sm.hGlobal);
      UINT n = DragQueryFileW(h, 0xFFFFFFFF, nullptr, 0);
      if (n > kMaxPaths) App::log("drop: %u files, the first %zu taken", n, kMaxPaths);
      for (UINT i = 0; i < n && out.paths.size() < kMaxPaths; i++) {
        UINT len = DragQueryFileW(h, i, nullptr, 0);
        if (!len) continue;
        std::wstring w(len + 1, L'\0');
        UINT got = DragQueryFileW(h, i, &w[0], len + 1);
        w.resize(got);
        if (!w.empty()) out.paths.push_back(toUtf8(w));
      }
    }
    ReleaseStgMedium(&sm);
  }
  std::wstring w;
  if (globalText(data, CF_UNICODETEXT, &w) || globalText(data, urlFormat(), &w)) {
    out.text = toUtf8(w);
    out.hasText = !out.text.empty();
  }
  return out;
}

DWORD DropTarget::answer(POINTL pt, DWORD allowed) const {
  if (!droppable_ || !(allowed & DROPEFFECT_COPY)) return DROPEFFECT_NONE;
  return targetAt(pt).empty() ? DROPEFFECT_NONE : DROPEFFECT_COPY;
}

HRESULT DropTarget::QueryInterface(REFIID riid, void** out) {
  if (!out) return E_POINTER;
  if (riid == IID_IUnknown || riid == IID_IDropTarget) {
    *out = static_cast<IDropTarget*>(this);
    AddRef();
    return S_OK;
  }
  *out = nullptr;
  return E_NOINTERFACE;
}

ULONG DropTarget::AddRef() { return (ULONG)InterlockedIncrement(&refs_); }

ULONG DropTarget::Release() {
  LONG n = InterlockedDecrement(&refs_);
  if (n == 0) delete this;
  return (ULONG)n;
}

HRESULT DropTarget::DragEnter(IDataObject* data, DWORD, POINTL pt, DWORD* effect) {
  if (!effect) return E_INVALIDARG;
  droppable_ = offers(data);
  *effect = answer(pt, *effect);
  return S_OK;
}

HRESULT DropTarget::DragOver(DWORD, POINTL pt, DWORD* effect) {
  if (!effect) return E_INVALIDARG;
  *effect = answer(pt, *effect);
  return S_OK;
}

HRESULT DropTarget::DragLeave() {
  droppable_ = false;
  return S_OK;
}

HRESULT DropTarget::Drop(IDataObject* data, DWORD, POINTL pt, DWORD* effect) {
  if (!effect) return E_INVALIDARG;
  droppable_ = offers(data);
  std::string target = droppable_ && (*effect & DROPEFFECT_COPY) ? targetAt(pt) : std::string();
  droppable_ = false;
  if (target.empty()) {
    *effect = DROPEFFECT_NONE;
    return S_OK;
  }
  Payload p = read(data);
  if (p.paths.empty() && !p.hasText) {
    *effect = DROPEFFECT_NONE;
    return S_OK;
  }
  App::log("drop: %s, %zu paths, %zu bytes of text", target.c_str(), p.paths.size(), p.text.size());
  App::instance().wire().sendEvent(
      { { "type", "drop" }, { "target", target }, { "paths", p.paths }, { "text", p.hasText ? json(p.text) : json(nullptr) } });
  *effect = DROPEFFECT_COPY;
  return S_OK;
}

json DropTarget::driverDrop(POINTL screen, const std::vector<std::string>& paths, const std::string* text) {
  if (!g_target) return { { "ok", false }, { "code", "ENOTREGISTERED" } };
  ComPtr<IDataObject> data = makeData(paths, text);
  if (!data) return { { "ok", false }, { "code", "EDATAOBJECT" } };
  std::string hit;
  std::string target = targetAt(screen, &hit);
  // What Explorer offers.
  DWORD allowed = DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK;
  DWORD eff = allowed;
  g_target->DragEnter(data.Get(), MK_LBUTTON, screen, &eff);
  eff = allowed;
  g_target->DragOver(MK_LBUTTON, screen, &eff);
  bool dropped = false;
  if (eff & DROPEFFECT_COPY) {
    eff = allowed;
    g_target->Drop(data.Get(), 0, screen, &eff);
    dropped = (eff & DROPEFFECT_COPY) != 0;
  } else {
    g_target->DragLeave();
  }
  return { { "ok", true }, { "target", target }, { "hit", hit }, { "effect", dropped ? "copy" : "none" }, { "dropped", dropped } };
}
