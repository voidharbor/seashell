import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FilePreview } from '../../src/renderer/viewer/FilePreview.js'

/** The editable preview: enter edit, see a dirty state, save explicitly,
 *  and never lose data to a file that changed on disk underneath. */

const readTextFile = vi.fn()
const writeTextFile = vi.fn()

beforeEach(() => {
  readTextFile.mockReset().mockResolvedValue({
    ok: true,
    text: 'hello world\n',
    lines: 1,
    size: 12,
    truncated: false,
    mtimeMs: 111,
  })
  writeTextFile.mockReset().mockResolvedValue({ ok: true, mtimeMs: 222 })
  vi.stubGlobal('seashell', {
    fs: { readTextFile, writeTextFile },
    open: { revealInFinder: vi.fn(), withDefaultApp: vi.fn() },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function props(over: Record<string, unknown> = {}) {
  return {
    path: '/home/x/notes.md',
    paneId: 'p1',
    rawSource: true,
    onToggleRaw: () => {},
    findOpen: false,
    findNonce: 0,
    findDirection: 'next' as const,
    onCloseFind: () => {},
    ...over,
  }
}

describe('editable file preview', () => {
  it('edits, shows a dirty state, and saves with the loaded mtime', async () => {
    render(<FilePreview {...props()} />)
    const edit = await screen.findByRole('button', { name: /edit/i })
    fireEvent.click(edit)

    const editor = await screen.findByRole('textbox')
    expect(screen.queryByText(/unsaved/i)).toBeNull()

    fireEvent.change(editor, { target: { value: 'hello brave world\n' } })
    expect(screen.getByText(/unsaved/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(writeTextFile).toHaveBeenCalledWith({
        path: '/home/x/notes.md',
        text: 'hello brave world\n',
        expectedMtimeMs: 111,
      })
    )
    await waitFor(() => expect(screen.queryByText(/unsaved/i)).toBeNull())
  })

  it('a conflicting save shows the changed-on-disk warning and keeps the edits', async () => {
    writeTextFile.mockResolvedValue({ ok: false, code: 'ECONFLICT', message: 'changed' })
    render(<FilePreview {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const editor = await screen.findByRole('textbox')
    fireEvent.change(editor, { target: { value: 'mine\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await screen.findByText(/changed on disk/i)
    expect((editor as HTMLTextAreaElement).value).toBe('mine\n')
    expect(screen.getByText(/unsaved/i)).toBeTruthy()
  })

  it('a truncated file gets no edit button — saving a truncated read would lose the tail', async () => {
    readTextFile.mockResolvedValue({
      ok: true, text: 'partial\n', lines: 1, size: 99, truncated: true, mtimeMs: 111,
    })
    render(<FilePreview {...props()} />)
    await screen.findByText(/truncated/i)
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
  })

  it('an image gets no edit button', async () => {
    vi.stubGlobal('seashell', {
      fs: {
        readTextFile,
        writeTextFile,
        readImageFile: vi.fn().mockResolvedValue({ ok: true, base64: 'aGk=', mime: 'image/png', size: 2 }),
      },
      open: { revealInFinder: vi.fn(), withDefaultApp: vi.fn() },
    })
    render(<FilePreview {...props({ path: '/home/x/pic.png' })} />)
    await screen.findByRole('img')
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
  })
})
