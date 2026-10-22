import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  buildPlanetBranches,
  locationBodies,
  type PlanetBranch,
} from '../lib/bodies'
import { getLocation, locationLabel } from '../store/catalog'
import type { Location } from '../types'
import { FieldClearButton } from './FieldClearButton'

export const MAX_LOCATION_PICKS = 5

interface Props {
  legend: string
  selectedIds: string[]
  locations: Location[]
  /** Unique prefix for button keys */
  idPrefix: string
  max?: number
  /** Other side’s selection count — hide 1/5 when both sides are single */
  peerSelectedCount?: number
  onChange: (ids: string[]) => void
}

function systemLabel(system: string): string {
  if (!system) return 'Unknown'
  return system.replace(/^./, (c) => c.toUpperCase())
}

function locSystem(loc: Location): string {
  return (loc.system || 'unknown').toLowerCase()
}

function matchesQuery(loc: Location, q: string): boolean {
  if (!q) return true
  const hay = `${loc.shortName} ${loc.name} ${loc.body} ${loc.system ?? ''} ${(loc.aliases ?? []).join(' ')}`.toLowerCase()
  return hay.includes(q)
}

function listSystems(locations: Location[]): string[] {
  const set = new Set<string>()
  for (const l of locations) set.add(locSystem(l))
  return [...set].sort((a, b) => a.localeCompare(b))
}

function collectBodies(locations: Location[], systemsOn: string[]): string[] {
  const set = new Set<string>()
  for (const l of locations) {
    if (systemsOn.length && !systemsOn.includes(locSystem(l))) continue
    for (const b of locationBodies(l)) set.add(b)
  }
  return [...set]
}

function allBodiesFromBranches(branches: PlanetBranch[]): string[] {
  return branches.flatMap((b) => b.bodies)
}

function bodiesSummary(bodiesOn: string[], allBodies: string[], branches: PlanetBranch[]): string {
  if (!allBodies.length) return 'No planets'
  if (!bodiesOn.length) return 'None selected'
  if (bodiesOn.length === allBodies.length) return 'All planets'
  const fullyOn = branches.filter(
    (br) => br.bodies.length > 0 && br.bodies.every((b) => bodiesOn.includes(b)),
  )
  if (fullyOn.length && fullyOn.every((br) => br.bodies.every((b) => bodiesOn.includes(b)))) {
    const onlyFull =
      fullyOn.reduce((n, br) => n + br.bodies.length, 0) === bodiesOn.length
    if (onlyFull) {
      const names = fullyOn.map((br) => br.planet)
      if (names.length <= 2) return names.join(', ')
      return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
    }
  }
  return `${bodiesOn.length} / ${allBodies.length} bodies`
}

