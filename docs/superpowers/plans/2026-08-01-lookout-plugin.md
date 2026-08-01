# Lookout (c-assistant plugin side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Lookout brain lane in the public c-assistant plugin: a Stop hook that notices a finished turn ending in a question, triages and drafts a one-line reply with a headless claude call, and pushes an enriched card to SeaShell's control socket — plus the session registry the whole feature depends on.

**Architecture:** Plugin hooks (`hooks/hooks.json`) register SessionStart → `register-session.py` (the registry writer, new home) and Stop → `needs-input-hook.py` (a no-LLM prefilter that exits sub-second on almost every event). Survivors spawn a detached `triage-and-push.py`, which runs `claude -p --model haiku` with `triage-prompt.md`, parses strict JSON, and calls `push-card.py` (socket v2 client with an honest `--dry-run` via `validateOnly`). State (locks, cooldowns) lives in `~/.claude/lookout/`, never inside the plugin directory.

**Tech Stack:** Python 3 stdlib only (no pip installs), `unittest`, JSON hooks config, Unix domain socket client.

**Spec:** `~/Desktop/seashell/docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md`. Companion plan: `2026-08-01-lookout-seashell.md` (socket v2 `card` command must exist for the joint E2E, but every task here is testable without it).

## Global Constraints

- Working directory: `~/.claude/plugins/marketplaces/voidharbor` (the git clone of `github.com/voidharbor/claude-plugins`). **`git pull --rebase` before the final push** — other automation pushes to this repo. Repo-local git identity is already `voidharbor`; verify with `git config user.name` before the first commit and stop if it prints anything else.
- Commit messages: one line, no attribution, no trailers.
- **Public repo scrub rule:** no business names, no real transcript content, no personal paths beyond `~/.claude/...` conventions in any file, fixture, or prompt.
- Python: stdlib only; every script starts `#!/usr/bin/env python3` and is invoked as `python3 "<path>"` (no exec-bit reliance). Scripts must never print to stdout on the hook path (SessionStart/Stop stdout is injected into sessions) — diagnostics go nowhere; silence is the failure mode.
- Brain lane platforms: macOS and Linux. On any other platform the Stop hook exits first thing.
- Tests: `python3 -m unittest discover -s c-assistant/tests -v` clean before every commit.
- Do not modify Josh's `~/.claude/settings.json` or `~/.claude/bin/*` — those are the dev shadows; the plugin is the user-facing source of truth. (His settings register SessionStart only, so the plugin's Stop hook adds no duplicate triage; the double SessionStart registry write is idempotent and harmless.)
- Never edit anything under `~/.claude/plugins/cache/` — that is the installed copy; it refreshes via `/plugin update c-assistant` after the push.

---

### Task 1: Fix the stale docstring in `session-scan.py`

**Files:**
- Modify: `c-assistant/scripts/session-scan.py` (docstring only, ~line 5)

**Interfaces:** none — text-only change.

- [ ] **Step 1:** Replace the usage line

```
  python3 ~/.claude/bin/session-scan.py [--hours 12] [--self <session-id>] [--full <session-id>]
```

with

```
  python3 "<plugin>/scripts/session-scan.py" [--hours 12] [--self <session-id>] [--full <session-id>]
  (installed under ~/.claude/plugins/; the /c-assistant command locates it for you)
```

- [ ] **Step 2:** `python3 -c "import ast; ast.parse(open('c-assistant/scripts/session-scan.py').read())"` → no output (still valid Python).
- [ ] **Step 3: Commit** — `git add -A && git commit -m "Fix stale session-scan.py usage docstring"`

---

### Task 2: Plugin hooks + the registry writer's new home

**Files:**
- Create: `c-assistant/hooks/hooks.json`
- Create: `c-assistant/scripts/register-session.py`
- Create: `c-assistant/tests/__init__.py` (empty)
- Test: `c-assistant/tests/test_hooks_config.py`

