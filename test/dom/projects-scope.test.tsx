import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectsPanel, type ProjectsPanelProps } from '../../src/renderer/projects/ProjectsPanel.js'
import type { Project } from '../../src/shared/ipc.js'

/**
 * Saving one tab as a project, and adding a project without replacing the
 * window.
 *
 * A tab is already a named group of panes, which is the level people mean by
 * "project"; the whole window is the workspace. The two actions on a saved
 * project are therefore not the same: Open replaces the window and reaps every
 * live pane, Add leaves them alone. Confusing them would kill an agent someone
 * was mid-conversation with, so both the scope and the two verbs are pinned.
 */

const project = (over: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: 'Solar Bear',
  savedAt: new Date(0).toISOString(),
  tabs: [{ id: 't1', name: 'Solar Bear', nameIsCustom: true, cwd: '/x', zoomedPaneId: null, focusedPaneId: 'p1', tree: {}, panes: { p1: {} } }],
  ...over,
}) as Project

function props(over: Partial<ProjectsPanelProps> = {}): ProjectsPanelProps {
  return {
    projects: [project()],
    tabCount: 3,
    paneCount: 7,
    activeTabName: 'Solar Bear',
    activeTabPaneCount: 2,
    currentProject: null,
    onSave: () => {},
    onSaveCurrent: () => {},
    onOpen: () => {},
    onAdd: () => {},
    onDelete: () => {},
    onClose: () => {},
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('save scope', () => {
  it('saves the whole window by default', () => {
    const onSave = vi.fn()
    render(<ProjectsPanel {...props({ onSave })} />)
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Everything' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('Everything', 'window')
  })

  it('saves just the active tab when tab scope is chosen', () => {
    const onSave = vi.fn()
    render(<ProjectsPanel {...props({ onSave })} />)
    fireEvent.click(screen.getByText('This tab'))
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Solar Bear' } })
    // The name already exists, so the button reads Overwrite.
    fireEvent.click(screen.getByText('Overwrite'))
    expect(onSave).toHaveBeenCalledWith('Solar Bear', 'tab')
  })

  it('opens on the scope the menu item asked for', () => {
    const onSave = vi.fn()
    render(<ProjectsPanel {...props({ onSave, defaultScope: 'tab' })} />)
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Just this' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('Just this', 'tab')
  })

  it('says what will actually be saved, so the button is never blind', () => {
    const { container } = render(<ProjectsPanel {...props()} />)
    expect(container.textContent).toContain('3 tabs · 7 panes will be saved')
    fireEvent.click(screen.getByText('This tab'))
    expect(container.textContent).toContain('The tab “Solar Bear” · 2 panes will be saved')
  })
})

describe('opening versus adding', () => {
  it('Add and Open are separate actions on the same project', () => {
    const onOpen = vi.fn()
    const onAdd = vi.fn()
    render(<ProjectsPanel {...props({ onOpen, onAdd })} />)

    fireEvent.click(screen.getByText('Add'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('warns in the tooltip that Open closes what is running', () => {
    render(<ProjectsPanel {...props()} />)
    expect(screen.getByText('Open').getAttribute('title')).toMatch(/closes every pane/i)
    expect(screen.getByText('Add').getAttribute('title')).toMatch(/leaving what is open alone/i)
  })
})
