# Lookout: approval cards for waiting agent panes

**Date:** 2026-08-01
**Status:** approved design, pre-implementation
**Prior art:** `2026-07-31-pane-delivery-design.md` (the control socket and the
"typed, never submitted" boundary — amended by this spec, see "Who presses Enter")

## What this is

When you run many agent panes, the expensive part is not the agents working —
it is noticing which pane stopped to ask you something, reading what it wants,
and walking over to answer it. Lookout makes SeaShell do the noticing and the
walking: a pane that stops on a question raises a **card**; clicking a button on
the card answers that pane.

Two lanes feed one card system:

1. **Detector lane (ships to every user, all three platforms).** SeaShell
   itself notices a claude pane idle on a question and raises a card with the
   question and canned replies — `[Continue] [Yes] [No] [Go to pane] [✕]`.
   Zero config, zero tokens, no external processes.
2. **Brain lane (opt-in, via the public c-assistant plugin).** A Claude Code
   Stop hook triages the finished turn and pushes a richer card through the
   control socket: the question plus a **drafted one-line reply in the user's
   voice** — `[Approve ✓] [Edit] [Deny ✕]`. A pushed card replaces the
   detector's card for that pane.

The governing rule, unchanged in spirit from the pane-delivery spec:
**external processes can only propose. The only thing that ever submits into a
session is the user's real-time action inside SeaShell.**

## Decisions locked during design

- **Approve submits.** One click sends the shown text into the pane and the
  session starts working. Chosen over type-only (which keeps the pane trip this
  feature exists to remove) and over tiering (unneeded — see drafting rules).
- **Option 2 split.** SeaShell ships cards *and* the built-in detector so the
  feature is visible on every platform out of the box; the LLM brain is
  distributed separately (below) and is never part of SeaShell.
- **Plugin distribution.** Everything the feature needs outside this repo ships
  in the public **c-assistant plugin** in `voidharbor/claude-plugins` — hooks,
  prefilter, triage prompt, card pusher, session registry. Fresh machine flow:
  install SeaShell, then

      /plugin marketplace add voidharbor/claude-plugins
      /plugin install c-assistant@voidharbor

  and nothing else. SeaShell detects the plugin; when it is absent, Lookout's
  empty state shows exactly those two commands. Developer copies of these
  scripts may exist in `~/.claude/bin` as dev shadows; **the plugin is the
  source of truth for users.**

## The card

A stack in the bottom-right corner over the panes, plus a count badge in the
status bar. Cards are suppressed for the focused pane — you are already looking
at it; it gets the badge only.

- **Detector card:** pane title, the detected question, canned buttons.
  `[Continue]`, `[Yes]`, `[No]` write exactly that word. `[Go to pane]`
  focuses the pane. `[✕]` dismisses without sending.
- **Brain card:** pane title, the question, the full draft text, then
  `[Approve ✓]` (submit the draft verbatim), `[Edit]` (the draft becomes an
  editable textbox on the card; send submits the edited text), `[Deny ✕]`
  (dismiss; **deny never sends anything**).

Lifecycle:

- One card per pane; newest wins; brain cards replace detector cards.
- Every pane has a monotonically increasing **output counter**; a card records
  the counter at creation. Any meaningful new output (threshold tuned with
  fixtures so cursor/status redraws do not count) marks the card **stale**:
  greyed, buttons disabled, labeled "session moved on." A stale card can never
  fire into a changed conversation. If the pane is genuinely still waiting,
  the detector simply raises a fresh card.
- Dismissed cards do not re-raise for the same question text on that pane.
- Cards are in-memory only. A restart clears them; the watcher re-notices
  whatever is still waiting. There is no queue to remember to visit.

## SeaShell components (this repo)

- **Detection** (renderer, `src/renderer/lookout/` — amended at planning).
  SeaShell already computes exactly the idle signal this needs:
  `monitor/activity.ts` + `panes/attention.ts` mark a pane `waiting` only
  after sustained stillness, with focus acknowledgment built in. Detection
  rides that machinery instead of duplicating it: when an unfocused pane
  enters `waiting`, the renderer reads the last ~60 lines out of the xterm
  buffer (already ANSI-free) and a pure `extractQuestion()` looks for
  claude's input-box chrome plus a question; a hit is reported to the
  main-process card store. No second idle timer and no separate tuning knob —
  a card appears at the same moment the pane starts glowing. The
  chrome/question patterns are fixture-driven, and the input-box signature
  doubles as the claude-pane check on every platform.
- **Card store** (`src/main/lookout/card-store.ts`). Owns card state: create
  (watcher or socket), replace, dismiss, staleness via the output counter,
  focus suppression. Publishes to the renderer through the existing IPC
  router.