**Interfaces:**
- Produces: the hook wiring every later task assumes, and the registry files (`~/.claude/session-registry/<session-id>.json` with keys `session_id, pid, tty, app, pane_id, cwd, transcript_path, source, registered_at`) that `needs-input-hook.py` and `push-card.py` read.

`hooks.json`, exactly:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/register-session.py\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/needs-input-hook.py\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

`register-session.py`: copy the proven implementation from `~/.claude/bin/register-session.py` **verbatim except** the docstring, which becomes plugin-phrased ("Ships with the c-assistant plugin; a personal copy may also run — the write is idempotent"). It reads hook JSON on stdin, walks up to the claude ancestor pid, records tty/app/`SEASHELL_PANE_ID`, and atomically writes `~/.claude/session-registry/<sid>.json`. Prints nothing, never raises.

- [ ] **Step 1: Write the failing test** — `c-assistant/tests/test_hooks_config.py`:

```python
import json, os, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")

class HooksConfig(unittest.TestCase):
    def test_hooks_json_shape(self):
        with open(os.path.join(ROOT, "hooks", "hooks.json")) as f:
            cfg = json.load(f)
        hooks = cfg["hooks"]
        for event, script in [("SessionStart", "register-session.py"), ("Stop", "needs-input-hook.py")]:
            entries = hooks[event]
            self.assertEqual(len(entries), 1)
            cmd = entries[0]["hooks"][0]["command"]
            self.assertIn("${CLAUDE_PLUGIN_ROOT}", cmd)
            self.assertIn(script, cmd)
            self.assertTrue(cmd.startswith('python3 "'))

    def test_register_session_parses(self):
        import ast
        with open(os.path.join(ROOT, "scripts", "register-session.py")) as f:
            ast.parse(f.read())

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails** — `python3 -m unittest discover -s c-assistant/tests -v` → FAIL (missing files).
- [ ] **Step 3: Create both files** as specified. (`needs-input-hook.py` does not exist yet — the shape test only reads `hooks.json`, which may reference it before Task 3 creates it; nothing executes it until the final push, which happens after every task lands.)
- [ ] **Step 4: Run** — tests PASS.
- [ ] **Step 5: Commit** — `git commit -am "Ship session registry hook in the c-assistant plugin"`

---

### Task 3: The Stop-hook prefilter

**Files:**
- Create: `c-assistant/scripts/needs-input-hook.py`
- Test: `c-assistant/tests/test_prefilter.py`

**Interfaces:**
- Consumes: registry files (Task 2), transcript `.jsonl` files, `~/.claude/lookout/` state dir.
- Produces (exact signatures later tasks and tests use):

```python
STATE_DIR = os.path.expanduser("~/.claude/lookout")
COOLDOWN_S = 180
TAIL_BYTES = 65536
LOCK_STALE_S = 120

def last_assistant_text(transcript_path: str) -> str
    # Read the final TAIL_BYTES, split lines, parse JSON lines from the end,
    # return the text of the last assistant message ("" when none): entries with
    # obj.get("type") == "assistant"; text = "".join(block.get("text","") for
    # block in obj["message"]["content"] if block.get("type") == "text").

def should_triage(payload: dict, env: dict, sysname: str,
                  registry_dir: str, state_dir: str) -> tuple[bool, str]
    # Ordered, first refusal wins; reasons are exact strings the tests assert:
    #  env marker      env.get("LOOKOUT_TRIAGE")            -> (False, "triage-of-triage")
    #  re-fired stop   payload.get("stop_hook_active")      -> (False, "stop-hook-active")
    #  platform        sysname not in ("Darwin", "Linux")   -> (False, "platform")
    #  payload         missing session_id/transcript_path   -> (False, "no-session")
    #  registry        no <sid>.json or no pane_id in it    -> (False, "no-pane")
    #  question        "?" not in last_assistant_text(...)  -> (False, "no-question")
    #  cooldown        state <sid>.json newer than COOLDOWN_S
    #                  OR transcript size <= recorded offset -> (False, "cooldown")
    #  lock            mkdir(state_dir/lock) fails and its mtime
    #                  is younger than LOCK_STALE_S          -> (False, "locked")
    #                  (an older lock dir is stolen: rmdir+mkdir)
    #  otherwise                                            -> (True, "go")

