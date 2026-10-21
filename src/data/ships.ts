import type { Ship } from '../types'

/** Cargo SCU from public ship specs — verify in-game after patches. */
export const SHIPS: Ship[] = [
  { id: 'aurora-cl', name: 'Aurora CL', manufacturer: 'RSI', cargoScu: 6 },
  { id: 'avenger-titan', name: 'Avenger Titan', manufacturer: 'Aegis', cargoScu: 8 },
  { id: 'cutlass-black', name: 'Cutlass Black', manufacturer: 'Drake', cargoScu: 46 },
  { id: 'freelancer', name: 'Freelancer', manufacturer: 'MISC', cargoScu: 66 },
  { id: 'freelancer-max', name: 'Freelancer MAX', manufacturer: 'MISC', cargoScu: 120 },
  { id: 'zeus-cl', name: 'Zeus Mk II CL', manufacturer: 'RSI', cargoScu: 128 },
  { id: 'corsair', name: 'Corsair', manufacturer: 'Drake', cargoScu: 72 },
  { id: 'constellation-taurus', name: 'Constellation Taurus', manufacturer: 'RSI', cargoScu: 174 },
  { id: 'raft', name: 'RAFT', manufacturer: 'Argo', cargoScu: 192 },
  { id: 'hull-a', name: 'Hull A', manufacturer: 'MISC', cargoScu: 64 },
  { id: 'hull-b', name: 'Hull B', manufacturer: 'MISC', cargoScu: 384 },
  { id: 'caterpillar', name: 'Caterpillar', manufacturer: 'Drake', cargoScu: 576 },
  { id: 'c2-hercules', name: 'C2 Hercules', manufacturer: 'Crusader', cargoScu: 696 },
  { id: 'm2-hercules', name: 'M2 Hercules', manufacturer: 'Crusader', cargoScu: 522 },
  { id: 'a2-hercules', name: 'A2 Hercules', manufacturer: 'Crusader', cargoScu: 216 },
]

export function getShip(id: string): Ship | undefined {
  return SHIPS.find((s) => s.id === id)
}
