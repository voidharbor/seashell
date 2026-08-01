# Pane delivery: /c-assistant → SeaShell control socket

Approved by Josh 2026-07-31 ("yes can we enact it plz"). Lets `/c-assistant`
type a drafted reply into the SeaShell pane that asked the question — on
Josh's explicit per-draft instruction, never on its own, and never submitting.

## The three pieces

1. **Pane registry** (outside this repo). The SessionStart hook at
   `~/.claude/bin/register-session.py` already writes each session's
   `{session_id, pid, tty, app}` to `~/.claude/session-registry/`; it now also
   records `pane_id` from `SEASHELL_PANE_ID`, which SeaShell stamps into every
   pane's environment (`src/main/pty/env.ts`). Sessions outside SeaShell have
   no pane_id and can never be sent to.

2. **Control socket** (this repo). A Unix domain socket at
   `<userData>/control.sock` (`~/Library/Application Support/seashell/control.sock`),
   owned by the main process. One command:

   ```
   → {"cmd":"type","paneId":"pane-8-304837","text":"yes do the relay now"}\n
   ← {"ok":true}\n                      (or {"ok":false,"error":"..."}\n)
   ```

   One request per connection; the server responds and closes. A Unix socket
   rather than a port so there is no network surface — filesystem permissions
   (mode 0600) are the authentication.

3. **`~/.claude/bin/send-to-pane.py`** (outside this repo). Resolves
   session → pane_id via the registry, applies its own guards, connects, sends.

## The safety model

Typing into a pane is newly allowed; `--resume`, `kill`, and auto-submit stay
forbidden. Each guard blocks a failure we can name:

| Guard | Where enforced | Stops |
|---|---|---|
| `text` may contain **no control characters at all** (`\n`, `\r`, tab, ESC, …) | socket, at parse time | A bug upstream physically cannot submit or inject escape sequences — no-submit is a boundary property, not a convention |
| Foreground process on the pane's tty must be claude | socket, via `ps -t <tty>` before writing | Typing into a bare `zsh` — where the text would *execute* |
| Pane must exist and its pty be live | socket (`PtyManager`) | Writing into an exited/reused pane |
| Registered pid must be alive and be a main claude process | `send-to-pane.py` | Delivering to a session that has since closed |
| Registry entry must carry a `pane_id` | `send-to-pane.py` | "Sending" to a Terminal.app session that can never receive it |

Any refusal is explicit and tells Josh to copy-paste instead — never a silent
failure. Text is typed into claude's input box only; Josh reads it there and
presses Enter himself.

## Layout in this repo

- `src/main/control/protocol.ts` — pure request validation (testable, no I/O)
- `src/main/control/foreground.ts` — pure `ps` output → "is claude foreground"
- `src/main/control/server.ts` — socket lifecycle, dependency-injected
  (`writeToPane`, `paneTty`, `checkForeground`) so tests use fakes
- wired in `src/main/index.ts` after `PtyManager` exists; closed on quit;
  a control-surface failure must never break the terminal itself

## Deferred

Phase 2 (an in-pane "reply arrived" banner) waits until this is proven in use.