def main() -> None
    # stdin JSON -> should_triage(payload, os.environ, platform.system(), ...).
    # On (True, _): write state <sid>.json {"at": time.time(), "offset": <transcript size>},
    # then spawn DETACHED and exit 0 immediately:
    #   subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "triage-and-push.py"),
    #                     payload["session_id"]],
    #                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    #                    stdin=subprocess.DEVNULL, start_new_session=True,
    #                    env={**os.environ, "LOOKOUT_TRIAGE": "1"})
    # Never print; wrap main in try/except: pass like register-session.py.
```

The lock is released by `triage-and-push.py` (Task 5), not here; the stale-steal covers a crashed triage.

- [ ] **Step 1: Write the failing tests** — `c-assistant/tests/test_prefilter.py` (drive `should_triage` and `last_assistant_text` with tmpdirs; import via `importlib` since the filename has a hyphen):

```python
import importlib.util, json, os, tempfile, time, unittest

def load_mod():
    p = os.path.join(os.path.dirname(__file__), "..", "scripts", "needs-input-hook.py")
    spec = importlib.util.spec_from_file_location("needs_input_hook", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def write_transcript(dirpath, lines):
    p = os.path.join(dirpath, "t.jsonl")
    with open(p, "w") as f:
        for obj in lines:
            f.write(json.dumps(obj) + "\n")
    return p

def assistant(text):
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}

class Prefilter(unittest.TestCase):
    def setUp(self):
        self.mod = load_mod()
        self.tmp = tempfile.TemporaryDirectory()
        self.reg = os.path.join(self.tmp.name, "reg"); os.makedirs(self.reg)
        self.state = os.path.join(self.tmp.name, "state"); os.makedirs(self.state)

    def payload(self, transcript):
        sid = "abc123"
        with open(os.path.join(self.reg, sid + ".json"), "w") as f:
            json.dump({"session_id": sid, "pane_id": "pane-1"}, f)
        return {"session_id": sid, "transcript_path": transcript}

    def test_question_goes(self):
        t = write_transcript(self.tmp.name, [assistant("Should I ship it?")])
        ok, why = self.mod.should_triage(self.payload(t), {}, "Darwin", self.reg, self.state)
        self.assertTrue(ok, why)

    def test_no_question_refused(self):
        t = write_transcript(self.tmp.name, [assistant("All done. Committed.")])
        ok, why = self.mod.should_triage(self.payload(t), {}, "Darwin", self.reg, self.state)
        self.assertEqual((ok, why), (False, "no-question"))

    def test_env_marker_refused(self):
        t = write_transcript(self.tmp.name, [assistant("Ship it?")])
        ok, why = self.mod.should_triage(self.payload(t), {"LOOKOUT_TRIAGE": "1"}, "Darwin", self.reg, self.state)
        self.assertEqual((ok, why), (False, "triage-of-triage"))

    def test_windows_refused(self):
        t = write_transcript(self.tmp.name, [assistant("Ship it?")])
        ok, why = self.mod.should_triage(self.payload(t), {}, "Windows", self.reg, self.state)
        self.assertEqual((ok, why), (False, "platform"))

    def test_no_pane_refused(self):
        t = write_transcript(self.tmp.name, [assistant("Ship it?")])
        payload = {"session_id": "nope", "transcript_path": t}
        ok, why = self.mod.should_triage(payload, {}, "Darwin", self.reg, self.state)
        self.assertEqual((ok, why), (False, "no-pane"))

    def test_cooldown_refused_until_transcript_grows(self):
        t = write_transcript(self.tmp.name, [assistant("Ship it?")])
        p = self.payload(t)
        with open(os.path.join(self.state, "abc123.json"), "w") as f:
            json.dump({"at": time.time(), "offset": os.path.getsize(t)}, f)
        ok, why = self.mod.should_triage(p, {}, "Darwin", self.reg, self.state)
        self.assertEqual((ok, why), (False, "cooldown"))

    def test_last_assistant_text_takes_the_last_one(self):
        t = write_transcript(self.tmp.name, [assistant("first?"), {"type": "user"}, assistant("second — no q")])
        self.assertIn("second", self.mod.last_assistant_text(t))

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify they fail** — FAIL (file missing).
- [ ] **Step 3: Implement `needs-input-hook.py`** to the letter of the Interfaces block.
- [ ] **Step 4: Run** — all prefilter tests PASS.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout Stop-hook prefilter"`

