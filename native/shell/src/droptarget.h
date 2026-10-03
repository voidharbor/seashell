// File and text drops onto the terminal grids (inventory row J; Phase 2
// Task 17). The body window's IDropTarget: over a terminal pane's grid or the
// open drawer's grid, with CF_HDROP, CF_UNICODETEXT or UniformResourceLocatorW
// on offer, it answers DROPEFFECT_COPY; anywhere else (a restored preview's
// placeholder, the explorer, a sheet, the strip) DROPEFFECT_NONE. The target
// is the chrome's own hit test of the model's rects (Ui::bodyTargetAt), so the
// shell computes no layout. A drop sends
//   ui:event { type: 'drop', target: 'pane:<id>:grid' | 'drawer:grid',
//              paths: [Windows paths from CF_HDROP], text: string | null }
// and the core quotes, maps and pastes it (panes/drop.ts dropText). UI thread
// only; OleInitialize must have run on it.
#pragma once
#include <windows.h>
#include <ole2.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

class DropTarget : public IDropTarget {
public:
  // RegisterDragDrop on the body; logs `drop: registered` or the failure's HRESULT.
  static bool registerOn(HWND body);
  static void revoke();                  // RevokeDragDrop, before the body goes
  // The grid target a drop at this screen point lands on, "" when refused.
  // `hit` (optional) gets the chrome target under the point either way.
  static std::string targetAt(POINTL screen, std::string* hit = nullptr);
  // The driver's `drop`: a data object holding `paths` as CF_HDROP and `text`
  // as CF_UNICODETEXT, taken through this target's DragEnter, DragOver and
  // Drop (or DragLeave when refused) at the screen point. No input, no
  // DoDragDrop loop. {ok, target, hit, effect: 'copy' | 'none', dropped}.
  static nlohmann::json driverDrop(POINTL screen, const std::vector<std::string>& paths, const std::string* text);

  // IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override;
  ULONG STDMETHODCALLTYPE AddRef() override;
  ULONG STDMETHODCALLTYPE Release() override;
  // IDropTarget
  HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* data, DWORD keys, POINTL pt, DWORD* effect) override;
  HRESULT STDMETHODCALLTYPE DragOver(DWORD keys, POINTL pt, DWORD* effect) override;
  HRESULT STDMETHODCALLTYPE DragLeave() override;
  HRESULT STDMETHODCALLTYPE Drop(IDataObject* data, DWORD keys, POINTL pt, DWORD* effect) override;

private:
  DropTarget() = default;
  virtual ~DropTarget() = default;
  DWORD answer(POINTL pt, DWORD allowed) const;
  struct Payload { std::vector<std::string> paths; std::string text; bool hasText = false; };
  static bool offers(IDataObject* data);  // CF_HDROP, CF_UNICODETEXT or UniformResourceLocatorW
  static Payload read(IDataObject* data);

  LONG refs_ = 1;
  bool droppable_ = false;                 // the data in the drag has a format this takes
};
