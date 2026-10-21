import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  label: string
  options: string[]
  value: string
  onChange: (value: string) => void
  idPrefix: string
  placeholder?: string
  /** Keep `options` order (e.g. rank by level) instead of A–Z. */
  preserveOrder?: boolean
}

function matchScore(name: string, q: string): number {
  const n = name.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  const idx = n.indexOf(q)
  if (idx >= 0) return 2 + idx
  if (n.split(/\s+/).some((t) => t.startsWith(q))) return 3
  return -1
}

/** Text input with a floating filtered popup list. */
export function SuggestPopup({
  label,
  options,
  value,
  onChange,
  idPrefix,
  placeholder = 'Type or pick…',
  preserveOrder = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const exactSelected = options.some((o) => o === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const items = useMemo(() => {
    const orderIndex = new Map(options.map((o, i) => [o, i]))
    const byOptionOrder = (a: string, b: string) =>
      (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0)
    const byAlpha = (a: string, b: string) => a.localeCompare(b)
    const tieBreak = preserveOrder ? byOptionOrder : byAlpha

    if (!q || exactSelected) {
      return preserveOrder ? [...options] : [...options].sort(byAlpha)
    }
    return [...options]
      .filter((o) => matchScore(o, q) >= 0)
      .sort((a, b) => matchScore(a, q) - matchScore(b, q) || tieBreak(a, b))
  }, [options, q, exactSelected, preserveOrder])

  function pick(name: string) {
    onChange(name)
    setOpen(false)
  }

  return (
    <div className="suggest-popup field" ref={rootRef}>
      <span>{label}</span>
      <div className="commodity-picker-bar">
        <input
          id={`${idPrefix}-search`}
          type="text"
          className="commodity-picker-search"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className={`commodity-picker-toggle ghost${open ? ' open' : ''}`}
          aria-expanded={open}
          aria-controls={`${idPrefix}-popup`}
          title={open ? 'Close list' : 'Open list'}
          onClick={() => setOpen((v) => !v)}
        >
          ▾
        </button>
      </div>

      {open && (
        <ul
          id={`${idPrefix}-popup`}
          className="suggest-popup-list"
          role="listbox"
          aria-label={label}
        >
          {items.length === 0 && (
            <li className="commodity-picker-empty">No matches</li>
          )}
          {items.map((name) => (
            <li key={name}>
              <button
                type="button"
                role="option"
                aria-selected={value === name}
                className={value === name ? 'active' : undefined}
                onClick={() => pick(name)}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
