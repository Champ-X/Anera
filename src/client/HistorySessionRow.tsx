import { Archive, Code2, LoaderCircle, MoreHorizontal, Pencil, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionMetadataPatch, SessionSummary } from '../shared/types'

interface HistorySessionRowProps {
  session: SessionSummary
  active: boolean
  readOnly: boolean
  onSelect: (id: string) => void
  onUpdate: (id: string, patch: SessionMetadataPatch) => Promise<void>
}

export function HistorySessionRow({ session, active, readOnly, onSelect, onUpdate }: HistorySessionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!menuOpen || !trigger.current || !menu.current) return
    const anchor = trigger.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(anchor.right - 12, window.innerWidth - 204)),
      top: Math.max(8, Math.min(anchor.top - 4, window.innerHeight - menu.current.offsetHeight - 8)),
    })
  }, [menuOpen, error])

  useEffect(() => {
    if (!menuOpen) return
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(trigger.current)) setMenuOpen(false)
    }
    const onResize = () => setMenuOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [menuOpen])

  const closeAndFocus = () => {
    setMenuOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  return (
    <div className={`history-entry${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`} data-session-id={session.id}>
      <button
        className="history-session-button"
        aria-current={active ? 'page' : undefined}
        title={session.title}
        onClick={() => onSelect(session.id)}
      >
        <Sparkles className="history-agent-icon" size={11} aria-hidden="true" />
        <span>{session.title}</span>
        {session.productMode === 'coding' && <Code2 className="history-code" size={11} aria-label="Coding session" />}
        {session.status === 'running' && <span className="live-dot" aria-label="Running" />}
      </button>
      {!readOnly && <button
        ref={trigger}
        className="history-actions"
        aria-label={`Conversation actions: ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? `history-menu-${session.id}` : undefined}
        onClick={() => { setError(''); setMenuOpen((open) => !open) }}
      ><MoreHorizontal size={16} /></button>}
      {menuOpen && createPortal(
        <div
          ref={menu}
          id={`history-menu-${session.id}`}
          className="history-menu"
          role="menu"
          aria-label="Conversation actions"
          style={position}
          onKeyDown={(event) => {
            const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            } else if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault()
              event.stopPropagation()
              closeAndFocus()
            }
          }}
        >
          <button role="menuitem" disabled={archiving} onClick={() => { setMenuOpen(false); setRenaming(true) }}><Pencil size={14} />Rename</button>
          <button role="menuitem" className="history-archive" disabled={archiving} onClick={() => {
            setArchiving(true)
            setError('')
            void onUpdate(session.id, { archived: true })
              .then(() => setMenuOpen(false))
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not archive conversation'))
              .finally(() => setArchiving(false))
          }}>{archiving ? <LoaderCircle size={14} className="spin" /> : <Archive size={14} />}Archive</button>
          {error && <p role="alert">{error}</p>}
        </div>, document.body,
      )}
      {renaming && <RenameConversation
        session={session}
        onSave={(title) => onUpdate(session.id, { title })}
        onClose={() => { setRenaming(false); trigger.current?.focus({ preventScroll: true }) }}
      />}
    </div>
  )
}

function RenameConversation({ session, onSave, onClose }: {
  session: SessionSummary
  onSave: (title: string) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(session.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    input.current?.select()
  }, [])
  return createPortal(
    <dialog
      ref={dialog}
      className="rename-conversation-dialog"
      aria-labelledby={`rename-title-${session.id}`}
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}
    >
      <form onSubmit={(event) => {
        event.preventDefault()
        if (saving || !title.trim()) return
        setSaving(true)
        setError('')
        void onSave(title.trim())
          .then(onClose)
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not rename conversation'))
          .finally(() => setSaving(false))
      }}>
        <h2 id={`rename-title-${session.id}`}>Rename conversation</h2>
        <label htmlFor={`rename-input-${session.id}`}>Name</label>
        <input ref={input} id={`rename-input-${session.id}`} value={title} maxLength={200} required autoFocus disabled={saving} onChange={(event) => setTitle(event.target.value)} />
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save'}</button>
        </footer>
      </form>
    </dialog>, document.body,
  )
}
