#include "audio.h"
#include "app.h"
#include <windows.h>
#include <mmreg.h>
#include <xaudio2.h>
#include <atomic>
#include <cmath>
#include <vector>

namespace {
// Copied from src/renderer/panes/ping.ts:56-91 (its Web Audio graph), which
// the core cannot import: two sine tones a major sixth apart, 880 Hz then
// 587.33 Hz, the second starting 90 ms after the first. Each one's gain is set
// to 0.0001 at its start, ramps exponentially to 0.06 by 12 ms, back to 0.0001
// by 110 ms, and the oscillator stops at 130 ms.
const double kFreqHz[2] = { 880.0, 587.33 };
const double kToneStepS = 0.09;
const double kFloor = 0.0001;
const double kPeak = 0.06;
const double kAttackEndS = 0.012;
const double kDecayEndS = 0.11;
const double kStopS = 0.13;
const UINT32 kRate = 48000;
// ping.ts PING_MIN_GAP_MS. The core already keeps pings 1.8 s apart; this is
// a backstop so no sequence of commands can ever ring it back to back.
const ULONGLONG kMinGapMs = 1800;
const double kPi = 3.14159265358979323846;

IXAudio2* g_engine = nullptr;
IXAudio2MasteringVoice* g_master = nullptr;
IXAudio2SourceVoice* g_source = nullptr;
std::vector<float> g_samples;
bool g_ready = false;
bool g_failed = false;
bool g_muted = false;        // test mode: both voices at volume 0
ULONGLONG g_lastPingAt = 0;
bool g_pinged = false;

// XAudio2 reports a lost device (the default output changed, a headset
// unplugged) on its own thread; the engine is dead from then on. The flag
// carries it to the UI thread, where the next ping tears down and starts over.
std::atomic<bool> g_lost{ false };
std::atomic<long> g_lostHr{ 0 };
struct EngineCallback : IXAudio2EngineCallback {
  void STDMETHODCALLTYPE OnProcessingPassStart() override {}
  void STDMETHODCALLTYPE OnProcessingPassEnd() override {}
  void STDMETHODCALLTYPE OnCriticalError(HRESULT hr) override {
    g_lostHr = (long)hr;
    g_lost = true;
  }
};
EngineCallback g_callback;

// The gain t seconds after a tone starts: Web Audio's exponential ramps,
// v0 * (v1 / v0) ^ ((t - t0) / (t1 - t0)), then the floor until the stop.
double gainAt(double t) {
  if (t < 0 || t >= kStopS) return 0;
  if (t < kAttackEndS) return kFloor * std::pow(kPeak / kFloor, t / kAttackEndS);
  if (t < kDecayEndS) return kPeak * std::pow(kFloor / kPeak, (t - kAttackEndS) / (kDecayEndS - kAttackEndS));
  return kFloor;
}

void render() {
  size_t total = (size_t)std::ceil((kToneStepS + kStopS) * kRate);
  g_samples.assign(total, 0.f);
  for (int i = 0; i < 2; i++) {
    size_t first = (size_t)std::llround(i * kToneStepS * kRate);
    size_t count = (size_t)std::llround(kStopS * kRate);
    for (size_t k = 0; k < count && first + k < total; k++) {
      double t = (double)k / kRate;
      g_samples[first + k] += (float)(gainAt(t) * std::sin(2 * kPi * kFreqHz[i] * t));
    }
  }
}

void teardown() {
  if (g_source) { g_source->DestroyVoice(); g_source = nullptr; }
  if (g_master) { g_master->DestroyVoice(); g_master = nullptr; }
  if (g_engine) {
    g_engine->UnregisterForCallbacks(&g_callback);
    g_engine->Release();
    g_engine = nullptr;
  }
  g_ready = false;
}

bool fail(const char* what, HRESULT hr) {
  App::log("audio: %s failed 0x%08lx; the ping stays silent", what, (unsigned long)hr);
  g_failed = true;
  teardown();
  return false;
}

// Test mode only: both volumes read back as exactly 0, or nothing is submitted.
bool stillMuted() {
  float master = 1.f, source = 1.f;
  if (!g_master || !g_source) return false;
  g_master->GetVolume(&master);
  g_source->GetVolume(&source);
  return master == 0.f && source == 0.f;
}
}  // namespace

bool Audio::init() {
  if (g_ready) return true;
  if (g_failed) return false;
  g_muted = App::instance().testMode();
  HRESULT hr = XAudio2Create(&g_engine, 0, XAUDIO2_DEFAULT_PROCESSOR);
  if (FAILED(hr)) return fail("XAudio2Create", hr);
  hr = g_engine->RegisterForCallbacks(&g_callback);
  if (FAILED(hr)) App::log("audio: RegisterForCallbacks failed 0x%08lx; a lost device will not restart the engine", (unsigned long)hr);
  hr = g_engine->CreateMasteringVoice(&g_master);
  if (FAILED(hr)) return fail("CreateMasteringVoice", hr);
  if (g_muted) {
    // Before the source voice exists, so no buffer can ever reach the device
    // through a mastering voice above 0.
    hr = g_master->SetVolume(0.0f);
    if (FAILED(hr)) return fail("muting the mastering voice", hr);
    float v = 1.f;
    g_master->GetVolume(&v);
    if (v != 0.f) return fail("muting the mastering voice", E_FAIL);
    App::log("audio: muted (test mode)");
  }
  WAVEFORMATEX wf{};
  wf.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  wf.nChannels = 1;
  wf.nSamplesPerSec = kRate;
  wf.wBitsPerSample = 32;
  wf.nBlockAlign = (WORD)(wf.nChannels * wf.wBitsPerSample / 8);
  wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;
  wf.cbSize = 0;
  hr = g_engine->CreateSourceVoice(&g_source, &wf);
  if (FAILED(hr)) return fail("CreateSourceVoice", hr);
  if (g_muted) {
    hr = g_source->SetVolume(0.0f);
    if (FAILED(hr)) return fail("muting the source voice", hr);
  }
  render();
  g_ready = true;
  return true;
}

void Audio::ping() {
  ULONGLONG now = GetTickCount64();
  if (g_pinged && now - g_lastPingAt < kMinGapMs) {
    App::log("audio: ping skipped, %llu ms after the last", (unsigned long long)(now - g_lastPingAt));
    return;
  }
  if (g_lost.exchange(false)) {
    App::log("audio: the device was lost (0x%08lx); starting the engine again", (unsigned long)g_lostHr.load());
    teardown();
  }
  if (!init()) return;
  if (g_muted && !stillMuted()) {
    fail("checking the test-mode mute", E_FAIL);
    return;
  }
  // One ping at a time: anything still queued from the last one goes first.
  g_source->Stop(0);
  g_source->FlushSourceBuffers();
  XAUDIO2_BUFFER buf{};
  buf.Flags = XAUDIO2_END_OF_STREAM;
  buf.AudioBytes = (UINT32)(g_samples.size() * sizeof(float));
  buf.pAudioData = reinterpret_cast<const BYTE*>(g_samples.data());
  HRESULT hr = g_source->SubmitSourceBuffer(&buf);
  if (FAILED(hr)) { fail("SubmitSourceBuffer", hr); return; }
  hr = g_source->Start(0);
  if (FAILED(hr)) { fail("Start", hr); return; }
  g_pinged = true;
  g_lastPingAt = now;
  App::log("audio: ping");
}

void Audio::shutdown() { teardown(); }
