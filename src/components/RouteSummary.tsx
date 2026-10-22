import { useEffect, useMemo, useState } from 'react'
import { formatAuec, formatDistance, formatHoldCapacity } from '../lib/optimizer'
import { enrichStopsWithBoxes, groupRouteByLocation } from '../lib/routeGroups'
import {
  allowedCrateSizes,
  countsToScu,
  formatBoxList,
  scuToBoxes,
} from '../lib/spread'
import { exteriorElevatorNote, getLocation } from '../store/catalog'
import type { Mission, OptimizedRoute, RouteLocationGroup, RouteStop } from '../types'

interface Props {
  route: OptimizedRoute
  missions: Mission[]
  startId: string
  capacityScu: number
  onAmendPickup: (missionId: string, locationId: string, actualScu: number) => void
}

export function RouteSummary({
  route,
  missions,
  startId,
  capacityScu,
  onAmendPickup,
}: Props) {
  const enriched = enrichStopsWithBoxes(route, missions)
  const groups = groupRouteByLocation(enriched.stops)
  const [step, setStep] = useState(0)

  useEffect(() => {
    setStep(0)
  }, [route.totalDistance, route.stops.length, startId])

  const maxStep = Math.max(0, groups.length - 1)
  const safeStep = Math.min(step, maxStep)
  const current = groups[safeStep] as RouteLocationGroup | undefined
  const nextGroup = groups[safeStep + 1] as RouteLocationGroup | undefined

  const stepStats = useMemo(() => {
    if (!current) {
      return {
        loads: [] as RouteStop[],
        unloads: [] as RouteStop[],
        loadScu: 0,
        unloadScu: 0,
        holdAfter: 0,
        remainingLoad: 0,
        remainingDistance: 0,
        legDistance: 0,
      }
    }
    const loads = current.actions.filter((a) => a.kind === 'pickup')
    const unloads = current.actions.filter((a) => a.kind === 'dropoff')
    const loadScu = loads.reduce((s, a) => s + Math.abs(a.cargoDelta), 0)
    const unloadScu = unloads.reduce((s, a) => s + Math.abs(a.cargoDelta), 0)
    const holdAfter = current.actions[current.actions.length - 1]?.cargoAfter ?? 0
    let remainingLoad = 0
    let remainingDistance = 0
    for (let i = safeStep + 1; i < groups.length; i++) {
      remainingLoad += groups[i].totalLoad
      remainingDistance += groups[i].legDistance
    }
    return {
      loads,
      unloads,
      loadScu,
      unloadScu,
      holdAfter,
      remainingLoad,
      remainingDistance,
      legDistance: current.legDistance,
    }
  }, [current, groups, safeStep])

  return (
    <>
      <div className="route-steps">
        <div className="route-steps-nav">
          <button
            type="button"
            className="ghost"
            disabled={safeStep <= 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Prev
          </button>
          <div className="route-steps-label">
            <span>
              Step {groups.length ? safeStep + 1 : 0} / {groups.length}
              {current ? ` · ${current.locationName}` : ''}
            </span>
            {current && <ElevatorNote locationId={current.locationId} />}
          </div>
          <button
            type="button"
            className="ghost"
            disabled={safeStep >= maxStep}
            onClick={() => setStep((s) => Math.min(maxStep, s + 1))}
          >
            Next
          </button>
        </div>

        <div className="route-steps-grid">
          <div className="route-step-card load">
            <span>Load / amend</span>
            {stepStats.loads.length === 0 ? (
              <strong className="muted">—</strong>
            ) : (
              <ul className="route-step-actions">
                {stepStats.loads.map((a, i) => (
                  <li key={`${a.missionId}-load-${i}`}>
                    <div className="route-step-line">
                      <strong>
                        {a.commodity || 'Cargo'} {Math.abs(a.cargoDelta)}
                        {a.confirmed ? <span className="confirmed"> ✓</span> : null}
                      </strong>
                      <CargoSizeGroups boxes={a.boxes} />
                      <AmendPickup
                        label={a.commodity || 'Cargo'}
                        planned={Math.abs(a.cargoDelta)}
                        boxes={a.boxes}
                        maxUnitScu={
                          missions.find((m) => m.id === a.missionId)?.maxUnitScu ?? 8
                        }
                        confirmed={Boolean(a.confirmed)}
                        onApply={(scu) => onAmendPickup(a.missionId, a.locationId, scu)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {stepStats.loadScu > 0 && (
              <p className="route-step-sub">+{stepStats.loadScu} SCU this stop</p>
            )}
          </div>

          <div className="route-step-card next">
            <span>Next</span>
            <div className="route-step-next-head">
              <strong>{nextGroup?.locationName ?? (groups.length ? 'Done' : '—')}</strong>
              {nextGroup && <ElevatorNote locationId={nextGroup.locationId} />}
            </div>
            {nextGroup && nextGroup.legDistance > 0 && (
              <p className="route-step-sub">
                leg {formatDistance(nextGroup.legDistance)}
                {nextGroup.totalLoad > 0 ? ` · load ${nextGroup.totalLoad}` : ''}
                {nextGroup.totalDrop > 0 ? ` · drop ${nextGroup.totalDrop}` : ''}
              </p>
            )}
          </div>

          <div className="route-step-card unload">
            <span>Unload</span>
            {stepStats.unloads.length === 0 ? (
              <strong className="muted">—</strong>
            ) : (
              <ul className="route-step-actions">
                {stepStats.unloads.map((a, i) => (
                  <li key={`${a.missionId}-unload-${i}`}>
                    <div className="route-step-line">
                      <strong>
                        {a.commodity || a.missionName} {Math.abs(a.cargoDelta)}
                      </strong>
                      <CargoSizeGroups boxes={a.boxes} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {stepStats.unloadScu > 0 && (
              <p className="route-step-sub">−{stepStats.unloadScu} SCU this stop</p>
            )}
          </div>

          <div className="route-step-card">
            <span>Total load</span>
            <strong>
              {capacityScu > 0
                ? `${stepStats.holdAfter}/${capacityScu} SCU`
                : `${stepStats.holdAfter} SCU`}
            </strong>
            <p className="route-step-sub">hold after this stop</p>
          </div>

          <div className="route-step-card">
            <span>Remaining load</span>
            <strong>{stepStats.remainingLoad} SCU</strong>
            <p className="route-step-sub">still to pick up</p>
          </div>

          <div className="route-step-card">
            <span>Distance</span>
            <strong>{formatDistance(stepStats.legDistance)}</strong>
            <p className="route-step-sub">
              remaining {formatDistance(stepStats.remainingDistance)} · total{' '}
              {formatDistance(route.totalDistance)}
            </p>
          </div>
        </div>
      </div>

      <div className="route-stats">
        <div>
          <span>Distance</span>
          <strong>{formatDistance(route.totalDistance)}</strong>
        </div>
        <div>
          <span>Profit</span>
          <strong>{formatAuec(route.totalReward)}</strong>
        </div>
        <div>
          <span>Locations</span>
          <strong>{groups.length}</strong>
        </div>
        <div>
          <span>Peak load</span>
          <strong>
            {route.capacityScu > 0
              ? `${route.peakLoad}/${route.capacityScu} SCU`
              : `${route.peakLoad} SCU`}
          </strong>
        </div>
        <div>
          <span>Trips</span>
          <strong>{route.tripCount}</strong>
        </div>
        <div>
          <span>Missions</span>
          <strong>{route.selectedMissionIds.length}</strong>
        </div>
      </div>

      <ol className="stop-list grouped">
        <li className="stop-group start">
          <div className="group-head">
            <span className="badge">START</span>
            <div className="group-main">
              <strong>{getLocation(startId)?.name}</strong>
              <p>Empty hold · {formatHoldCapacity(capacityScu)} capacity</p>
            </div>
            <ElevatorNote locationId={startId} />
          </div>
        </li>

        {groups.map((g, gi) => (
          <li
            key={`${g.locationId}-${g.trip}-${gi}`}
            className={
              gi === safeStep ? 'stop-group current-step' : 'stop-group'
            }
          >
            <div className="group-head">
              <span className="badge loc">
                {route.tripCount > 1 ? `T${g.trip + 1} · ` : ''}
                STOP
              </span>
              <div className="group-main">
                <strong>{g.locationName}</strong>
                <p>
                  {g.totalLoad > 0 ? `Load ${g.totalLoad} SCU` : ''}
                  {g.totalLoad > 0 && g.totalDrop > 0 ? ' · ' : ''}
                  {g.totalDrop > 0 ? `Drop ${g.totalDrop} SCU` : ''}
                  {g.legDistance > 0 ? ` · leg ${formatDistance(g.legDistance)}` : ''}
                  {' · '}
                  {g.actions.length} action{g.actions.length === 1 ? '' : 's'}
                </p>
              </div>
              <ElevatorNote locationId={g.locationId} />
            </div>

            <ul className="action-list">
              {g.actions.map((a, ai) =>
                a.kind === 'pickup' ? (
                  <li key={`${a.missionId}-${a.kind}-${ai}`} className="action pickup compact">
                    <span className="mini-badge pickup">IN</span>
                    <div className="action-body pickup-compact">
                      <strong>
                        {a.commodity || 'Cargo'} {Math.abs(a.cargoDelta)}
                        {a.confirmed ? <span className="confirmed"> ✓</span> : null}
                      </strong>
                      <CargoSizeGroups boxes={a.boxes} />
                      <span className="pickup-hold">hold {a.cargoAfter}</span>
                      <AmendPickup
                        label={a.commodity || 'Cargo'}
                        planned={Math.abs(a.cargoDelta)}
                        boxes={a.boxes}
                        maxUnitScu={
                          missions.find((m) => m.id === a.missionId)?.maxUnitScu ?? 8
                        }
                        confirmed={Boolean(a.confirmed)}
                        onApply={(scu) => onAmendPickup(a.missionId, a.locationId, scu)}
                      />
                    </div>
                  </li>
                ) : (
                  <li key={`${a.missionId}-${a.kind}-${ai}`} className="action dropoff compact">
                    <span className="mini-badge dropoff">OUT</span>
                    <div className="action-body pickup-compact">
                      <strong>
                        {a.commodity || a.missionName} {Math.abs(a.cargoDelta)}
                      </strong>
                      <CargoSizeGroups boxes={a.boxes} />
                      <span className="pickup-hold">hold {a.cargoAfter}</span>
                    </div>
                  </li>
                ),
              )}
            </ul>
          </li>
        ))}
      </ol>
    </>
  )
}

const BOX_COLORS: Record<number, string> = {
  1: '#6b8a9a',
  2: '#5a9bb0',
  4: '#4aa878',
  8: '#c4a04a',
  16: '#d47a3c',
  24: '#c45a6a',
  32: '#9b6bc4',
}

function CargoSizeGroups({ boxes }: { boxes?: number[] }) {
  if (!boxes?.length) return null
  const counts = new Map<number, number>()
  for (const b of boxes) counts.set(b, (counts.get(b) ?? 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => b[0] - a[0])

  return (
    <span className="cargo-size-groups" title={formatBoxList(boxes)}>
      {groups.map(([size, n]) => (
        <span key={size} className="cargo-size-group">
          <span className="cargo-size-count">{n}×</span>
          <span
            className="cargo-size-box"
            style={{ background: BOX_COLORS[size] ?? '#8a9aaa' }}
          >
            {size}
          </span>
        </span>
      ))}
    </span>
  )
}

function ElevatorNote({ locationId }: { locationId: string }) {
  const loc = getLocation(locationId)
  if (!loc || loc.hasExteriorElevator == null) return null
  const ok = loc.hasExteriorElevator === true
  const label = ok ? 'ZERO-G' : 'NO ZERO-G'
  const title = exteriorElevatorNote(locationId) ?? undefined
  return (
    <span
      className={ok ? 'badge dock elevator-yes' : 'badge dock elevator-no'}
      title={title}
    >
      {label}
    </span>
  )
}

function countsFromBoxes(
  boxes: number[] | undefined,
  planned: number,
  maxUnitScu: number,
): Record<number, number> {
  const list = boxes?.length ? boxes : scuToBoxes(planned, maxUnitScu)
  const next: Record<number, number> = {}
  for (const size of allowedCrateSizes(maxUnitScu)) next[size] = 0
  for (const b of list) next[b] = (next[b] ?? 0) + 1
  return next
}

function AmendPickup({
  label,
  planned,
  boxes,
  maxUnitScu = 8,
  confirmed,
  onApply,
}: {
  label?: string
  planned: number
  boxes?: number[]
  maxUnitScu?: number
  confirmed: boolean
  onApply: (scu: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState(() => countsFromBoxes(boxes, planned, maxUnitScu))

  useEffect(() => {
    if (!open) setCounts(countsFromBoxes(boxes, planned, maxUnitScu))
  }, [boxes, planned, maxUnitScu, open])

  const total = countsToScu(counts)
  const sizes = allowedCrateSizes(maxUnitScu)

  function setCount(size: number, n: number) {
    setCounts((prev) => ({ ...prev, [size]: Math.max(0, Math.round(n) || 0) }))
  }

  function close() {
    setOpen(false)
  }

  return (
    <div className="amend compact">
      <button
        type="button"
        className="ghost amend-toggle"
        onClick={() => {
          setCounts(countsFromBoxes(boxes, planned, maxUnitScu))
          setOpen(true)
        }}
        title={confirmed ? 'Edit crates per size' : 'Amend crates per size'}
      >
        {confirmed ? 'Edit' : 'Amend'}
      </button>

      {open && (
        <div
          className="amend-popup-backdrop"
          role="presentation"
          onClick={close}
        >
          <div
            className="amend-popup"
            role="dialog"
            aria-label={`Amend ${label || 'cargo'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="amend-popup-head">
              <strong>{label || 'Cargo'}</strong>
              <span className="amend-crate-total">{total} SCU</span>
            </div>
            <div className="amend-crate-rows">
              {sizes.map((size) => (
                <div key={size} className="amend-crate-row">
                  <div className="amend-count-ctrl">
                    <button
                      type="button"
                      className="ghost amend-step"
                      onClick={() => setCount(size, (counts[size] ?? 0) - 1)}
                      aria-label={`Fewer ${size} SCU crates`}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={0}
                      value={counts[size] ?? 0}
                      onChange={(e) => setCount(size, Number(e.target.value))}
                      aria-label={`${size} SCU crate count`}
                    />
                    <button
                      type="button"
                      className="ghost amend-step"
                      onClick={() => setCount(size, (counts[size] ?? 0) + 1)}
                      aria-label={`More ${size} SCU crates`}
                    >
                      +
                    </button>
                  </div>
                  <span className="cargo-size-count">×</span>
                  <span
                    className="cargo-size-box"
                    style={{ background: BOX_COLORS[size] ?? '#8a9aaa' }}
                  >
                    {size}
                  </span>
                </div>
              ))}
            </div>
            <div className="amend-popup-actions">
              <button type="button" className="ghost" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onApply(total)
                  close()
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