- **Approve path** (`src/main/lookout/approve.ts`). On click: re-validate
  (pane alive, foreground is claude, output counter unchanged) → write the
  text to the pty → write the single Enter. Any validation failure flips the
  card to stale instead of sending. This is the only code path in the whole
  system that submits.
- **Control socket v2** (`src/main/control/`). One new command:

      {cmd: "card", paneId, question, draft?, validateOnly?}

  Validation mirrors `type`: control characters rejected, question ≤ 2000
  chars, draft ≤ 4000 chars, pane must exist, foreground must be claude.
  `validateOnly: true` runs every check and creates nothing — that is what
  makes an honest `--dry-run` possible on the pusher side. The `type` command
  is untouched. **There is deliberately no submit command**; the socket's
  power ends at proposing.
- **Plugin detection.** Best-effort read of
  `~/.claude/plugins/installed_plugins.json` for `c-assistant@voidharbor`,
  used only to decide whether the empty state shows the two install commands.
  Unreadable or schema-drifted file = treated as absent. Never gates
  function: cards work regardless of what pushed them. The empty state lives
  in the card stack itself: the status-bar badge always opens the stack, and
  a stack with no cards shows either "nothing needs you" (plugin present) or
  the two install commands (plugin absent).
- **Settings.** One master toggle (default on).
- **Platform notes.** The socket is a Unix domain socket on macOS/Linux; the
  Windows named pipe ships together with the Windows brain lane (out of scope
  for v1 — nothing would push to it yet). Detection is renderer-side and so
  identical on all three platforms; "is claude" comes from the screen
  signature everywhere, with the authoritative `ps`-based foreground check
  still gating every socket delivery and every approve on macOS/Linux.

## The c-assistant plugin (voidharbor/claude-plugins repo)

New layout of the existing plugin:

    c-assistant/
      commands/c-assistant.md            (existing)
      commands/c-assistant-voice.md      (existing)
      hooks/hooks.json                   (new: SessionStart + Stop)
      scripts/session-scan.py            (existing; fix stale ~/.claude/bin
                                          docstring → plugin path)
      scripts/register-session.py        (new home; the registry writer)
      scripts/needs-input-hook.py        (new: Stop-hook prefilter)
      scripts/triage-prompt.md           (new: the judgment + drafting prompt)
      scripts/push-card.py               (new: socket v2 sender)

- **SessionStart hook = the registry.** The feature's session→pane resolution
  needs `~/.claude/session-registry/`, so the plugin carries
  `register-session.py` and registers it — a fresh machine gets the registry
  from the same install. The write is idempotent, so a developer's personal
  settings.json hook running alongside is harmless.
- **Stop hook = the brain trigger.** `needs-input-hook.py` runs on every turn
  end and exits immediately (no LLM, sub-second) unless: the platform is one
  the brain lane supports (macOS/Linux in v1 — on Windows the hook exits
  first thing, so installing the plugin there is harmless), the last
  assistant message actually contains a question, the session is registered
  with a `pane_id` (Terminal windows never card — manual `/c-assistant`
  covers them), no triage is already running (lockfile in
  `~/.claude/lookout/`), the per-session cooldown has passed and the
  transcript has grown since the last triage, and the `LOOKOUT_TRIAGE` env
  marker is absent.
- **Triage.** Survivors spawn one detached headless `claude -p` (Haiku-class
  model, ~60s timeout, `LOOKOUT_TRIAGE=1` in its env so its own hooks exit
  instantly — the triager can never triage itself). The prompt applies the
  same judgment table as `/c-assistant` and the same drafting rules,
  including: **money, legal commitments, and irreversible sends never get a
  draft** — those cards arrive draft-less, so there is nothing to one-click.
  Output contract is JSON (`{card, question, draft|null}`); any parse failure
  or timeout pushes nothing. Silence is the failure mode, never a wrong card.
- **Push.** `push-card.py` resolves session → registry → `pane_id` (same
  guards as `send-to-pane.py`), connects to the socket (Unix socket; named
  pipe later — the brain lane is **macOS/Linux in v1**, Windows keeps the
  detector lane), and sends the `card` command. `--dry-run` sends
  `validateOnly: true` and therefore exercises the full path — resolution,
  connection, server-side validation — before reporting success.
- **State** lives in `~/.claude/lookout/` (locks, cooldowns, last-triaged
  offsets) — never inside the plugin directory, which is replaced on update.
- **Cost.** The prefilter kills most Stop events before any model runs;
  qualifying triages are single short Haiku calls. Expected steady-state cost
  is pennies per day at 5–10 active sessions.

