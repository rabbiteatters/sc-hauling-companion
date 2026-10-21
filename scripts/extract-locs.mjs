import fs from 'fs'

const p =
  'C:/Users/Charles/.cursor/projects/c-Users-Charles-sc-hauling-companion/agent-tools/64c80665-f8be-41b6-b165-93ad6970d10d.txt'
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
const keys = [
  'ruin',
  'checkmate',
  'gaslight',
  'starlight',
  'megumi',
  'dudley',
  'patch',
  'endgame',
  "rat's",
  'rats',
  "rod's",
  'rods',
  'lorville',
  'area 18',
  'orison',
  'new babbage',
  'everus',
  'baijini',
  'tressler',
  'seraphim',
  'grim',
  'olisar',
  'green glade',
  'ambitious',
  'faithful dream',
  'shallow frontier',
]
const hits = j.locations.filter(
  (l) => keys.some((k) => l.name.toLowerCase().includes(k)) && l.x != null,
)
console.log(JSON.stringify(hits, null, 2))
console.log('count', hits.length)
