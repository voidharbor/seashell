// The envelope wire to the core (spec 4.2): one JSON object per line,
// { k: 'invoke' | 'send' | 'on' | 'reply', ch, id?, p }. Everything here runs on
// the UI thread; write is CoreProc::send.
#pragma once
#include "model.h"
#include <nlohmann/json.hpp>
#include <functional>
#include <map>
#include <string>

std::string base64Decode(const std::string& in);   // skips anything outside the alphabet

class Wire {
public:
  void onCoreLine(std::string line);                        // UI thread
  void sendEvent(const nlohmann::json& p);                  // {k:'send', ch:'ui:event', p}
  void sendCommand(const std::string& cmd, nlohmann::json extra = {});   // {k:'send', ch:'ui:command', p:{command, ...extra}}
  void sendTerm(const nlohmann::json& p);                   // ch 'term:event'
  void sendGeometry();                                      // ch 'shell:geometry': the client rect, dpi, and the cell of the model's window.fontPx
  void ptyWrite(const std::string& paneId, const std::string& utf8);   // {k:'send', ch:'pty:write', p:{paneId, data}}
  void ptyResize(const std::string& paneId, int cols, int rows);
  void reply(int id, const std::string& ch, const nlohmann::json& p);
  // The shell's own invokes (only test:* in Phase 1); cb gets the reply's p.
  void invoke(const std::string& ch, const nlohmann::json& p, std::function<void(const nlohmann::json&)> cb);
  void send(const std::string& ch, const nlohmann::json& p);   // any {k:'send'} envelope
  std::function<void(UiModel&&)> onModel;                   // takes the model; Ui::setModel moves it in
  std::function<void(const std::string& paneId, const std::string& bytes)> onPtyData;   // decoded from base64
  std::function<void(const nlohmann::json& cmd)> onGridCmd;
  std::function<void(const nlohmann::json& cmd)> onShellCmd;   // ch 'shell:cmd': { op: 'ping' } (App::onShellCmd)
  std::function<void(const nlohmann::json& cmd)> onViewCmd;    // ch 'view:cmd': { op: 'post', message } for the changes preview (PreviewHost)
  std::function<void(const std::string& line)> write;       // CoreProc::send
  void reset();                                             // a new core: forget the pending invokes
  const nlohmann::json& lastModelJson() const { return lastModel_; }   // the last ui:model p as sent (the driver's model)
  void clearModel() { lastModel_ = nullptr; }               // a new core run: its first ui:model replaces it
  long long parseTicks = 0, buildTicks = 0;                 // the last ui:model's JSON parse and UiModel::parse, QPC ticks (the driver's modelMs)

private:
  void writeEnvelope(const nlohmann::json& e);
  void keepRows(nlohmann::json& prev);                      // lastModel_ without rows takes prev's (same rowsSeq)
  std::map<int, std::function<void(const nlohmann::json&)>> pending_;
  int nextId_ = 1;
  nlohmann::json lastModel_;
};