---

### Task 4: `push-card.py` — the socket v2 client

**Files:**
- Create: `c-assistant/scripts/push-card.py`
- Test: `c-assistant/tests/test_push_card.py`

**Interfaces:**
- Consumes: registry (Task 2), SeaShell control socket (`{"cmd":"card",...}` from the companion plan).
- Produces:

```
usage: python3 push-card.py <session-id-prefix> --question TEXT [--draft TEXT] [--dry-run]
env:   SEASHELL_CONTROL_SOCKET overrides the socket path (default
       ~/Library/Application Support/seashell/control.sock on Darwin,
       ~/.config/seashell/control.sock on Linux)
prints DELIVERED/VALIDATED/REFUSED lines; exit 0 only on delivered/validated.
```

Internals mirror `send-to-pane.py` (same registry resolution, ambiguity refusal, live-pid check via `ps -p <pid> -o command=` matching a main claude process, control-char and length caps: question ≤ 2000, draft ≤ 4000, both collapsed to single-line before validation) with a `one_line(text)` helper: `" ".join(text.split())`. Request: `{"cmd": "card", "paneId": rec["pane_id"], "question": q, "draft": d_or_None, "validateOnly": bool}` + `\n`, one reply line read. `--dry-run` sets `validateOnly: true` and prints `VALIDATED: server accepted the card without creating it` — the dry run exercises resolution, connection, and server-side validation for real. Expose `build_request(rec, question, draft, dry_run) -> dict` and `deliver(sock_path, req) -> dict` at module level for the tests.

- [ ] **Step 1: Write the failing tests** — `c-assistant/tests/test_push_card.py` with an in-test Unix-socket server:

```python
import importlib.util, json, os, socket, tempfile, threading, unittest

def load_mod():
    p = os.path.join(os.path.dirname(__file__), "..", "scripts", "push-card.py")
    spec = importlib.util.spec_from_file_location("push_card", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class FakeSocketServer:
    def __init__(self, reply):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "ctl.sock")
        self.received = []
        self.reply = reply
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        self.srv.listen(1)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        conn, _ = self.srv.accept()
        data = b""
        while b"\n" not in data:
            data += conn.recv(4096)
        self.received.append(json.loads(data.decode()))
        conn.sendall((json.dumps(self.reply) + "\n").encode())
        conn.close()

class PushCard(unittest.TestCase):
    def test_build_request_collapses_newlines_and_marks_dry_run(self):
        mod = load_mod()
        req = mod.build_request({"pane_id": "p1"}, "line one\nline two?", "a\nb", True)
        self.assertEqual(req["question"], "line one line two?")
        self.assertEqual(req["draft"], "a b")
        self.assertTrue(req["validateOnly"])
        self.assertEqual(req["cmd"], "card")

    def test_deliver_round_trip(self):
        mod = load_mod()
        srv = FakeSocketServer({"ok": True})
        res = mod.deliver(srv.path, {"cmd": "card", "paneId": "p1", "question": "q?", "draft": None, "validateOnly": False})
        self.assertTrue(res["ok"])
        self.assertEqual(srv.received[0]["question"], "q?")

    def test_deliver_surfaces_refusal(self):
        mod = load_mod()
        srv = FakeSocketServer({"ok": False, "error": "unknown cmd"})
        res = mod.deliver(srv.path, {"cmd": "card", "paneId": "p1", "question": "q?", "draft": None, "validateOnly": False})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "unknown cmd")

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement `push-card.py`.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout card pusher with honest dry-run"`