## Who presses Enter — the amended safety boundary

The pane-delivery spec made "typed, never submitted" a property of the socket
boundary: control characters cannot pass, so no socket caller — all of them
unattended scripts — can ever submit. **That property is preserved verbatim.**
`type` still cannot submit; `card` only proposes.

What changes: **SeaShell itself now appends the single Enter**, inside
`approve.ts`, when — and only when — the user clicks Approve/Send on a card
that displays the exact text and target pane, and click-time re-validation
passes (pane alive, foreground is claude, no meaningful output since the card
was created). The Enter never travels through the socket and never appears in
any text field.

Why this is safe where socket-submit would not be: the original rule existed
because socket callers act **unattended** — no human sees the text at send
time. The approve click is the opposite: a human looking at the exact text,
the exact target, in real time. The set of submission authorities is unchanged
in kind — it was "the user's Enter in the pane"; it is now "the user's Enter
in the pane, or the user's click on a card showing the text." No unattended
process gains submit power, and the race between "card created" and "user
clicked" is closed by the staleness check at the moment of the click.

## Rejected alternatives (decision record)

- **Persistent master-pane variant** (independently spec'd by another session,
  compared 2026-08-01, stub spec deleted — recorded here so it is not
  re-proposed): a user-designated pane runs `/c-assistant` continuously,
  receives a `report` command over the socket, and Enter stays with the human
  in the target pane. Rejected because it consumes a standing session and a
  pane, burns tokens while idle, ties triage latency to that session's loop,
  is a single point of failure, and keeps the walk-to-the-pane trip the
  feature exists to remove. The event-driven Stop hook triages only when a
  turn actually ends, costs nothing at idle, and needs no standing session.
- **A socket submit command.** Rejected: hands submit power to every future
  unattended script with socket access. Submission stays app-internal.
- **Hook-based detection as the only lane.** Rejected as the primary: requires
  every user to install hooks, killing out-of-the-box value. It is the
  upgrade lane instead.
- **An always-on daemon brain.** Rejected: idle burn, another launchd unit,
  and the wrapper-script hazard class we already got bitten by. The Stop hook
  gives event-driven behavior with no resident process.

Manual `/c-assistant` remains fully functional with no SeaShell present, and
remains the cross-session intelligence layer (duplicate work, contradictions,
one-answer-unblocks-three) — live cards are per-session in v1.

## Failure modes and guarantees

- A watcher misread produces at worst a wrong **card** — a dismiss-click of
  annoyance. Nothing fires without a click.
- Stale beats sorry: any meaningful pane output between card creation and
  click disables the card. Approve on a raced card is a no-op with a visible
  "session moved on."
- Brain failures (socket down, old build, parse error, timeout) degrade to
  silence; the detector card and manual `/c-assistant` still stand.
- The triager cannot recurse (env marker), cannot flood (lock + cooldown),
  and cannot draft the undraftable (money/legal/irreversible rules live in
  the triage prompt).
- Drafts are single-line, ≤ 4000 chars, control-character-free at the
  protocol boundary; the Enter is added only by `approve.ts`.

## Testing

- **Watcher:** fixture tests — recorded real claude idle screens (question,
  no question, mid-stream output, AskUserQuestion widget, all three
  platforms) against fake timers. Deterministic; no Electron.
- **Protocol v2:** parse tests in the existing `protocol.ts` style, including
  `validateOnly` and every rejection.
- **Card store:** lifecycle units — dedupe, replace, staleness counter,
  focus suppression, dismiss-no-reraise.
- **Approve path:** fake pty that records writes; asserts text+Enter on the
  happy path and refusal (no write at all) on every failed re-validation.
- **Plugin:** prefilter units on synthetic transcript tails (question / no
  question / no pane_id / cooldown / env marker); `push-card.py --dry-run`
  against a real socket in validate-only mode.
- **E2E:** full pass on macOS; Windows/Linux ship detector-lane with a manual
  checklist until CI can drive Electron.

## Out of scope for v1

Native OS notification mirroring when SeaShell is backgrounded; customizable
canned buttons; cross-session intelligence on live cards; voice
(`c-assistant-VC` hookup); Windows brain lane (named-pipe pusher + a real
foreground check).

## Work map

- **This repo:** `src/main/lookout/` (card-store, approve, plugin-detect),
  `control/` v2, `shared/ipc.ts` additions, `renderer/lookout/` (extract,
  detect, CardStack), settings toggle, fixtures + tests above. Version 0.2.0.
- **voidharbor/claude-plugins:** the c-assistant plugin layout above,
  including the `session-scan.py` docstring fix. Plugin version bump.