export function LocationPicker({
  legend,
  selectedIds,
  locations,
  idPrefix,
  max = MAX_LOCATION_PICKS,
  peerSelectedCount = 1,
  onChange,
}: Props) {
  const [query, setQuery] = useState('')
  const [systemsOn, setSystemsOn] = useState<string[]>(() => listSystems(locations))
  /** Selected location.body values (planet surface + individual moons) */
  const [bodiesOn, setBodiesOn] = useState<string[]>(() =>
    collectBodies(locations, listSystems(locations)),
  )
  const [bodyMenuOpen, setBodyMenuOpen] = useState(false)
  /** Which planet groups show their moon list (independent of selection) */
  const [expandedPlanets, setExpandedPlanets] = useState<Record<string, boolean>>({})
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  )
  const bodyMenuRef = useRef<HTMLDivElement>(null)
  const bodyTriggerRef = useRef<HTMLButtonElement>(null)
  const q = query.trim().toLowerCase()

  const systems = useMemo(() => listSystems(locations), [locations])
  const branches = useMemo(() => {
    const scope = systemsOn.length ? systemsOn : systems
    return buildPlanetBranches(collectBodies(locations, scope))
  }, [locations, systemsOn, systems])
  const allBodies = useMemo(() => allBodiesFromBranches(branches), [branches])

  const systemsBooted = useRef(false)
  const bodiesBooted = useRef(false)

  useEffect(() => {
    if (!systems.length) return
    setSystemsOn((prev) => {
      if (!systemsBooted.current) {
        systemsBooted.current = true
        return systems
      }
      return prev.filter((s) => systems.includes(s))
    })
  }, [systems])

  useEffect(() => {
    if (!allBodies.length) {
      setBodiesOn([])
      return
    }
    setBodiesOn((prev) => {
      if (!bodiesBooted.current) {
        bodiesBooted.current = true
        return allBodies
      }
      const retained = prev.filter((b) => allBodies.includes(b))
      const missing = allBodies.filter((b) => !prev.includes(b))
      const hadAllPrior =
        prev.length > 0 &&
        retained.length === prev.length &&
        retained.length === allBodies.length - missing.length
      if (missing.length && hadAllPrior) return allBodies
      return retained
    })
  }, [allBodies])

  function updateMenuPos() {
    const el = bodyTriggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenuPos({
      top: r.bottom + 4,
      left: r.left,
      width: Math.max(r.width, 220),
    })
  }

  useLayoutEffect(() => {
    if (!bodyMenuOpen) {
      setMenuPos(null)
      return
    }
    updateMenuPos()
  }, [bodyMenuOpen, bodiesOn, expandedPlanets, selectedIds.length])

  useEffect(() => {
    if (!bodyMenuOpen) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (bodyMenuRef.current?.contains(t)) return
      if (bodyTriggerRef.current?.contains(t)) return
      setBodyMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setBodyMenuOpen(false)
    }
    function onReposition() {
      updateMenuPos()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [bodyMenuOpen])

  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => locations.find((l) => l.id === id) ?? getLocation(id))
        .filter((l): l is Location => Boolean(l)),
    [selectedIds, locations],
  )

  const filtered = useMemo(() => {
    if (!systemsOn.length || !bodiesOn.length) return []
    const bodySet = new Set(bodiesOn)
    return locations.filter((l) => {
      if (!systemsOn.includes(locSystem(l))) return false
      // Spaceports match planet and star-system tags
      if (!locationBodies(l).some((b) => bodySet.has(b))) return false
      return matchesQuery(l, q)
    })
  }, [locations, q, systemsOn, bodiesOn])

  const showCount = selectedIds.length > 1 || peerSelectedCount > 1
  const listActive = systemsOn.length > 0 && bodiesOn.length > 0
  const bodyLabel = bodiesSummary(bodiesOn, allBodies, branches)

  function toggleSystem(s: string) {
    setSystemsOn((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    )
  }

  function branchState(branch: PlanetBranch): 'on' | 'off' | 'partial' {
    const n = branch.bodies.filter((b) => bodiesOn.includes(b)).length
    if (n === 0) return 'off'
    if (n === branch.bodies.length) return 'on'
    return 'partial'
  }

  /** Right-side label: what’s selected in this planet group. */
  function branchSelectionLabel(branch: PlanetBranch): string {
    const picked = branch.bodies.filter((b) => bodiesOn.includes(b))
    if (!picked.length) return ''
    if (picked.length === branch.bodies.length) return 'all'
    return picked
      .map((b) => {
        if (b === branch.planet) return 'planet'
        return b
      })
      .join(', ')
  }

  function bodyChildLabel(branch: PlanetBranch, body: string): string {
    if (body === branch.planet) return `${body} (planet)`
    return body
  }

  function togglePlanet(branch: PlanetBranch) {
    const state = branchState(branch)
    setBodiesOn((prev) => {
      if (state === 'on') {
        return prev.filter((b) => !branch.bodies.includes(b))
      }
      const next = new Set(prev)
      for (const b of branch.bodies) next.add(b)
      return [...next]
    })
  }

  function toggleBody(body: string) {
    setBodiesOn((prev) =>
      prev.includes(body) ? prev.filter((x) => x !== body) : [...prev, body],
    )
  }

  function selectAllBodies() {
    setBodiesOn(allBodies)
  }

  function clearAllBodies() {
    setBodiesOn([])
  }

  function branchHasChildren(branch: PlanetBranch): boolean {
    return branch.bodies.length > 1
  }

  function expandAllGroups() {
    const next: Record<string, boolean> = {}
    for (const br of branches) {
      if (branchHasChildren(br)) next[br.planet] = true
    }
    setExpandedPlanets(next)
  }

  function collapseAllGroups() {
    setExpandedPlanets({})
  }

  function toggleExpanded(planet: string) {
    setExpandedPlanets((prev) => ({ ...prev, [planet]: !prev[planet] }))
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
      return
    }
    if (selectedIds.length >= max) return
    onChange([...selectedIds, id])
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id))
  }

  return (
    <fieldset className="loc-picker">
      <legend>
        {legend}
        {showCount && (
          <span className="loc-picker-count">
            {' '}
            {selectedIds.length}/{max}
          </span>
        )}
      </legend>

      <div className="loc-selected">
        <span className="loc-selected-label">Selected</span>
        <div className="loc-selected-chips">
          {selected.length === 0 && (
            <span className="loc-selected-empty">None</span>
          )}
          {selected.map((l) => (
            <button
              key={`${idPrefix}-sel-${l.id}`}
              type="button"
              className="chip on loc-selected-chip"
              title="Remove"
              onClick={() => remove(l.id)}
            >
              {l.shortName}
              <span className="loc-selected-x" aria-hidden>
                ×
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="loc-filters">
        <div className="loc-filter-row">
          <div
            className="loc-system-toggles"
            role="group"
            aria-label={`${legend} star system`}
          >
            {systems.map((s) => {
              const on = systemsOn.includes(s)
              return (
                <button
                  key={s}
                  type="button"
                  className={on ? 'loc-system-switch on' : 'loc-system-switch'}
                  aria-pressed={on}
                  onClick={() => toggleSystem(s)}
                >
                  <span className="loc-system-track" aria-hidden>
                    <span className="loc-system-knob" />
                  </span>
                  {systemLabel(s)}
                </button>
              )
            })}
          </div>

          <div className="loc-body-dropdown">
            <button
              ref={bodyTriggerRef}
              type="button"
              className={
                bodyMenuOpen
                  ? 'loc-body-trigger open'
                  : bodiesOn.length
                    ? 'loc-body-trigger'
                    : 'loc-body-trigger empty'
              }
              aria-haspopup="listbox"
              aria-expanded={bodyMenuOpen}
              onClick={() => setBodyMenuOpen((o) => !o)}
            >
              <span className="loc-body-trigger-label">{bodyLabel}</span>
              <span className="loc-body-trigger-caret" aria-hidden>
                ▾
              </span>
            </button>

            {bodyMenuOpen &&
              menuPos &&
              createPortal(
                <div
                  ref={bodyMenuRef}
                  className="loc-body-menu loc-body-menu-portal"
                  role="listbox"
                  aria-multiselectable="true"
                  style={{
                    top: menuPos.top,
                    left: menuPos.left,
                    width: menuPos.width,
                  }}
                >
                  <div className="loc-body-menu-actions">
                    <div className="loc-body-menu-action-group" role="group" aria-label="Selection">
                      <button type="button" className="ghost" onClick={selectAllBodies}>
                        Select all
                      </button>
                      <button type="button" className="ghost" onClick={clearAllBodies}>
                        Clear all
                      </button>
                    </div>
                    <div className="loc-body-menu-action-group" role="group" aria-label="Groups">
                      <button type="button" className="ghost" onClick={expandAllGroups}>
                        Expand all
                      </button>
                      <button type="button" className="ghost" onClick={collapseAllGroups}>
                        Collapse all
                      </button>
                    </div>
                  </div>
                  {branches.map((branch) => {
                    const state = branchState(branch)
                    const hasChildren = branchHasChildren(branch)
                    const open = Boolean(expandedPlanets[branch.planet])
                    const selectionLabel = branchSelectionLabel(branch)
                    return (
                      <div key={branch.planet} className="loc-body-menu-group">
                        <div className={`loc-body-menu-planet-row state-${state}`}>
                          <button
                            type="button"
                            className={`loc-pm state-${state}`}
                            aria-pressed={state !== 'off'}
                            aria-label={
                              state === 'on'
                                ? `Deselect ${branch.planet}`
                                : `Select ${branch.planet}`
                            }
                            onClick={() => togglePlanet(branch)}
                          >
                            <span className="loc-pm-idle" aria-hidden>
                              {state === 'on' ? '✓' : state === 'partial' ? '▣' : ''}
                            </span>
                            <span className="loc-pm-hover" aria-hidden>
                              {state === 'on' ? '−' : '+'}
                            </span>
                          </button>
                          {hasChildren ? (
                            <button
                              type="button"
                              className="loc-body-menu-planet-toggle"
                              aria-expanded={open}
                              onClick={() => toggleExpanded(branch.planet)}
                            >
                              <span className="loc-body-expand" aria-hidden>
                                {open ? '▾' : '▸'}
                              </span>
                              <span className="loc-body-menu-name">{branch.planet}</span>
                              {selectionLabel ? (
                                <span className="loc-body-menu-hint" title={selectionLabel}>
                                  {selectionLabel}
                                </span>
                              ) : null}
                            </button>
                          ) : (
                            <div className="loc-body-menu-planet-toggle static">
                              <span className="loc-body-expand spacer" aria-hidden />
                              <span className="loc-body-menu-name">{branch.planet}</span>
                              {selectionLabel ? (
                                <span className="loc-body-menu-hint" title={selectionLabel}>
                                  {selectionLabel}
                                </span>
                              ) : null}
                            </div>
                          )}
                        </div>
                        {hasChildren && open && (
                          <div className="loc-body-menu-moons">
                            {branch.bodies.map((body) => {
                              const on = bodiesOn.includes(body)
                              const label = bodyChildLabel(branch, body)
                              return (
                                <div
                                  key={body}
                                  className={
                                    on
                                      ? 'loc-body-menu-moon on'
                                      : 'loc-body-menu-moon'
                                  }
                                >
                                  <button
                                    type="button"
                                    className={on ? 'loc-pm on' : 'loc-pm'}
                                    aria-pressed={on}
                                    aria-label={
                                      on ? `Deselect ${label}` : `Select ${label}`
                                    }
                                    onClick={() => toggleBody(body)}
                                  >
                                    <span className="loc-pm-idle" aria-hidden>
                                      {on ? '✓' : ''}
                                    </span>
                                    <span className="loc-pm-hover" aria-hidden>
                                      {on ? '−' : '+'}
                                    </span>
                                  </button>
                                  <span className="loc-body-menu-name">{label}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>,
                document.body,
              )}
          </div>
        </div>

        <label className="loc-search field">
          <span className="sr-only">Search {legend.toLowerCase()}</span>
          <div className="commodity-picker-bar">
            <div className="field-input-wrap">
              <input
                type="search"
                className="commodity-picker-search"
                value={query}
                placeholder={`Search ${legend.toLowerCase()}…`}
                onChange={(e) => setQuery(e.target.value)}
              />
              <FieldClearButton
                visible={Boolean(query.trim())}
                label="Clear search"
                onClear={() => setQuery('')}
              />
            </div>
          </div>
        </label>
      </div>

      <div className="chip-grid">
        {filtered.length === 0 && listActive && (
          <p className="loc-empty hint tight">No locations match.</p>
        )}
        {filtered.map((l) => {
          const on = selectedIds.includes(l.id)
          const blocked = !on && selectedIds.length >= max
          return (
            <button
              key={`${idPrefix}-${l.id}`}
              type="button"
              className={on ? 'chip on' : 'chip'}
              disabled={blocked}
              title={blocked ? `Max ${max} locations` : locationLabel(l.id)}
              onClick={() => toggle(l.id)}
            >
              {l.shortName}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