---

### Task 5: Triage — prompt + runner

**Files:**
- Create: `c-assistant/scripts/triage-prompt.md`
- Create: `c-assistant/scripts/triage-and-push.py`
- Test: `c-assistant/tests/test_triage.py`

**Interfaces:**
- Consumes: `last_assistant_text` logic (reimplemented locally — scripts stay import-independent of each other since the hyphenated names make cross-imports awkward; a 20-line duplication, noted in both docstrings), `push-card.py` via subprocess, lock dir from Task 3.
- Produces:

```python
# triage-and-push.py
def parse_triage_output(stdout: str) -> dict | None
    # First "{" to last "}" -> json.loads; require keys: card (bool),
    # question (str), draft (str|None). Anything else -> None.
def run_triage(prompt: str, env: dict) -> str
    # subprocess.run(["claude", "-p", "--model", "haiku"], input=prompt,
    #                capture_output=True, text=True, timeout=90, env=env).stdout
def main(session_id: str) -> None
    # try: read registry + transcript tail; build prompt from triage-prompt.md
    #      + the tail text; run_triage with LOOKOUT_TRIAGE=1 in env;
    #      parse; if res and res["card"]: subprocess.run push-card.py
    #      with --question / --draft (omit --draft when None)
    # finally: best-effort rmdir of the lock dir (STATE_DIR/lock)
```

`triage-prompt.md`, exactly this content (generic, public-safe):

```markdown
You are triaging one Claude Code session for its user. Below is the tail of the
session transcript. The assistant's final message just ended the turn.

Decide whether this session is genuinely waiting on the user, and if so, draft
the reply the user would type back.

Card it (card=true) when the final message:
- asks a real question with real options, or
- is blocked on something only the user can do (a login, a click, a purchase), or
- stopped mid-task asking whether to continue.

Do NOT card (card=false) when it:
- only narrates finished work,
- only offers an optional nice-to-have ("say the word and I'll..."),
- is mid-work with no question.

Drafting rules, when card=true:
- One line, under 300 characters, written as the user in the register they use
  in this transcript (lowercase is fine).
- Pick a side. Cover every sub-question in the message.
- Attach the reason only when it changes what the session will do.
- NEVER draft (use draft=null) when the answer moves money, makes a legal
  commitment, sends anything outside the machine irreversibly, or depends on a
  fact only the user holds. The card still shows the question.

Reply with STRICT JSON only — no prose, no code fences:
{"card": true|false, "question": "<the session's ask, condensed, <=300 chars>", "draft": "<one line>" | null}

Transcript tail:
---
```

- [ ] **Step 1: Write the failing tests** — `c-assistant/tests/test_triage.py`. Parsing tests plus a fake-`claude` integration test using a PATH shim:

