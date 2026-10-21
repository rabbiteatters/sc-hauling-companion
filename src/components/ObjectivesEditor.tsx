import { useEffect, useState } from 'react'
import type { CommodityInfo } from '../api/uex'
import { MAX_HAUL_STOPS, reconcileHaulStops } from '../lib/haulTypes'
import {
  applyObjectiveTotalDelta,
  changeObjectiveLocationIds,
  createEmptyObjective,
  missionTotalScu,
  moveObjective,
  objectiveLoadBalance,
  objectiveSummaryLine,
  setObjectiveStopScu,
  setObjectiveTotal,
  spreadObjectiveSide,
  type DraftObjective,
} from '../lib/objectives'
import { locationLabel } from '../store/catalog'
import type { Location, MissionObjective } from '../types'
import { CommodityPicker } from './CommodityPicker'
import { LocationPicker } from './LocationPicker'

interface Props {
  idPrefix: string
  objectives: DraftObjective[]
  maxUnitScu: number
  locations: Location[]
  commodities: CommodityInfo[]
  onChange: (next: DraftObjective[]) => void
}

export function ObjectivesEditor({
  idPrefix,
  objectives,
  maxUnitScu,
  locations,
  commodities,
  onChange,
}: Props) {
  const list = objectives.length
    ? objectives
    : [createEmptyObjective({ commodity: '', totalScu: 0 })]

  const [reorderUnlocked, setReorderUnlocked] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(list[0]?.id ?? null)
  /** Which side sum to highlight while hovering a Total +/- chip */
  const [highlightSide, setHighlightSide] = useState<
    'pickup' | 'dropoff' | 'both' | null
  >(null)

  const listIds = list.map((o) => o.id).join('|')
  const listCargoSig = list
    .map(
      (o) =>
        `${o.id}:${o.commodity}:${o.totalScu}:${o.pickups.map((p) => p.locationId).join(',')}:${o.dropoffs.map((d) => d.locationId).join(',')}`,
    )
    .join(';')

  function patchAt(index: number, nextObj: MissionObjective) {
    onChange(list.map((o, i) => (i === index ? nextObj : o)))
  }

  function clearDeltaHighlight() {
    setHighlightSide(null)
  }

  function preferExpandedId(nextList: DraftObjective[]): string | null {
    if (!nextList.length) return null
    const withStops = nextList.find(
      (o) => o.pickups.length > 0 && o.dropoffs.length > 0,
    )
    return withStops?.id ?? nextList[0].id
  }

  function addObjective() {
    const obj = createEmptyObjective({ commodity: '', totalScu: 0 })
    onChange([...list, obj])
    setExpandedId(obj.id)
  }

  function removeObjective(index: number) {
    if (list.length <= 1) return
    const removed = list[index]
    const next = list.filter((_, i) => i !== index)
    onChange(next)
    if (expandedId === removed.id) {
      setExpandedId(preferExpandedId(next))
    }
  }

  // After OCR / replace, expand a filled objective (ids often change)
  useEffect(() => {
    if (!list.length) {
      setExpandedId(null)
      return
    }
    if (!expandedId || !list.some((o) => o.id === expandedId)) {
      setExpandedId(preferExpandedId(list))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when list identity/cargo changes
  }, [listIds, listCargoSig])

  const sectionTotal = missionTotalScu(list)
  const expandedObj = list.find((o) => o.id === expandedId)
  const expandedChipCount = expandedObj
    ? buildDeltaChips(objectiveLoadBalance(expandedObj)).length
    : 0

  useEffect(() => {
    if (expandedChipCount === 0) clearDeltaHighlight()
  }, [expandedChipCount])

  return (
    <section className="objectives-section" aria-label="Objectives">
      <div className="objectives-section-head">
        <h3 className="objectives-section-title">
          {`Objectives · ${list.length} · ${sectionTotal} SCU`}
        </h3>
        <div className="panel-actions icon-actions objectives-section-actions">
          <button
            type="button"
            className={`ghost objective-reorder-toggle${reorderUnlocked ? ' is-active' : ''}`}
            title={
              reorderUnlocked ? 'Finish reordering' : 'Reorder objectives'
            }
            aria-label={
              reorderUnlocked ? 'Finish reordering' : 'Reorder objectives'
            }
            aria-pressed={reorderUnlocked}
            onClick={() => setReorderUnlocked((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path
                fill="currentColor"
                d="M8 7h3V4l4 4-4 4V9H8V7zm8 10h-3v3l-4-4 4-4v3h3v2z"
              />
            </svg>
            <span>{reorderUnlocked ? 'Done' : 'Reorder'}</span>
          </button>
          <button
            type="button"
            className="primary icon-btn add-btn"
            title="Add objective"
            aria-label="Add objective"
            onClick={addObjective}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="objectives-list">
        {list.map((obj, index) => {
          const expanded = expandedId === obj.id
          const balance = objectiveLoadBalance(obj)
          const pickupIds = obj.pickups.map((p) => p.locationId)
          const dropoffIds = obj.dropoffs.map((d) => d.locationId)
          const deltaChips = buildDeltaChips(balance)

          return (
            <section
              key={obj.id}
              className={`panel collapsible objective-panel${expanded ? '' : ' collapsed'}${balance.mismatch ? ' has-mismatch' : ''}`}
            >
              <div
                className="panel-head collapse-bar objective-collapse-bar"
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse objective' : 'Expand objective'}
                onClick={() =>
                  setExpandedId((id) => (id === obj.id ? null : obj.id))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setExpandedId((id) => (id === obj.id ? null : obj.id))
                  }
                }}
              >
                {reorderUnlocked ? (
                  <div
                    className="objective-reorder"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="ghost icon-btn"
                      disabled={index === 0}
                      title="Move up"
                      aria-label="Move up"
                      onClick={() => onChange(moveObjective(list, index, -1))}
                    >
                      ▴
                    </button>
                    <button
                      type="button"
                      className="ghost icon-btn"
                      disabled={index >= list.length - 1}
                      title="Move down"
                      aria-label="Move down"
                      onClick={() => onChange(moveObjective(list, index, 1))}
                    >
                      ▾
                    </button>
                  </div>
                ) : null}

                <h4
                  className={`collapse-title objective-collapse-title${balance.mismatch ? ' is-mismatch' : ''}`}
                >
                  {objectiveSummaryLine(obj)}
                </h4>

                <div
                  className="panel-actions icon-actions"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="ghost icon-btn danger"
                    disabled={list.length <= 1}
                    title="Remove objective"
                    aria-label="Remove objective"
                    onClick={() => removeObjective(index)}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M6 7h12v2H6V7zm2 3h2v8H8v-8zm3 0h2v8h-2v-8zm3 0h2v8h-2v-8zM9 4h6l1 1h4v2H4V5h4l1-1z"
                      />
                    </svg>
                  </button>
                </div>

                <span className="collapse-arrow" aria-hidden>
                  {expanded ? '▴' : '▾'}
                </span>
              </div>

              {expanded ? (
                <div className="objective-body">
                  <CommodityPicker
                    idPrefix={`${idPrefix}-obj-${obj.id}`}
                    commodities={commodities}
                    value={obj.commodity}
                    onChange={(commodity) =>
                      patchAt(index, { ...obj, commodity })
                    }
                  />

                  <div className="field-row objective-total-row">
                    <label
                      className={`field${balance.mismatch ? ' field-mismatch' : ''}`}
                    >
                      <span>Total SCU</span>
                      <div
                        className={`objective-total-input-wrap${balance.mismatch ? ' is-mismatch' : ''}`}
                      >
                        <input
                          type="number"
                          min={0}
                          className={balance.mismatch ? 'input-mismatch' : undefined}
                          value={obj.totalScu || ''}
                          placeholder="0"
                          aria-invalid={balance.mismatch}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            patchAt(
                              index,
                              setObjectiveTotal(
                                obj,
                                Number.isFinite(v) ? v : 0,
                                maxUnitScu,
                              ),
                            )
                          }}
                        />
                        {deltaChips.length > 0 ? (
                          <div className="objective-delta-overlay">
                            {deltaChips.map((chip) => (
                              <button
                                key={`${chip.side}-${chip.amount}`}
                                type="button"
                                className={`objective-delta-infield${chip.amount > 0 ? ' is-plus' : ' is-minus'}`}
                                title={chip.title}
                                onMouseEnter={() => setHighlightSide(chip.side)}
                                onMouseLeave={clearDeltaHighlight}
                                onFocus={() => setHighlightSide(chip.side)}
                                onBlur={clearDeltaHighlight}
                                onClick={() => {
                                  clearDeltaHighlight()
                                  patchAt(
                                    index,
                                    applyObjectiveTotalDelta(
                                      obj,
                                      chip.amount,
                                      maxUnitScu,
                                    ),
                                  )
                                }}
                              >
                                {chip.amount > 0
                                  ? `+${chip.amount}`
                                  : `${chip.amount}`}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </label>
                  </div>

                  {balance.message ? (
                    <p className="objective-mismatch-error" role="alert">
                      {balance.message}
                    </p>
                  ) : null}

                  <LocationPicker
                    legend="Pickups"
                    idPrefix={`${idPrefix}-obj-${obj.id}-p`}
                    locations={locations}
                    selectedIds={pickupIds}
                    peerSelectedCount={dropoffIds.length}
                    max={MAX_HAUL_STOPS}
                    onChange={(nextPickupIds) => {
                      const r = reconcileHaulStops(
                        nextPickupIds,
                        dropoffIds,
                        'pickup',
                      )
                      let next = changeObjectiveLocationIds(
                        obj,
                        'pickup',
                        r.pickupIds,
                        maxUnitScu,
                      )
                      if (r.dropoffIds.join() !== dropoffIds.join()) {
                        next = changeObjectiveLocationIds(
                          next,
                          'dropoff',
                          r.dropoffIds,
                          maxUnitScu,
                        )
                      }
                      patchAt(index, next)
                    }}
                  />
                  <StopScuList
                    side="pickup"
                    stops={obj.pickups}
                    mismatch={balance.pickMismatch}
                    sideSum={balance.pickSum}
                    totalScu={obj.totalScu}
                    highlighted={
                      expanded &&
                      (highlightSide === 'pickup' || highlightSide === 'both')
                    }
                    onScu={(locationId, scu) =>
                      patchAt(
                        index,
                        setObjectiveStopScu(
                          obj,
                          'pickup',
                          locationId,
                          scu,
                          maxUnitScu,
                        ),
                      )
                    }
                    onResetFromTotal={() =>
                      patchAt(
                        index,
                        spreadObjectiveSide(obj, 'pickup', maxUnitScu),
                      )
                    }
                  />

                  <LocationPicker
                    legend="Dropoffs"
                    idPrefix={`${idPrefix}-obj-${obj.id}-d`}
                    locations={locations}
                    selectedIds={dropoffIds}
                    peerSelectedCount={pickupIds.length}
                    max={MAX_HAUL_STOPS}
                    onChange={(nextDropoffIds) => {
                      const r = reconcileHaulStops(
                        pickupIds,
                        nextDropoffIds,
                        'dropoff',
                      )
                      let next = changeObjectiveLocationIds(
                        obj,
                        'dropoff',
                        r.dropoffIds,
                        maxUnitScu,
                      )
                      if (r.pickupIds.join() !== pickupIds.join()) {
                        next = changeObjectiveLocationIds(
                          next,
                          'pickup',
                          r.pickupIds,
                          maxUnitScu,
                        )
                      }
                      patchAt(index, next)
                    }}
                  />
                  <StopScuList
                    side="dropoff"
                    stops={obj.dropoffs}
                    mismatch={balance.dropMismatch}
                    sideSum={balance.dropSum}
                    totalScu={obj.totalScu}
                    highlighted={
                      expanded &&
                      (highlightSide === 'dropoff' || highlightSide === 'both')
                    }
                    onScu={(locationId, scu) =>
                      patchAt(
                        index,
                        setObjectiveStopScu(
                          obj,
                          'dropoff',
                          locationId,
                          scu,
                          maxUnitScu,
                        ),
                      )
                    }
                    onResetFromTotal={() =>
                      patchAt(
                        index,
                        spreadObjectiveSide(obj, 'dropoff', maxUnitScu),
                      )
                    }
                  />
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </section>
  )
}

function buildDeltaChips(balance: ReturnType<typeof objectiveLoadBalance>): {
  amount: number
  side: 'pickup' | 'dropoff' | 'both'
  title: string
}[] {
  const { pickDelta, dropDelta, pickSum, dropSum } = balance
  if (pickDelta == null && dropDelta == null) return []
  if (
    pickDelta != null &&
    dropDelta != null &&
    pickDelta === dropDelta
  ) {
    return [
      {
        amount: pickDelta,
        side: 'both',
        title: `Set total to ${pickSum} SCU (match pickups & dropoffs)`,
      },
    ]
  }
  const chips: {
    amount: number
    side: 'pickup' | 'dropoff' | 'both'
    title: string
  }[] = []
  if (pickDelta != null) {
    chips.push({
      amount: pickDelta,
      side: 'pickup',
      title: `Set total to pickups (${pickSum} SCU)`,
    })
  }
  if (dropDelta != null) {
    chips.push({
      amount: dropDelta,
      side: 'dropoff',
      title: `Set total to dropoffs (${dropSum} SCU)`,
    })
  }
  // Positive / larger amount on the left
  return chips.sort((a, b) => b.amount - a.amount)
}

function StopScuList({
  side,
  stops,
  mismatch,
  sideSum,
  totalScu,
  highlighted,
  onScu,
  onResetFromTotal,
}: {
  side: 'pickup' | 'dropoff'
  stops: { locationId: string; scu: number }[]
  mismatch: boolean
  sideSum: number
  totalScu: number
  highlighted?: boolean
  onScu: (locationId: string, scu: number) => void
  onResetFromTotal: () => void
}) {
  if (!stops.length) return null
  const outOfSync = sideSum !== totalScu
  return (
    <div
      className={`objective-stop-scu-block${mismatch ? ' is-mismatch' : ''}${highlighted ? ' is-delta-highlight' : ''}`}
    >
      <div className="objective-stop-scu-head">
        <span>{side === 'pickup' ? 'Pickup loads' : 'Dropoff loads'}</span>
        <div className="objective-stop-scu-sum-row">
          <span
            className={`objective-stop-scu-sum${mismatch ? ' is-mismatch' : ''}${highlighted ? ' is-delta-highlight' : ''}`}
          >
            Σ {sideSum} SCU
          </span>
          <button
            type="button"
            className={`ghost objective-sum-reset${outOfSync ? ' is-active' : ''}`}
            title={`Recalculate ${side} loads from Total (${totalScu} SCU)`}
            aria-label={`Recalculate ${side} loads from total`}
            onClick={onResetFromTotal}
          >
            Reset
          </button>
        </div>
      </div>
      <ul className="objective-stop-scu-list" aria-label={`${side} SCU`}>
        {stops.map((s) => (
          <li key={s.locationId} className="objective-stop-scu-row">
            <span
              className="objective-stop-scu-name"
              title={locationLabel(s.locationId)}
            >
              {locationLabel(s.locationId)}
            </span>
            <input
              type="number"
              min={0}
              className={`objective-stop-scu-input${mismatch ? ' input-mismatch' : ''}`}
              value={s.scu || ''}
              placeholder="0"
              aria-label={`SCU at ${locationLabel(s.locationId)}`}
              onChange={(e) => onScu(s.locationId, Number(e.target.value) || 0)}
            />
            <span className="objective-stop-scu-unit">SCU</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
