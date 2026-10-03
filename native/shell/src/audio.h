// The attention ping (src/renderer/panes/ping.ts): two short sine tones played
// through XAudio2 (an engine, a mastering voice, one source voice), rendered
// once into a 48 kHz mono float buffer. The core decides when (shell:cmd
// { op: 'ping' }, rate limited there); the engine starts on the first ping, so
// a window that never pings never loads it. In test mode (SEASHELL_TEST_PORT)
// the mastering voice is set to volume 0 before the source voice exists, the
// source voice is at 0 too, and both are checked before every submit: a gate's
// ping goes through the whole path and makes no sound. Any failure logs once
// and leaves the ping silent for the rest of the run; a lost device (XAudio2's
// critical error) is not a failure, and the next ping starts the engine again.
// UI thread only.
#pragma once

class Audio {
public:
  static bool init();       // idempotent; false once anything failed
  static void ping();       // submits the buffer and logs "audio: ping"
  static void shutdown();   // the voices and the engine go (App::main's exit)
};
