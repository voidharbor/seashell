/**
 * What to tell the user when an approve is refused.
 *
 * Every guard in main's approve path returns a code and writes nothing, and
 * the renderer used to drop that response on the floor. From the front, a
 * refusal and a success looked identical: you clicked Approve, nothing
 * happened, and the card sat there. The most reachable case is an edited draft
 * containing a line break — a five-row box invites one — which main refuses as
 * EINVALID because a newline inside the text would submit the reply halfway
 * through, before the deliberate single Enter that follows it. So the button
 * that looked broken was in fact protecting the conversation, silently.
 *
 * These messages say what happened AND what to do instead. A refusal the user
 * cannot act on is only marginally better than no message.
 */

export type LookoutRefusalCode =
  | 'ENOTFOUND'
  | 'ESTALE'
  | 'EGONE'
  | 'EFOREGROUND'
  | 'EINVALID'
  | 'ESELECTOR'

export function refusalMessage(code: LookoutRefusalCode): string {
  switch (code) {
    case 'EINVALID':
      // The reachable cause by a wide margin: a line break in an edited draft.
      // Named explicitly, because "invalid" tells someone staring at ordinary
      // English nothing at all.
      return 'A reply has to be a single line — remove the line breaks and try again'
    case 'ESELECTOR':
      return "That pane is showing a picker — choose an option in the pane"
    case 'ESTALE':
      return 'That session moved on — answer in the pane instead'
    case 'EFOREGROUND':
      return 'That pane is not sitting at a claude prompt any more'
    case 'EGONE':
      return 'That pane has exited'
    case 'ENOTFOUND':
      return 'That card is no longer waiting — it was answered or dismissed'
  }
}
