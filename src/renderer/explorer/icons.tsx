/**
 * Finder-ish row icons.
 *
 * Drawn as inline SVG rather than emoji: emoji render at the system's own size
 * and colour, ignore the row's selected state, and differ between macOS
 * versions. These stay 16px and take their tint from props.
 */

export function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className="node__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.4 0 .78.2 1 .54l.6.9h6c.66 0 1.2.54 1.2 1.2v6.16c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2z"
        fill={open ? '#6FB1F0' : '#5A9BE0'}
      />
      <path
        d="M1.5 6.6h13.1v5.2c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V6.6z"
        fill={open ? '#9CCBF7' : '#7FB6EC'}
      />
    </svg>
  )
}

export function FileIcon({ ext }: { ext: string }): React.JSX.Element {
  const tint = tintFor(ext)
  return (
    <svg className="node__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.6 1.6h5.3l3.5 3.5v9.3c0 .5-.4.9-.9.9H3.6c-.5 0-.9-.4-.9-.9V2.5c0-.5.4-.9.9-.9z"
        fill="#E8EDF2"
      />
      {/* The folded corner is what makes a rectangle read as "document". */}
      <path d="M8.9 1.6l3.5 3.5H9.5a.6.6 0 01-.6-.6V1.6z" fill="#B9C6D2" />
      {tint !== null && <rect x="2.7" y="9.6" width="9.7" height="3.4" rx="0.7" fill={tint} />}
    </svg>
  )
}

/** A small colour chip per language family — enough to scan a directory by shape. */
function tintFor(ext: string): string | null {
  switch (ext) {
    case 'ts':
    case 'tsx':
      return '#3178C6'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return '#E5A83C'
    case 'json':
      return '#8A6FD1'
    case 'md':
    case 'markdown':
      return '#5E9CD6'
    case 'css':
      return '#C6538C'
    case 'html':
      return '#E06C3A'
    case 'py':
      return '#3D7EAE'
    case 'sh':
    case 'zsh':
    case 'bash':
      return '#4EA353'
    case 'yml':
    case 'yaml':
    case 'toml':
      return '#7C8794'
    default:
      return null
  }
}
