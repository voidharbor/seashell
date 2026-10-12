/**
 * [pure] The tutorial's eleven steps, copied from
 * `src/renderer/tutorial/Tutorial.tsx:49-231` (`buildSteps`), which imports
 * React and `window` and so is not imported here. The copy is the renderer's,
 * verbatim, except its em dashes (each became a colon, a semicolon or a comma;
 * UI copy carries none) and what this build lacks: there are no previews, so
 * a modified path double-click opens the default app and the previews step
 * gave its place to the shell drawer's (the renderer's own drawer step, which
 * it would repeat, is gone), and Aero Glass is the only theme. Chords are
 * spelled for the platform through `src/shared/keys.ts`, exactly as the
 * renderer spells them.
 */
import { chordLabel, keyPlatform, modifiersLabel, zoomLabel, type Modifier } from '../../shared/keys.js'

export interface TutorialStep {
  title: string
  /** The step's paragraphs (the renderer has one per step). */
  body: string[]
  /** The key table: the chord as written for the platform, then what it does. */
  keys: Array<[chord: string, action: string]>
}

export function STEPS(platform: string): TutorialStep[] {
  const mac = keyPlatform(platform) === 'darwin'
  const k = (chord: string): string => chordLabel(chord, platform)
  const m = (...mods: Modifier[]): string => modifiersLabel(mods, platform)
  const z = (key: '=' | '-' | '+' | '_' | '0'): string => zoomLabel(key, platform)
  const optWord = mac ? 'Option' : 'Alt'
  const cmdWord = mac ? 'Cmd' : 'Ctrl'
  const cmdAltWord = mac ? 'Cmd+Opt' : 'Ctrl+Alt'
  const enter = mac ? '⏎' : 'Enter'
  const shiftEnter = mac ? '⇧⏎' : 'Shift+Enter'
  const paneIn = mac ? '⌘+' : 'Ctrl+Shift+='
  const paneOut = mac ? '⌘_' : 'Ctrl+Shift+-'
  return [
    {
      title: 'Welcome to SeaShell',
      body: [
        'A terminal window manager. One window holds tabs, each tab tiles up to six ' +
          `panes, and every pane is a real login shell: the same ${mac ? 'zsh' : 'shell'} you get in ` +
          `${mac ? 'Terminal.app' : 'WSL'}, with your dotfiles, your PATH and your history.`,
      ],
      keys: [
        [k('Cmd+T'), 'New tab'],
        [k('Cmd+D'), 'New pane'],
        [k('Cmd+Return'), 'Full-screen the focused pane, and back'],
      ],
    },
    {
      title: 'Panes tile themselves',
      body: [
        'New panes are placed for you. Drag any divider to resize; once you do, ' +
          `that tab stops rearranging itself and keeps your sizing. ${k('Cmd+Shift+R')} puts it back ` +
          'to an even grid.',
      ],
      keys: [
        [`${k('Cmd+]')}  ${k('Cmd+[')}`, 'Focus the next / previous pane'],
        [k('Cmd+Shift+R'), 'Rebalance the grid'],
        [k('Cmd+W'), 'Close the focused pane'],
      ],
    },
    {
      title: 'Closing a pane really closes it',
      body: [
        'Closing a pane kills its whole process tree, not just the shell, including ' +
          'background jobs and anything that double-forked away from it. That is the ' +
          'reason this app exists: no more agents left running in a window you forgot ' +
          'about. Panes over 200 MB show their memory in the title bar.',
      ],
      keys: [],
    },
    {
      title: 'Double-click a path to find it',
      body: [
        'Double-click any file path in terminal output and the file browser opens ' +
          `(it starts closed; ${k('Cmd+B')} brings it back anytime), expands to the path and ` +
          'highlights it. It reveals; it does not open. Inside a pane running ' +
          `an agent or any full-screen program, hold ${optWord}: those programs claim the ` +
          `mouse for themselves, and ${optWord} is how you tell SeaShell the click was ` +
          `meant for it. ${cmdWord}+double-click opens it with the default app, and ` +
          `${cmdAltWord}+double-click does so even for a file it would only reveal. Bare URLs are ` +
          'clickable anywhere.',
      ],
      keys: [
        ['double-click', 'Reveal a path in the explorer'],
        [`${m('Alt')} double-click`, 'Same, inside an agent or TUI pane'],
        [`${m('Cmd')} double-click`, 'Also open it with the default app'],
        [`${m('Cmd', 'Alt')} double-click`, 'Always open it in its default app'],
      ],
    },
    {
      title: 'Find and scroll',
      body: [
        `Find searches as you type. ${k('Cmd+F')} opens a bar in the focused pane, and a ` +
          'counter reads how many matches turned up. Aa and .* toggle case-sensitive ' +
          'and regex search, and reaching the last match wraps back to the first. ' +
          'Once you land on a match it stays selected and on screen, even while the ' +
          'pane keeps printing underneath it. Scrolling now has a feel to it: flick ' +
          'harder and it flies faster, while a slow drag stays exactly as precise as ' +
          'before.',
      ],
      keys: [
        [k('Cmd+F'), 'Find in the pane'],
        [`${enter} / ${shiftEnter}`, 'Next and previous match'],
        [`${k('Cmd+G')} / ${k('Cmd+Shift+G')}`, 'Next and previous match, from anywhere'],
      ],
    },
    {
      title: 'Panes tell you when they want you',
      body: [
        'A pane breathes its border when its program rings the bell for you, which Claude Code ' +
          'does about a minute after it has finished and is sitting there waiting for you, and ' +
          'pulses when a job finishes, never the pane you are already looking at. ' +
          'Panes also name themselves from whatever the running program is doing, so ' +
          'six agents read as six pieces of work rather than six panes called claude. ' +
          'Click the dot in a title bar to colour a pane, or double-click a tab to ' +
          'rename it. When you want none of it, hit the moon at the top right. That ' +
          'is sleep, and panes stop asking for you until you wake it. All of it is ' +
          'switchable in Settings.',
      ],
      keys: [
        ['☾', 'Sleep: stop panes flashing, top right'],
        [k('Cmd+,'), 'Settings'],
        [k('Cmd+/'), 'Show this tutorial again'],
      ],
    },
    {
      title: 'A scratch shell for each pane',
      body: [
        `${k('Cmd+J')} opens a shell drawer over the grid, and every pane gets its own, ` +
          'starting in that pane’s working directory, with its own history and ' +
          'scrollback. Switching panes switches shells, so a quick `git status` next ' +
          'to a running agent costs neither a new pane nor an interruption. The ' +
          'drawer names the pane it belongs to, and its shell is created the first ' +
          'time you open it there and dies with the pane.',
      ],
      keys: [
        [k('Cmd+J'), 'Show or hide the shell drawer'],
        [`${k('Cmd+]')}  ${k('Cmd+[')}`, 'Switch panes; the drawer shows that pane’s shell'],
      ],
    },
    {
      title: 'Tabs group panes; projects save them',
      body: [
        'A tab is a named set of panes: double-click its name, or File > Rename ' +
          'Tab. Save the whole window as a project, or just the active tab, which is ' +
          'the level most people mean by "a project": one tab you can bring into any ' +
          'window later. A saved project can replace the window (Open) or come in ' +
          'alongside what is already running (Add). ' +
          'A project reopens a shape, not a session. You get back the tabs, how they ' +
          'were split, each pane’s directory and what it was launched as, and a ' +
          'claude pane resumes with a visible `claude -r`. What does not come back: ' +
          'the processes, which died with the app, and the scrollback, which is left ' +
          'out deliberately: a terminal buffer routinely holds keys and customer ' +
          'data, and that is not worth writing to a file to save you a scroll.',
      ],
      keys: [
        [k('Cmd+Shift+P'), 'Open projects'],
        [k('Cmd+S'), 'Save what is open'],
      ],
    },
    {
      title: 'Link two agents to share notes',
      body: [
        'The ⇄ button in a pane’s title bar links it to another agent pane. ' +
          'SeaShell cannot merge two conversations; each session owns its own ' +
          'context, so linking gives both panes one shared notes file and tells ' +
          'each agent about it once. From then on they keep each other current by ' +
          'reading it before a task and appending after one, which is what lets two ' +
          'sessions work the same project without you relaying between them. ' +
          'Only panes actually running an agent can be linked, and nothing is ever ' +
          'sent from one pane to another afterwards.',
      ],
      keys: [],
    },
    {
      title: 'Themes and colours',
      body: [
        'Settings > Appearance. Aero Glass in this build; the other themes return later. ' +
          'Three dials sit beside it and compose freely: an accent colour, the tab ' +
          'strip (light, dark, or following the Windows app theme), and a terminal ' +
          'palette that recolours the terminals themselves and not just the chrome. ' +
          'The pane frame and CRT glass come back with the other themes.',
      ],
      keys: [[k('Cmd+,'), 'Settings']],
    },
    {
      title: 'Make it comfortable',
      body: [
        `Zoom comes in two sizes. ${z('=')} and ${z('-')} scale every pane and the interface ` +
          `together. Add Shift, ${paneIn} and ${paneOut}, and only the focused pane changes, so ` +
          'you can keep a log tail small beside an editor you can actually read; that ' +
          'pane then shows its own percentage, and the overall level appears at the ' +
          `top right where clicking it puts everything back to 100%. Note ${z('=')} rather ` +
          `than ${z('+')} for the global pair: + cannot be typed without Shift, and Shift is ` +
          'what means "this pane". Font sizes step through values chosen to stay ' +
          'pixel-aligned, so text never goes blurry at any level.',
      ],
      keys: [
        [`${z('=')}  ${z('-')}`, 'Zoom everything in / out'],
        [`${paneIn}  ${paneOut}`, 'Zoom the focused pane only'],
        [z('0'), 'Every pane back to 100%'],
        [k('Cmd+B'), 'Show or hide the file browser; it starts closed'],
      ],
    },
  ]
}
