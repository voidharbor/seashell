import { useEffect, useRef, useState } from 'react'

/**
 * First-run tutorial.
 *
 * Optional in the real sense: it can be dismissed from any step, it never
 * blocks the app underneath from working, and once dismissed it does not come
 * back on its own. Help ▸ Show Tutorial reopens it.
 *
 * The content is deliberately about the things that are *not* guessable from
 * looking at the window — that a double-click reveals rather than opens, that
 * previews are panes rather than windows, that closing a pane reaps the whole
 * process tree. Anyone can find the "+" button without being told.
 */

const STORAGE_KEY = 'seashell.tutorialSeen'

export function hasSeenTutorial(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // If storage is unavailable, treat it as seen. Showing the tutorial on
    // every single launch would be far worse than never showing it.
    return true
  }
}

export function markTutorialSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    /* nothing to do — the tutorial simply will not persist its dismissal */
  }
}

interface Step {
  title: string
  body: string
  keys?: Array<[string, string]>
}

const STEPS: Step[] = [
  {
    title: 'Welcome to SeaShell',
    body:
      'A terminal window manager. One window holds tabs, each tab tiles up to six ' +
      'panes, and every pane is a real login shell — the same zsh you get in ' +
      'Terminal.app, with your dotfiles, your PATH and your history.',
    keys: [
      ['⌘T', 'New tab'],
      ['⌘D', 'New pane'],
      ['⌘⏎', 'Full-screen the focused pane, and back'],
    ],
  },
  {
    title: 'Panes tile themselves',
    body:
      'New panes are placed for you. Drag any divider to resize — once you do, ' +
      'that tab stops rearranging itself and keeps your sizing. ⌘⇧R puts it back ' +
      'to an even grid.',
    keys: [
      ['⌘]  ⌘[', 'Focus the next / previous pane'],
      ['⌘⇧R', 'Rebalance the grid'],
      ['⌘W', 'Close the focused pane'],
    ],
  },
  {
    title: 'Closing a pane really closes it',
    body:
      'Closing a pane kills its whole process tree, not just the shell — including ' +
      'background jobs and anything that double-forked away from it. That is the ' +
      'reason this app exists: no more agents left running in a window you forgot ' +
      'about. Panes over 200 MB show their memory in the title bar.',
  },
  {
    title: 'Double-click a path to find it',
    body:
      'Double-click any file path in terminal output and the explorer expands to ' +
      'it and highlights it. It reveals — it does not open. Inside a pane running ' +
      'an agent or any full-screen program, hold Option: those programs claim the ' +
      'mouse for themselves, and Option is how you tell SeaShell the click was ' +
      'meant for it. Bare URLs are clickable anywhere.',
    keys: [
      ['double-click', 'Reveal a path in the explorer'],
      ['⌥ double-click', 'Same, inside an agent or TUI pane'],
    ],
  },
  {
    title: 'Panes tell you when they want you',
    body:
      'A pane breathes its border while its program sits waiting for input, and ' +
      'pulses when a job finishes — never the pane you are already looking at. ' +
      'Panes also name themselves from whatever the running program is doing, so ' +
      'six agents read as six pieces of work rather than six panes called claude. ' +
      'Click the dot in a title bar to colour a pane, or double-click a tab to ' +
      'rename it. When you want none of it, hit the moon at the top right — that ' +
      'is sleep, and panes stop asking for you until you wake it. All of it is ' +
      'switchable in Settings.',
    keys: [
      ['☾', 'Sleep — stop panes flashing, top right'],
      ['⌘,', 'Settings'],
      ['⌘/', 'Show this tutorial again'],
    ],
  },
  {
    title: 'Lookout',
    body:
      'When an agent pane stops to ask you something, a card appears in the ' +
      "Lookout section above the file tree, edged in that pane's colour — " +
      "Approve answers the pane without leaving the one you're in. Smart " +
      'drafted replies come from the c-assistant plugin. ◉ in the Lookout ' +
      'header turns cards off and clears the ones showing; ⇧⌘B just ' +
      'hides the section and leaves them piling up behind it.',
    keys: [
      ['⇧⌘B', 'Hide or show the Lookout section'],
      ['◉', 'Turn cards off entirely, in the Lookout header'],
    ],
  },
  {
    title: 'Previews are panes, not windows',
    body:
      'Open a file from the explorer and it becomes a preview pane, tiled next to ' +
      'your terminals with syntax highlighting. A web preview does the same for a ' +
      'URL — run a dev server in one pane and watch the page in the one beside it. ' +
      'They resize with the same dividers and close with the same ⌘W.',
    keys: [
      ['⌘⇧U', 'New web preview'],
      ['⌘⌥W', 'Close all preview panes'],
      ['⌘F', 'Find in the focused pane'],
    ],
  },
  {
    title: 'Tabs group panes; projects save them',
    body:
      'A tab is a named set of panes — double-click its name, or File > Rename ' +
      'Tab. Save the whole window as a project, or just the active tab, which is ' +
      'the level most people mean by "a project": one tab you can bring into any ' +
      'window later. A saved project can replace the window (Open) or come in ' +
      'alongside what is already running (Add). ' +
      'A project reopens a shape, not a session. You get back the tabs, how they ' +
      'were split, each pane’s directory and what it was launched as, and a ' +
      'claude pane resumes with a visible `claude -r`. What does not come back: ' +
      'the processes, which died with the app, and the scrollback, which is left ' +
      'out deliberately — a terminal buffer routinely holds keys and customer ' +
      'data, and that is not worth writing to a file to save you a scroll.',
    keys: [
      ['⌘⇧P', 'Open projects'],
      ['⌘S', 'Save what is open'],
    ],
  },
  {
    title: 'A scratch shell for each pane',
    body:
      '⌘J opens a shell drawer over the grid, and every pane gets its own — ' +
      'starting in that pane’s working directory, with its own history and ' +
      'scrollback. Switching panes switches shells, so a quick `git status` next ' +
      'to a running agent costs neither a new pane nor an interruption. The ' +
      'drawer names the pane it belongs to, and its shell is created the first ' +
      'time you open it there and dies with the pane.',
    keys: [['⌘J', 'Show or hide the shell drawer']],
  },
  {
    title: 'Link two agents to share notes',
    body:
      'The ⇄ button in a pane’s title bar links it to another agent pane. ' +
      'SeaShell cannot merge two conversations — each session owns its own ' +
      'context — so linking gives both panes one shared notes file and tells ' +
      'each agent about it once. From then on they keep each other current by ' +
      'reading it before a task and appending after one, which is what lets two ' +
      'sessions work the same project without you relaying between them. ' +
      'Only panes actually running an agent can be linked, and nothing is ever ' +
      'sent from one pane to another afterwards.',
  },
  {
    title: 'Seven themes',
    body:
      'Settings > Appearance. Nautical is the default; Current is exactly what ' +
      'the app looked like before. Three more dials sit beside it and compose ' +
      'freely: an accent colour, a terminal palette that recolours the terminals ' +
      'themselves and not just the chrome, and the pane frame — hairline, bezel, ' +
      'floating or slab. CRT glass is separate from the theme, so you can run ' +
      'scanlines and a curved tube over macOS Dark if you want to.',
    keys: [['⌘,', 'Settings']],
  },
  {
    title: 'Make it comfortable',
    body:
      'Zoom comes in two sizes. ⌘= and ⌘- scale every pane and the interface ' +
      'together. Add Shift — ⌘+ and ⌘_ — and only the focused pane changes, so ' +
      'you can keep a log tail small beside an editor you can actually read; that ' +
      'pane then shows its own percentage, and the overall level appears at the ' +
      'top right where clicking it puts everything back to 100%. Note ⌘= rather ' +
      'than ⌘+ for the global pair: + cannot be typed without Shift, and Shift is ' +
      'what means "this pane". Font sizes step through values chosen to stay ' +
      'pixel-aligned, so text never goes blurry at any level.',
    keys: [
      ['⌘=  ⌘-', 'Zoom everything in / out'],
      ['⌘+  ⌘_', 'Zoom the focused pane only'],
      ['⌘0', 'Every pane back to 100%'],
      ['⌘B', 'Show or hide the file explorer'],
    ],
  },
]

