import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatAuec, formatDistance, formatHoldCapacity } from '../lib/optimizer'
import {
  actionMarkKey,
  completedMissionIds,
  enrichStopsWithBoxes,
  followingDoneIndices,
  groupRouteByLocation,
  leadingDoneCount,
} from '../lib/routeGroups'
import {
  allowedCrateSizes,
  countsToBoxes,
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
  doneGroups: ReadonlySet<number>
  doneActions: ReadonlySet<string>
  rearrange: boolean
  step: number
  onStepChange: (step: number) => void
  onToggleDone: (index: number) => void
  onToggleKind: (index: number, kind: 'pickup' | 'dropoff') => void
  onToggleAction: (groupIndex: number, actionIndex: number) => void
  onCalculateRest: (currentStep: number) => void
  onToggleRearrange: () => void
  onMoveGroup: (index: number, delta: -1 | 1) => void
  onAmendPickup: (
    missionId: string,
    locationId: string,
    actualScu: number,
    boxes: number[],
    commodity?: string,
  ) => void
  onLoadNote: (missionId: string, commodity: string | undefined, note: string) => void
  readOnly?: boolean
  /** Loads, unloads, and remaining stops can change. Missions stay fixed. */
  limited?: boolean
}

export function RouteSummary({
  route,
  missions,
  startId,
  capacityScu,
  doneGroups,
  doneActions,
  rearrange,
  step,
  onStepChange,
  onToggleDone,
  onToggleKind,
  onToggleAction,
  onCalculateRest,
  onToggleRearrange,
  onMoveGroup,
  onAmendPickup,
  onLoadNote,
  readOnly = false,
  limited = false,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const enriched = enrichStopsWithBoxes(route, missions)
  const groups = groupRouteByLocation(enriched.stops)
  const codeFor = (missionId: string) =>
    missions.find((m) => m.id === missionId)?.code ?? ''

  const maxStep = Math.max(0, groups.length - 1)
  const safeStep = Math.min(step, maxStep)
  const current = groups[safeStep] as RouteLocationGroup | undefined
  const nextGroup = groups[safeStep + 1] as RouteLocationGroup | undefined
  const stopsLeft = Math.max(0, groups.length - safeStep - 1)

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

  const stopDelta = stepStats.loadScu - stepStats.unloadScu
  const stopDeltaLabel =
    stopDelta > 0 ? `+${stopDelta}` : stopDelta < 0 ? `−${Math.abs(stopDelta)}` : '0'

  const sideMark = (kind: 'pickup' | 'dropoff') => {
    if (!current) return { count: 0, all: false, partial: false }
    const indexes = current.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.kind === kind)
      .map(({ index }) => index)
    const marked = indexes.filter((index) => doneActions.has(actionMarkKey(safeStep, index))).length
    return {
      count: indexes.length,
      all: indexes.length > 0 && marked === indexes.length,
      partial: marked > 0 && marked < indexes.length,
    }
  }
  const loadMark = sideMark('pickup')
  const unloadMark = sideMark('dropoff')
  const loadsDone = loadMark.all
  const unloadsDone = unloadMark.all

  const doneCount = leadingDoneCount(doneGroups)
  const followingDone = followingDoneIndices(doneGroups, groups.length, safeStep)
  const finishedMissions = completedMissionIds(groups, doneActions)
  const completedCodes = route.selectedMissionIds
    .filter((id) => finishedMissions.has(id))
    .map((id) => codeFor(id))
    .filter(Boolean)
  const missionTotal = route.selectedMissionIds.length
  const missionDone = route.selectedMissionIds.filter((id) =>
    finishedMissions.has(id),
  ).length
  const canCalculateRest =
    followingDone.length > 0 && followingDone.length < groups.length

  return (
    <>
      <div className="route-steps">
        <div className="route-step-top">
          <button
            type="button"
            className="ghost"
            disabled={safeStep <= 0}
            onClick={() => onStepChange(Math.max(0, safeStep - 1))}
          >
            Prev
          </button>
          <div className="route-step-current-title">
            <span className="route-step-kicker">
              Step {groups.length ? safeStep + 1 : 0} / {groups.length}
            </span>
            <span className="route-step-name-row">
              <span className="route-step-name-side is-left">
                {current && <ElevatorNote locationId={current.locationId} />}
              </span>
              <strong>{current?.locationName ?? '—'}</strong>
              <span className="route-step-name-side is-right">
                <button
                  type="button"
                  className="ghost"
                  disabled={
                    readOnly ||
                    !current ||
                    (doneGroups.has(safeStep) && safeStep >= maxStep)
                  }
                  title={
                    current && current.actions.length >= 2 && !doneGroups.has(safeStep)
                      ? 'Mark every load and unload here done and go to the next'
                      : 'Mark this stop done and go to the next'
                  }
                  onClick={() => {
                    if (current && !doneGroups.has(safeStep)) onToggleDone(safeStep)
                    if (safeStep < maxStep) onStepChange(safeStep + 1)
                  }}
                >
                  Done
                </button>
              </span>
            </span>
          </div>
          <button
            type="button"
            className="ghost"
            disabled={safeStep >= maxStep}
            onClick={() => onStepChange(Math.min(maxStep, safeStep + 1))}
          >
            Next
          </button>
        </div>
        <div className="route-step-current">
          <div className="route-step-current-actions">
            <div className={`route-step-card load${loadsDone ? ' is-done' : ''}`}>
              <div className="route-step-card-head">
                <span className="route-step-card-title">
                  Loading <strong>{stepStats.loadScu} SCU</strong>
                </span>
                {loadMark.count > 0 && (
                  <StopComplete
                    all={loadMark.all}
                    partial={loadMark.partial}
                    locked={readOnly}
                    title="Mark every load here done"
                    onToggle={() => onToggleKind(safeStep, 'pickup')}
                  />
                )}
              </div>
              {stepStats.loads.length > 0 && (
                <ul className="route-step-actions">
                  {stepStats.loads.map((a, i) => (
                    <li key={`${a.missionId}-load-${i}`}>
                      <CargoLine
                        code={codeFor(a.missionId)}
                        commodity={a.commodity || 'Cargo'}
                        scu={Math.abs(a.cargoDelta)}
                        confirmed={a.confirmed}
                        balanced={a.balanced}
                        note={a.loadNote}
                        boxes={a.boxes}
                        kind="pickup"
                        marked={doneActions.has(
                          actionMarkKey(safeStep, current ? current.actions.indexOf(a) : i),
                        )}
                        locked={readOnly}
                        onNote={(note) => onLoadNote(a.missionId, a.commodity, note)}
                        onToggle={() =>
                          onToggleAction(safeStep, current ? current.actions.indexOf(a) : i)
                        }
                        showLabel={false}
                        amend={{
                          planned: Math.abs(a.cargoDelta),
                          maxUnitScu:
                            missions.find((m) => m.id === a.missionId)?.maxUnitScu ?? 8,
                          onApply: (scu, boxes) =>
                            onAmendPickup(a.missionId, a.locationId, scu, boxes, a.commodity),
                        }}
                      />
                    </li>
                ))}
              </ul>
              )}
            </div>

            <div className={`route-step-card unload${unloadsDone ? ' is-done' : ''}`}>
              <div className="route-step-card-head">
                <span className="route-step-card-title">
                  Unloading <strong>{stepStats.unloadScu} SCU</strong>
                </span>
                {unloadMark.count > 0 && (
                  <StopComplete
                    all={unloadMark.all}
                    partial={unloadMark.partial}
                    locked={readOnly}
                    title="Mark every unload here done"
                    onToggle={() => onToggleKind(safeStep, 'dropoff')}
                  />
                )}
              </div>
              {stepStats.unloads.length > 0 && (
                <ul className="route-step-actions">
                  {stepStats.unloads.map((a, i) => (
                    <li key={`${a.missionId}-unload-${i}`}>
                      <CargoLine
                        code={codeFor(a.missionId)}
                        commodity={a.commodity || a.missionName}
                        scu={Math.abs(a.cargoDelta)}
                        confirmed={a.confirmed}
                        balanced={a.balanced}
                        note={a.loadNote}
                        boxes={a.boxes}
                        kind="dropoff"
                        marked={doneActions.has(
                          actionMarkKey(safeStep, current ? current.actions.indexOf(a) : i),
                        )}
                        locked={readOnly}
                        onNote={(note) => onLoadNote(a.missionId, a.commodity, note)}
                        onToggle={() =>
                          onToggleAction(safeStep, current ? current.actions.indexOf(a) : i)
                        }
                        showLabel={false}
                      />
                    </li>
                ))}
              </ul>
              )}
            </div>
          </div>
        </div>

        <div className="route-step-foot">
          <div className="route-step-foot-col">
            <span className="route-step-group-label">Load</span>
            <div className="route-step-pair load">
              <div className="route-step-card">
                <span className="route-step-card-title">
                  Current{' '}
                  <strong className={stopDelta > 0 ? 'up' : stopDelta < 0 ? 'down' : ''}>
                    {stopDeltaLabel} SCU
                  </strong>
                </span>
                <strong>
                  {capacityScu > 0
                    ? `${stepStats.holdAfter}/${capacityScu} SCU`
                    : `${stepStats.holdAfter} SCU`}
                </strong>
                <p className="route-step-sub">hold after this stop</p>
              </div>
              <div className="route-step-card">
                <span>Remaining</span>
                <strong>{stepStats.remainingLoad} SCU</strong>
                <p className="route-step-sub">still to pick up</p>
              </div>
            </div>
          </div>
          <div className="route-step-foot-col">
            <span className="route-step-group-label">Stops</span>
            <div className="route-step-pair stops">
              <div className="route-step-card next">
                <div className="route-step-next-body">
                  <div className="route-step-card-head">
                    <span>Next</span>
                    {nextGroup && <ElevatorNote locationId={nextGroup.locationId} />}
                  </div>
                  <strong>{nextGroup?.locationName ?? (groups.length ? 'Done' : '—')}</strong>
                  {nextGroup && nextGroup.legDistance > 0 && (
                    <p className="route-step-sub">leg {formatDistance(nextGroup.legDistance)}</p>
                  )}
                  {nextGroup && nextGroup.actions.length > 0 && (
                    <ul className="route-step-next-cargo">
                      {nextGroup.actions.map((a, i) => (
                        <li key={`${a.missionId}-${a.kind}-${i}`}>
                          <span
                            className={`route-step-next-kind ${a.kind === 'pickup' ? 'load' : 'unload'}`}
                          >
                            {a.kind === 'pickup' ? 'Load' : 'Unload'}
                          </span>
                          <span className="route-step-next-cargo-name">
                            <MissionCode code={codeFor(a.missionId)} />
                            {a.commodity || a.missionName}{' '}
                            <span className="route-step-scu">
                              <ScuAmount
                                scu={Math.abs(a.cargoDelta)}
                                confirmed={a.confirmed}
                                balanced={a.balanced}
                                unit
                              />
                            </span>
                          </span>
                          <CargoSizeGroups boxes={a.boxes} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="route-step-card">
                <div className="route-step-card-head">
                  <span>
                    Remaining
                    <strong className="route-step-stop-count">
                      {stopsLeft} stop{stopsLeft === 1 ? '' : 's'}
                    </strong>
                  </span>
                  <strong>{formatDistance(stepStats.remainingDistance)}</strong>
                </div>
                {stopsLeft > 0 && (
                  <ul className="route-step-remain">
                    {groups.slice(safeStep + 1).map((g, i) => (
                      <li key={`${g.locationId}-${safeStep + 1 + i}`}>
                        <span>{g.locationName}</span>
                        <span>
                          {g.legDistance > 0 ? formatDistance(g.legDistance) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
        {completedCodes.length > 0 && (
          <div className="route-completed">
            {completedCodes.map((code) => (
              <span key={code} className="tag mission-done-tag">
                {code} Completed
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={`route-details${detailsOpen ? '' : ' collapsed'}`}>
        <div
          className="route-details-bar collapse-bar"
          role="button"
          tabIndex={0}
          aria-expanded={detailsOpen}
          aria-label={detailsOpen ? 'Hide route details' : 'Show route details'}
          onClick={() => setDetailsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setDetailsOpen((v) => !v)
            }
          }}
        >
          <span className="collapse-title">
            {detailsOpen
              ? 'Stops & details'
              : `Details · ${groups.length} stops · ${missionDone}/${missionTotal} missions · ${formatDistance(route.totalDistance)}`}
          </span>
          <span className="collapse-arrow" aria-hidden>
            {detailsOpen ? '▴' : '▾'}
          </span>
        </div>

        {detailsOpen && (
          <>
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
        <div
          className={missionTotal > 0 && missionDone === missionTotal ? 'is-complete' : ''}
          title={`${missionDone} of ${missionTotal} missions complete`}
        >
          <span>Missions</span>
          <strong>
            {missionDone}/{missionTotal}
          </strong>
        </div>
      </div>

      <div className="route-follow">
        <p className="hint">
          {readOnly
            ? 'This link is view only. Loads, unloads, and the current step update on their own.'
            : limited
              ? 'This link can update loads, unloads, and the remaining stops. Missions and the ship stay as shared.'
              : 'Mark each load or unload as you finish it. Done on a stop with more than one action marks every load and unload there. A mission is completed when every load and unload for it is marked. Done on the step bar marks this stop and moves on. Calculate rest keeps that cargo aboard and replans only what is left.'}
        </p>
        <div className="route-follow-actions">
          <button
            type="button"
            className="primary"
            disabled={readOnly || !canCalculateRest}
            onClick={() => onCalculateRest(safeStep)}
          >
            Calculate rest
          </button>
          <button
            type="button"
            className={`ghost${rearrange ? ' is-active' : ''}`}
            disabled={readOnly || groups.length - doneCount < 2}
            onClick={onToggleRearrange}
            aria-pressed={rearrange}
          >
            {rearrange ? 'Done rearranging' : 'Rearrange rest'}
          </button>
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
              [
                'stop-group',
                gi === safeStep ? 'current-step' : '',
                doneGroups.has(gi) ? 'is-done' : '',
              ]
                .filter(Boolean)
                .join(' ')
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
              <GroupDone
                name={g.locationName}
                all={doneGroups.has(gi)}
                partial={
                  !doneGroups.has(gi) &&
                  g.actions.some((_, actionIndex) =>
                    doneActions.has(actionMarkKey(gi, actionIndex)),
                  )
                }
                actionCount={g.actions.length}
                locked={readOnly}
                onToggle={() => onToggleDone(gi)}
              />
              {rearrange && gi >= doneCount && (
                <div className="stop-reorder">
                  <button
                    type="button"
                    className="ghost icon-btn"
                    disabled={gi <= doneCount}
                    onClick={() => onMoveGroup(gi, -1)}
                    title="Move up"
                    aria-label={`Move ${g.locationName} up`}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                      <path fill="currentColor" d="M7 14l5-5 5 5H7z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn"
                    disabled={gi >= groups.length - 1}
                    onClick={() => onMoveGroup(gi, 1)}
                    title="Move down"
                    aria-label={`Move ${g.locationName} down`}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                      <path fill="currentColor" d="M7 10l5 5 5-5H7z" />
                    </svg>
                  </button>
                </div>
              )}
              <ElevatorNote locationId={g.locationId} />
            </div>

            <ul className="action-list">
              {g.actions.map((a, ai) =>
                a.kind === 'pickup' ? (
                  <li
                    key={`${a.missionId}-${a.kind}-${ai}`}
                    className={`action pickup compact${
                      doneActions.has(actionMarkKey(gi, ai)) && !doneGroups.has(gi)
                        ? ' is-handled'
                        : ''
                    }`}
                  >
                    <span className="mini-badge pickup">IN</span>
                    <div className="action-body pickup-compact">
                      <CargoLine
                        code={codeFor(a.missionId)}
                        commodity={a.commodity || 'Cargo'}
                        scu={Math.abs(a.cargoDelta)}
                        confirmed={a.confirmed}
                        balanced={a.balanced}
                        note={a.loadNote}
                        boxes={a.boxes}
                        hold={a.cargoAfter}
                        kind="pickup"
                        marked={doneActions.has(actionMarkKey(gi, ai))}
                        locked={readOnly}
                        onNote={(note) => onLoadNote(a.missionId, a.commodity, note)}
                        onToggle={() => onToggleAction(gi, ai)}
                        amend={{
                          planned: Math.abs(a.cargoDelta),
                          maxUnitScu:
                            missions.find((m) => m.id === a.missionId)?.maxUnitScu ?? 8,
                          onApply: (scu, boxes) =>
                            onAmendPickup(a.missionId, a.locationId, scu, boxes, a.commodity),
                        }}
                      />
                    </div>
                  </li>
                ) : (
                  <li
                    key={`${a.missionId}-${a.kind}-${ai}`}
                    className={`action dropoff compact${
                      doneActions.has(actionMarkKey(gi, ai)) && !doneGroups.has(gi)
                        ? ' is-handled'
                        : ''
                    }`}
                  >
                    <span className="mini-badge dropoff">OUT</span>
                    <div className="action-body pickup-compact">
                      <CargoLine
                        code={codeFor(a.missionId)}
                        commodity={a.commodity || a.missionName}
                        scu={Math.abs(a.cargoDelta)}
                        confirmed={a.confirmed}
                        balanced={a.balanced}
                        note={a.loadNote}
                        boxes={a.boxes}
                        hold={a.cargoAfter}
                        kind="dropoff"
                        marked={doneActions.has(actionMarkKey(gi, ai))}
                        locked={readOnly}
                        onNote={(note) => onLoadNote(a.missionId, a.commodity, note)}
                        onToggle={() => onToggleAction(gi, ai)}
                      />
                    </div>
                  </li>
                ),
              )}
            </ul>
          </li>
        ))}
      </ol>
          </>
        )}
      </div>
    </>
  )
}

function LoadNote({
  note,
  onSave,
  locked = false,
}: {
  note?: string
  onSave: (note: string) => void
  locked?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(note ?? '')
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!open) setValue(note ?? '')
  }, [note, open])

  if (locked) return note ? <span className="load-note">{note}</span> : null

  if (!open) {
    return (
      <button
        type="button"
        className={`ghost load-note-toggle${note ? ' has-note' : ''}`}
        title={note ? `Load position: ${note}` : 'Add a load position note'}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
          <path
            fill="currentColor"
            d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 1.5V9h4.5L14 4.5zM8 12h8v1.5H8V12zm0 3.5h6V17H8v-1.5z"
          />
        </svg>
        <span className="load-note">{note || 'Note'}</span>
      </button>
    )
  }

  return (
    <input
      className="load-note-input"
      autoFocus
      maxLength={80}
      placeholder="Load position"
      aria-label="Load position"
      value={value}
      onChange={(e) => {
        setValue(e.target.value)
        onSave(e.target.value)
      }}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false
          setValue(note ?? '')
          setOpen(false)
          return
        }
        onSave(value)
        setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          cancelRef.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function ScuAmount({
  scu,
  confirmed,
  balanced,
  unit = false,
}: {
  scu: number
  confirmed?: boolean
  balanced?: boolean
  unit?: boolean
}) {
  return (
    <>
      {scu}
      {unit ? ' SCU' : ''}
      {confirmed ? (
        <span className="confirmed" title="Confirmed on site">
          {' '}
          ✓
        </span>
      ) : balanced ? (
        <span
          className="balanced-mark"
          title="Auto-calculated balance. Confirm the amount on site."
        >
          ?
        </span>
      ) : null}
    </>
  )
}

function MissionCode({ code, completed }: { code: string; completed?: boolean }) {
  if (!code && !completed) return null
  return (
    <>
      {code ? <span className="mission-code route-action-code">{code}</span> : null}
      {completed ? <span className="tag mission-done-tag">Completed</span> : null}
    </>
  )
}

function StopComplete({
  all,
  partial,
  locked,
  title,
  onToggle,
}: {
  all: boolean
  partial: boolean
  locked: boolean
  title: string
  onToggle: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial && !all
  }, [partial, all])
  return (
    <label className="route-step-complete" title={title}>
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        disabled={locked}
        onChange={onToggle}
        aria-label={title}
      />
    </label>
  )
}

function CargoLine({
  code,
  commodity,
  scu,
  confirmed,
  balanced,
  note,
  boxes,
  hold,
  kind,
  marked,
  locked,
  onNote,
  onToggle,
  showLabel = true,
  amend,
}: {
  code: string
  commodity: string
  scu: number
  confirmed?: boolean
  balanced?: boolean
  note?: string
  boxes?: number[]
  hold?: number
  kind: 'pickup' | 'dropoff'
  marked: boolean
  locked: boolean
  onNote: (note: string) => void
  onToggle: () => void
  showLabel?: boolean
  amend?: {
    planned: number
    maxUnitScu: number
    onApply: (scu: number, boxes: number[]) => void
  }
}) {
  return (
    <div
      className={`route-step-cargo is-${kind}${marked ? ' is-done' : ''}${showLabel ? ' has-label' : ''}`}
    >
      <span className="route-step-status" aria-hidden />
      <div className="route-step-cargo-body">
        <div className="route-step-cargo-main">
          <MissionCode code={code} />
          <span className="route-step-item">{commodity}</span>
          <span className="route-step-scu">
            <ScuAmount scu={scu} confirmed={confirmed} balanced={balanced} unit />
          </span>
          {hold != null && <span className="pickup-hold">hold {hold}</span>}
        </div>
        <div className="route-step-cargo-meta">
          <CargoSizeGroups boxes={boxes} />
        </div>
      </div>
      <div className="route-step-cargo-actions">
        <LoadNote note={note} locked={locked} onSave={onNote} />
        {amend && (
          <AmendPickup
            label={commodity}
            planned={amend.planned}
            boxes={boxes}
            maxUnitScu={amend.maxUnitScu}
            confirmed={Boolean(confirmed)}
            locked={locked}
            onApply={amend.onApply}
          />
        )}
      </div>
      {showLabel ? (
        <span className={`route-step-progress-label${marked ? ' is-on' : ''}`}>
          {kind === 'pickup' ? 'Loaded' : 'Unloaded'}
        </span>
      ) : null}
      <ActionProgress
        kind={kind}
        marked={marked}
        label={`${code} ${commodity}`}
        disabled={locked}
        boxOnly
        onToggle={onToggle}
      />
    </div>
  )
}

function ActionProgress({
  kind,
  marked,
  label,
  onToggle,
  disabled = false,
  boxOnly = false,
}: {
  kind: 'pickup' | 'dropoff'
  marked: boolean
  label: string
  onToggle: () => void
  disabled?: boolean
  boxOnly?: boolean
}) {
  const word = kind === 'pickup' ? 'Loaded' : 'Unloaded'
  return (
    <label className={`action-progress${marked ? ' is-on' : ''}${boxOnly ? ' is-box' : ''}`}>
      <input
        type="checkbox"
        checked={marked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`Mark ${label} ${word.toLowerCase()}`}
      />
      {boxOnly ? null : <span>{word}</span>}
    </label>
  )
}

function GroupDone({
  name,
  all,
  partial,
  actionCount,
  onToggle,
  locked = false,
}: {
  name: string
  all: boolean
  partial: boolean
  actionCount: number
  onToggle: () => void
  locked?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial
  }, [partial])
  return (
    <label
      className="stop-done"
      title={
        actionCount >= 2 && !all
          ? 'Mark every load and unload here done'
          : 'Mark this stop done'
      }
    >
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        disabled={locked}
        onChange={onToggle}
        aria-label={`Mark ${name} done`}
      />
      <span>Done</span>
    </label>
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
  locked = false,
}: {
  label?: string
  planned: number
  boxes?: number[]
  maxUnitScu?: number
  confirmed: boolean
  onApply: (scu: number, boxes: number[]) => void
  locked?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState(() => countsFromBoxes(boxes, planned, maxUnitScu))

  useEffect(() => {
    if (!open) setCounts(countsFromBoxes(boxes, planned, maxUnitScu))
  }, [boxes, planned, maxUnitScu, open])

  if (locked) return null

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
        title={confirmed ? 'Edit crates per size' : 'Edit the auto-balanced crates'}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
          <path
            fill="currentColor"
            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
          />
        </svg>
        Edit
      </button>

      {open &&
        createPortal(
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
                  onApply(total, countsToBoxes(counts))
                  close()
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </div>
  )
}
