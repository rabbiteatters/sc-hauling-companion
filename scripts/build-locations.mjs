import fs from 'fs'

const src =
  'C:/Users/Charles/.cursor/projects/c-Users-Charles-sc-hauling-companion/agent-tools/64c80665-f8be-41b6-b165-93ad6970d10d.txt'
const j = JSON.parse(fs.readFileSync(src, 'utf8'))

/** Map UEX names → our app ids + aliases */
const WANTED = [
  { id: 'arc-l1', match: /^ARC-L1 /, body: 'Stanton', type: 'rest', short: 'ARC-L1' },
  { id: 'crc-l1', match: /^CRU-L1 /, body: 'Stanton', type: 'rest', short: 'CRU-L1' },
  { id: 'hrc-l1', match: /^HUR-L1 /, body: 'Stanton', type: 'rest', short: 'HUR-L1' },
  { id: 'hrc-l2', match: /^HUR-L2 /, body: 'Stanton', type: 'rest', short: 'HUR-L2' },
  { id: 'mic-l1', match: /^MIC-L1 /, body: 'Stanton', type: 'rest', short: 'MIC-L1' },
  { id: 'everus-harbor', match: /^Everus Harbor$/, body: 'Hurston', type: 'station', short: 'Everus' },
  { id: 'baijini-point', match: /^Baijini Point$/, body: 'ArcCorp', type: 'station', short: 'Baijini' },
  { id: 'port-tressler', match: /^Port Tressler$/, body: 'microTech', type: 'station', short: 'Tressler' },
  { id: 'seraphim', match: /^Seraphim Station$/, body: 'Crusader', type: 'station', short: 'Seraphim' },
  { id: 'grim-hex', match: /^GrimHEX$/, body: 'Crusader', type: 'station', short: 'Grim HEX' },
  { id: 'orison', match: /^Orison$/, body: 'Crusader', type: 'city', short: 'Orison' },
  { id: 'ruin-station', match: /^Ruin Station$/, body: 'Pyro VI', type: 'station', short: 'Ruin' },
  { id: 'checkmate', match: /^Checkmate Station$/, body: 'Pyro II', type: 'station', short: 'Checkmate' },
  { id: 'gaslight', match: /^Gaslight$/, body: 'Pyro V', type: 'station', short: 'Gaslight' },
  { id: 'starlight', match: /^Starlight Service Station$/, body: 'Pyro III', type: 'station', short: 'Starlight' },
  { id: 'rats-nest', match: /^Rat's Nest$/, body: 'Pyro V', type: 'station', short: "Rat's Nest" },
  { id: 'megumi', match: /^Megumi Refueling$/, body: 'Pyro VI', type: 'station', short: 'Megumi' },
  { id: 'dudley', match: /^Dudley & Daughters$/, body: 'Pyro VI', type: 'station', short: 'Dudley' },
  { id: 'patch-city', match: /^Patch City$/, body: 'Pyro III', type: 'station', short: 'Patch City' },
  { id: 'endgame', match: /^Endgame$/, body: 'Pyro VI', type: 'station', short: 'Endgame' },
  { id: 'rods-fuel', match: /^Rod's Fuel/, body: 'Pyro V', type: 'station', short: "Rod's Fuel" },
]

// Also pull a few more common Stanton cities if present
const EXTRA = [
  { id: 'lorville', match: /^Lorville$/, body: 'Hurston', type: 'city', short: 'Lorville' },
  { id: 'area18', match: /^Area ?18$/, body: 'ArcCorp', type: 'city', short: 'Area 18' },
  { id: 'new-babbage', match: /^New Babbage$/, body: 'microTech', type: 'city', short: 'New Babbage' },
  { id: 'port-olisar', match: /^Port Olisar$/, body: 'Crusader', type: 'station', short: 'Olisar' },
]

const allWanted = [...WANTED, ...EXTRA]
const out = []

for (const w of allWanted) {
  const loc = j.locations.find((l) => w.match.test(l.name) && l.x != null)
  if (!loc) {
    console.warn('missing', w.id)
    continue
  }
  // Store as Gm (1e9 m) — same unit sc-hauling.tools reports
  out.push({
    id: w.id,
    name: loc.name,
    shortName: w.short,
    body: w.body,
    type: w.type,
    x: loc.x / 1e9,
    y: loc.y / 1e9,
    z: (loc.z ?? 0) / 1e9,
    system: loc.system,
    aliases: [loc.code, loc.name].filter(Boolean),
  })
}

fs.writeFileSync('src/data/uex-locations.json', JSON.stringify(out, null, 2))
console.log('wrote', out.length, 'locations')
