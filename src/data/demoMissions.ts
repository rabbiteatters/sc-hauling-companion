import { createMission, formatDemoMissionCode } from '../lib/spread'
import { ensureLocation } from '../store/catalog'
import type { Mission } from '../types'

function loc(...names: string[]): string[] {
  return names.map((n) => ensureLocation(n).id)
}

type DemoSeed = Omit<
  Parameters<typeof createMission>[0],
  'code' | 'source' | 'id'
>

/** Sample Red Wind stellar medium hauls — resolved against live location catalog. */
function demoSeeds(): DemoSeed[] {
  return [
    {
      name: '(DEMO) Experienced | Stellar Medium Haul | to Ruin Station (Carbon 196)',
      haulType: 'Stellar Medium Haul',
      commodity: 'Carbon',
      totalScu: 196,
      maxUnitScu: 8,
      rewardAuec: 958250,
      pickupIds: loc('Checkmate Station', 'Gaslight', 'Starlight Service Station'),
      dropoffIds: loc('Ruin Station'),
    },
    {
      name: '(DEMO) Experienced | Stellar Medium Haul | to Ruin Station (Carbon 178)',
      haulType: 'Stellar Medium Haul',
      commodity: 'Carbon',
      totalScu: 178,
      maxUnitScu: 8,
      rewardAuec: 958250,
      pickupIds: loc(
        'Starlight Service Station',
        "Rat's Nest",
        'Megumi Refueling',
        'Dudley & Daughters',
      ),
      dropoffIds: loc('Ruin Station'),
    },
    {
      name: '(DEMO) Experienced | Stellar Medium Haul | to Ruin Station (Potassium 162)',
      haulType: 'Stellar Medium Haul',
      commodity: 'Potassium',
      totalScu: 162,
      maxUnitScu: 16,
      rewardAuec: 958250,
      pickupIds: loc('Patch City', 'Megumi Refueling', 'Endgame', 'Dudley & Daughters'),
      dropoffIds: loc('Ruin Station'),
    },
    {
      name: '(DEMO) Experienced | Stellar Medium Haul | to Ruin Station (Potassium 126)',
      haulType: 'Stellar Medium Haul',
      commodity: 'Potassium',
      totalScu: 126,
      maxUnitScu: 8,
      rewardAuec: 958250,
      pickupIds: loc(
        "Rod's Fuel 'N Supplies",
        'Patch City',
        'Endgame',
        'Megumi Refueling',
      ),
      dropoffIds: loc('Ruin Station'),
    },
  ]
}

export const DEMO_MISSION_COUNT = 4

/** One demo sample by index (wraps). Pass `code` when appending to an existing list. */
export function createDemoMission(index: number, code?: string): Mission {
  const seeds = demoSeeds()
  const seed = seeds[((index % seeds.length) + seeds.length) % seeds.length]
  return createMission({
    ...seed,
    code: code ?? formatDemoMissionCode((index % seeds.length) + 1),
    source: 'demo',
  })
}

export function createDemoMissions(): Mission[] {
  return demoSeeds().map((_, i) => createDemoMission(i, formatDemoMissionCode(i + 1)))
}