export interface TutorialProps {
  onClose: () => void
}

export function Tutorial(props: TutorialProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  /**
   * Defaults to checked, which keeps the behaviour a first-run tutorial should
   * have — you see it once. The checkbox exists so that is a visible, reversible
   * choice rather than something that silently happens to you: untick it and the
   * tutorial is waiting again next launch.
   */
  const [dontShowAgain, setDontShowAgain] = useState(true)
  const current = STEPS[step]!
  const last = step === STEPS.length - 1

  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  // Read by the key handler, which is bound once and would otherwise capture
  // the checkbox value as it was at mount.
  const dontShowRef = useRef(dontShowAgain)
  dontShowRef.current = dontShowAgain

  const close = (): void => {
    if (dontShowAgain) markTutorialSeen()
    props.onClose()
  }

  /**
   * Bound once, for the lifetime of the overlay.
   *
   * This effect originally had no dependency array, so it tore down and
   * re-registered its listener after *every* render — and this component
   * re-renders on the 5-second metrics tick like everything else. Every
   * arrow-key state update also re-rendered, re-registering again. Handlers
   * must be attached once and read state functionally, or a global key
   * listener's lifetime silently becomes "per render" instead of "per mount".
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (dontShowRef.current) markTutorialSeen()
        closeRef.current()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setStep((s) => Math.min(STEPS.length - 1, s + 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setStep((s) => Math.max(0, s - 1))
      }
    }
    // Capture phase: a focused terminal must not receive these keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="tut" onMouseDown={(e) => e.stopPropagation()}>
      <div className="tut__card">
        <div className="tut__head">
          <span className="tut__step">
            {step + 1} / {STEPS.length}
          </span>
          <span className="pane__spacer" />
          <span className="tut__skip" onClick={close}>
            Skip
          </span>
        </div>

        <h2 className="tut__title">{current.title}</h2>
        <p className="tut__body">{current.body}</p>

        {current.keys && (
          <div className="tut__keys">
            {current.keys.map(([chord, what]) => (
              <div className="tut__key" key={chord}>
                <kbd>{chord}</kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        )}

        <div className="tut__dots">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={'tut__dot' + (i === step ? ' tut__dot--on' : '')}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="tut__foot">
          <label className="tut__again" title="Reopen any time with Help ▸ Show Tutorial (⌘/)">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            <span>Don&rsquo;t show this again</span>
          </label>
          <span className="pane__spacer" />
          <button
            className="btn"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </button>
          <button
            className="btn btn--primary"
            onClick={() => (last ? close() : setStep((s) => s + 1))}
          >
            {last ? 'Get started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