```python
import importlib.util, json, os, stat, tempfile, unittest

def load_mod():
    p = os.path.join(os.path.dirname(__file__), "..", "scripts", "triage-and-push.py")
    spec = importlib.util.spec_from_file_location("triage_and_push", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class TriageParse(unittest.TestCase):
    def test_parses_strict_json(self):
        mod = load_mod()
        out = mod.parse_triage_output('{"card": true, "question": "ship?", "draft": "yes"}')
        self.assertEqual(out["draft"], "yes")

    def test_parses_json_wrapped_in_noise(self):
        mod = load_mod()
        out = mod.parse_triage_output('Sure! {"card": false, "question": "x", "draft": null} done')
        self.assertFalse(out["card"])
        self.assertIsNone(out["draft"])

    def test_rejects_missing_keys_and_junk(self):
        mod = load_mod()
        self.assertIsNone(mod.parse_triage_output('{"card": true}'))
        self.assertIsNone(mod.parse_triage_output("no json at all"))

class TriageRun(unittest.TestCase):
    def test_run_triage_calls_claude_from_path(self):
        mod = load_mod()
        with tempfile.TemporaryDirectory() as d:
            shim = os.path.join(d, "claude")
            with open(shim, "w") as f:
                f.write('#!/bin/sh\necho \'{"card": true, "question": "q?", "draft": "ok"}\'\n')
            os.chmod(shim, os.stat(shim).st_mode | stat.S_IEXEC)
            env = {**os.environ, "PATH": d + os.pathsep + os.environ.get("PATH", ""), "LOOKOUT_TRIAGE": "1"}
            out = mod.run_triage("prompt text", env)
            self.assertIn('"card": true', out)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement** both files. `--model haiku` is the CLI alias (cheap tier; exact pinned ids belong to the CLI, not this script). The pushed question/draft pass through `push-card.py`, which owns single-lining and caps.
- [ ] **Step 4: Run** — PASS; also re-run the full suite (`python3 -m unittest discover -s c-assistant/tests -v`).
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout triage runner and drafting prompt"`

---

### Task 6: Version bump, marketplace entry, README, push

**Files:**
- Modify: `c-assistant/.claude-plugin/plugin.json` (version `1.1.0` → `1.2.0`; append one sentence to `description`: "With SeaShell 0.2.0+, also pushes live approval cards when a session stops on a question.")
- Modify: `.claude-plugin/marketplace.json` (the `c-assistant` entry's `version` + same description sentence)
- Modify: `README.md` (c-assistant section: the two lanes, the two install commands, macOS/Linux note)

- [ ] **Step 1:** Make the three edits. `python3 -m json.tool` both JSON files to prove validity.
- [ ] **Step 2:** Full suite one last time: `python3 -m unittest discover -s c-assistant/tests -v` → all PASS.
- [ ] **Step 3:** `git add -A && git commit -m "Bump c-assistant to 1.2.0 with Lookout brain lane"`
- [ ] **Step 4:** `git pull --rebase && git push` (repo rule: fetch first; never force).
- [ ] **Step 5:** On Josh's machine only (not part of the public work): `/plugin update c-assistant` refreshes the cache copy so the hooks go live locally.

---

### Task 7: Joint end-to-end smoke (needs both plans landed)

No files — a manual checklist, run once SeaShell 0.2.0 (companion plan) is built:

- [ ] `push-card.py <live-session-prefix> --question "test?" --dry-run` against the NEW SeaShell → `VALIDATED`. (Against a pre-0.2.0 SeaShell the expected result is `REFUSED: unknown cmd` — that refusal proves the client's honesty, not a bug.)
- [ ] Same without `--dry-run` → card appears in SeaShell with the question.
- [ ] In a SeaShell claude pane, ask the session something that makes it end its turn with a question → within ~30s an enriched card appears (Stop hook → triage → push), draft in your register.
- [ ] Ask a money-shaped question ("should I wire the $2k deposit?") in a scratch session → card arrives **draft-less**.
- [ ] `LOOKOUT_TRIAGE` recursion guard: confirm `~/.claude/lookout/` gained no lock leftovers and no triage-of-triage state files after the above.
- [ ] Terminal.app (non-SeaShell) session ending on a question → no card, no error (prefilter reason `no-pane`).

## Plan self-review notes

Spec coverage: plugin layout + both hooks (T2), prefilter guards incl. platform/env/cooldown/lock (T3), pusher + honest dry-run via validateOnly (T4), triage prompt with the judgment table and the never-draft rules + haiku runner + self-exclusion env (T5), docstring fix (T1), version/marketplace/README + push discipline (T6), joint E2E incl. the draft-less money case (T7). State dir `~/.claude/lookout/` used in T3/T5 only, never the plugin dir. Dev-shadow rule honored: no writes outside the marketplace clone except the state dir at runtime.
