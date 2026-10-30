import { Feature, Terrain } from "@/lib/types"

/** A settled farmstead stays within this many tiles. A larger draft is outlined and dropped. */
export const FARMSTEAD_CAP = 2000

export type PlopKind = "trading-post" | "workshop" | "market"
export type StructureKind = "farmstead" | "shack" | "construction-office" | PlopKind
export type BuildTool = StructureKind | "logging-camp" | "mining-camp" | "cart-path" | "delete"

export const BASIC_BUILDINGS: readonly { id: BuildTool; label: string; enabled: boolean }[] = [
  { id: "farmstead", label: "Farmstead", enabled: true },
  { id: "shack", label: "Shack", enabled: true },
  { id: "construction-office", label: "Construction Office", enabled: true },
  { id: "trading-post", label: "Trading Post", enabled: true },
  { id: "logging-camp", label: "Logging Camp", enabled: false },
  { id: "mining-camp", label: "Mining Camp", enabled: false },
  { id: "workshop", label: "Workshop", enabled: true },
  { id: "market", label: "Market", enabled: true },
]

export const PLOP_STYLE: Record<PlopKind, { fill: string; label: string }> = {
  "trading-post": { fill: "#6e4420", label: "TP" },
  workshop: { fill: "#e07a1a", label: "WS" },
  market: { fill: "#2c6cb5", label: "M" },
}

export const HOME_STYLE = { fill: "#2f8a3e", label: "H" }
export const SHACK_STYLE = { fill: HOME_STYLE.fill, label: "S" }
export const OFFICE_STYLE = { fill: "#e0b400", label: "CO" }
export const OFFICE_SPAN = 3

const STRUCTURE_NAME: Record<StructureKind, string> = {
  farmstead: "Farmstead",
  shack: "Shack",
  "construction-office": "Construction Office",
  "trading-post": "Trading Post",
  workshop: "Workshop",
  market: "Market",
}

export type Structure = {
  id: number
  kind: StructureKind
  /** Packed cell indexes, ascending. */
  tiles: number[]
  /** Tiles painted since the last month. A planned structure lists every tile here. */
  fresh: number[]
  pending: boolean
  removing: boolean
  /** Two packed cells, or null when a farmstead has no home yet. */
  home: [number, number] | null
}

export type Settlement = {
  nextId: number
  structures: Structure[]
}

export function emptySettlement(): Settlement {
  return { nextId: 1, structures: [] }
}

export function isPlop(tool: BuildTool | null): tool is PlopKind {
  return tool === "trading-post" || tool === "workshop" || tool === "market"
}

/** A building dropped by one click: a 2×2 shop, a 1×2 shack, or a 3×3 office. */
export function isPlaced(tool: BuildTool | null): tool is PlopKind | "shack" | "construction-office" {
  return isPlop(tool) || tool === "shack" || tool === "construction-office"
}

/** Prairie, scrub, or barren, and not a mountain. */
export function shackGround(terrain: Uint8Array, feature: Uint8Array, index: number): boolean {
  if (terrain[index] === Terrain.Mountain) return false
  const cover = feature[index]
  return cover === Feature.Prairie || cover === Feature.Scrub || cover === Feature.Barren
}

export type ShackPreview = { tiles: [number, number]; open: boolean }

/**
 * A 1×2 shack. The cell east of the click is used when that pair is on the map
 * and open. Otherwise the cell to the south. A closed pair is returned so the
 * ghost can draw red; null when neither pair fits on the map.
 */
export function shackPreview(
  x: number,
  y: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  blocked: (index: number) => boolean,
): ShackPreview | null {
  if (x < 0 || y < 0 || x >= size || y >= size) return null
  const origin = y * size + x
  const east = x + 1 < size ? ([origin, origin + 1] as [number, number]) : null
  const south = y + 1 < size ? ([origin, origin + size] as [number, number]) : null
  const open = (pair: [number, number]) => pair.every((index) => shackGround(terrain, feature, index) && !blocked(index))
  if (east && open(east)) return { tiles: east, open: true }
  if (south && open(south)) return { tiles: south, open: true }
  if (east) return { tiles: east, open: false }
  if (south) return { tiles: south, open: false }
  return null
}

export type OfficePreview = { tiles: number[]; open: boolean }

/** A 3×3 office with the click as the northwest corner. Null when the square leaves the map. */
export function officePreview(
  x: number,
  y: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  blocked: (index: number) => boolean,
): OfficePreview | null {
  if (x < 0 || y < 0 || x + OFFICE_SPAN > size || y + OFFICE_SPAN > size) return null
  const tiles: number[] = []
  for (let row = 0; row < OFFICE_SPAN; row++) {
    for (let column = 0; column < OFFICE_SPAN; column++) tiles.push((y + row) * size + (x + column))
  }
  const open = tiles.every((index) => !isWater(terrain, feature, index) && !blocked(index))
  return { tiles, open }
}

/** Sea, a lake, a river, or wetland. Lakes and rivers are both stored as fresh water. */
export function isWater(terrain: Uint8Array, feature: Uint8Array, index: number): boolean {
  const ground = terrain[index]
  if (ground === Terrain.Sea || ground === Terrain.Fresh) return true
  return feature[index] === Feature.Wetland
}

/** Northwest corner plus the other three cells, or null when the footprint leaves the map. */
export function plopTiles(x: number, y: number, size: number): number[] | null {
  if (x < 0 || y < 0 || x + 1 >= size || y + 1 >= size) return null
  const origin = y * size + x
  return [origin, origin + 1, origin + size, origin + size + 1]
}

export function structureAt(settlement: Settlement, index: number): Structure | null {
  return findStructure(settlement, index) ?? null
}

export function structureKindName(kind: StructureKind): string {
  return STRUCTURE_NAME[kind]
}

export function structureLabel(settlement: Settlement, index: number): string | null {
  const structure = structureAt(settlement, index)
  if (!structure) return null
  const name = structureKindName(structure.kind)
  if (structure.removing) return `${name}, removing`
  if (structure.pending || structure.fresh.includes(index)) return `${name}, planned`
  return name
}

/**
 * A 1×2 home on dry land. Flat ground wins, and a one-cell gap from the farm edge
 * wins when a pair can sit fully inside. Water never holds the house. The scan
 * starts at the northwest tile.
 */
export function placeHome(
  tiles: readonly number[],
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
): [number, number] | null {
  if (tiles.length < 2) return null
  const set = new Set(tiles)
  let best: [number, number] | null = null
  let bestScore = 4
  for (const index of tiles) {
    if (isWater(terrain, feature, index)) continue
    const x = index % size
    const y = (index - x) / size
    const others: number[] = []
    if (x + 1 < size && set.has(index + 1) && !isWater(terrain, feature, index + 1)) others.push(index + 1)
    if (y + 1 < size && set.has(index + size) && !isWater(terrain, feature, index + size)) others.push(index + size)
    for (const other of others) {
      const score = pairScore(index, other, set, terrain, size)
      if (score < bestScore) {
        bestScore = score
        best = [index, other]
      }
    }
  }
  return best
}

export function applyBuild(
  settlement: Settlement,
  tool: BuildTool | null,
  cells: readonly { x: number; y: number }[],
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  mode: "tap" | "stroke" | "place",
  latch: Set<number>,
  allowNew = false,
): Settlement {
  if (cells.length === 0 || tool === null) return settlement
  if (tool === "farmstead") {
    return mode === "tap"
      ? tapFarm(settlement, pack(cells[0], size), size, terrain, feature)
      : paintStroke(settlement, cells.map((cell) => pack(cell, size)), size, terrain, feature, allowNew)
  }
  if (tool === "delete") {
    return eraseStroke(
      settlement,
      cells.map((cell) => pack(cell, size)),
      size,
      terrain,
      feature,
      latch,
    )
  }
  if (mode === "place" && tool === "shack") {
    return placeShack(settlement, cells[0].x, cells[0].y, size, terrain, feature)
  }
  if (mode === "place" && tool === "construction-office") {
    return placeOffice(settlement, cells[0].x, cells[0].y, size, terrain, feature)
  }
  if (mode === "place" && isPlop(tool)) {
    return placePlop(settlement, cells[0].x, cells[0].y, size, tool, terrain, feature)
  }
  return settlement
}

/**
 * Drafts become real. A farmstead with no dry 1×2 for a house is dropped, including
 * one that is simply too small. A structure marked for removal is dropped. A house
 * that still sits on dry farm tiles is kept.
 */
export function commitSettlement(
  settlement: Settlement,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
): Settlement {
  const structures: Structure[] = []
  for (const structure of settlement.structures) {
    if (structure.removing) continue
    if (structure.kind === "farmstead") {
      let tiles = structure.tiles
      if (tiles.length > FARMSTEAD_CAP) {
        if (structure.pending) continue
        const planned = new Set(structure.fresh)
        tiles = tiles.filter((tile) => !planned.has(tile))
        if (tiles.length === 0) continue
      }
      const kept = structure.home && homeFits(structure.home, tiles) && dryPair(structure.home, terrain, feature)
      const home = kept ? structure.home : placeHome(tiles, terrain, feature, size)
      if (!home) continue
      structures.push({ ...structure, tiles, pending: false, fresh: [], removing: false, home })
      continue
    }
    structures.push({ ...structure, pending: false, fresh: [], removing: false })
  }
  return { ...settlement, structures }
}

function paintStroke(
  settlement: Settlement,
  indices: readonly number[],
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  allowNew: boolean,
): Settlement {
  let next = settlement
  let canCreate = allowNew
  for (const index of indices) {
    if (findStructure(next, index) || adjacentFarms(next, index, size).length > 0) canCreate = false
    const before = next
    next = addFarm(next, index, size, terrain, feature, canCreate)
    if (next !== before) canCreate = false
  }
  if (next === settlement) return settlement
  return closeFarms(next, size, terrain, feature)
}

function tapFarm(
  settlement: Settlement,
  index: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  const structure = findStructure(settlement, index)
  if (structure?.kind === "farmstead" && (structure.pending || structure.fresh.includes(index))) {
    return closeFarms(removeTile(settlement, structure, index, terrain, feature, size), size, terrain, feature)
  }
  const next = addFarm(settlement, index, size, terrain, feature, true)
  if (next === settlement) return settlement
  return closeFarms(next, size, terrain, feature)
}

function addFarm(
  settlement: Settlement,
  index: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  allowNew: boolean,
): Settlement {
  if (index < 0 || index >= size * size) return settlement
  if (findStructure(settlement, index)) return settlement
  const near = adjacentFarms(settlement, index, size)
  if (near.length === 0) {
    if (!allowNew) return settlement
    return append(settlement, {
      kind: "farmstead",
      tiles: [index],
      fresh: [index],
      pending: true,
      removing: false,
      home: null,
    })
  }
  const host = [...near].sort((a, b) => a.id - b.id)[0]
  const others = near.filter((structure) => structure.id !== host.id)
  const drop = new Set(others.map((structure) => structure.id))
  const tiles = uniqueSorted([index, ...host.tiles, ...others.flatMap((structure) => structure.tiles)])
  const pending = host.pending && others.every((structure) => structure.pending)
  const fresh = pending
    ? tiles
    : uniqueSorted([
        index,
        ...host.fresh,
        ...others.flatMap((structure) => (structure.pending ? structure.tiles : structure.fresh)),
      ])
  const merged = retile(host, tiles, fresh, pending, terrain, feature, size, false)
  return {
    ...settlement,
    structures: settlement.structures
      .filter((structure) => !drop.has(structure.id))
      .map((structure) => (structure.id === host.id ? merged : structure)),
  }
}

function eraseStroke(
  settlement: Settlement,
  indices: readonly number[],
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  latch: Set<number>,
): Settlement {
  let next = settlement
  for (const index of indices) {
    const structure = findStructure(next, index)
    if (!structure) continue
    if (structure.pending && structure.kind !== "farmstead") {
      next = { ...next, structures: next.structures.filter((item) => item.id !== structure.id) }
      continue
    }
    if (structure.pending || structure.fresh.includes(index)) {
      next = removeTile(next, structure, index, terrain, feature, size)
      continue
    }
    if (latch.has(structure.id)) continue
    latch.add(structure.id)
    next = {
      ...next,
      structures: next.structures.map((item) =>
        item.id === structure.id ? { ...item, removing: !item.removing } : item,
      ),
    }
  }
  if (next === settlement) return settlement
  return closeFarms(next, size, terrain, feature)
}

function placePlop(
  settlement: Settlement,
  x: number,
  y: number,
  size: number,
  kind: PlopKind,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  const tiles = plopTiles(x, y, size)
  if (!tiles) return settlement
  if (tiles.some((index) => isWater(terrain, feature, index) || findStructure(settlement, index))) return settlement
  return append(settlement, { kind, tiles, fresh: tiles, pending: true, removing: false, home: null })
}

function placeShack(
  settlement: Settlement,
  x: number,
  y: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  const preview = shackPreview(x, y, size, terrain, feature, (index) => findStructure(settlement, index) !== undefined)
  if (!preview?.open) return settlement
  return append(settlement, {
    kind: "shack",
    tiles: [...preview.tiles],
    fresh: [...preview.tiles],
    pending: true,
    removing: false,
    home: preview.tiles,
  })
}

function placeOffice(
  settlement: Settlement,
  x: number,
  y: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  const preview = officePreview(x, y, size, terrain, feature, (index) => findStructure(settlement, index) !== undefined)
  if (!preview?.open) return settlement
  return append(settlement, {
    kind: "construction-office",
    tiles: preview.tiles,
    fresh: preview.tiles,
    pending: true,
    removing: false,
    home: null,
  })
}

function removeTile(
  settlement: Settlement,
  structure: Structure,
  index: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
): Settlement {
  const current = settlement.structures.find((item) => item.id === structure.id) ?? structure
  const tiles = current.tiles.filter((tile) => tile !== index)
  if (tiles.length === 0) {
    return { ...settlement, structures: settlement.structures.filter((item) => item.id !== current.id) }
  }
  const groups = components(tiles, size)
  const freshTiles = new Set(current.fresh)
  let nextId = settlement.nextId
  const built = groups.map((group, groupIndex) => {
    const fresh = current.pending ? group : group.filter((tile) => freshTiles.has(tile))
    const shaped = retile(current, group, fresh, current.pending, terrain, feature, size, current.removing)
    if (groupIndex === 0) return { ...shaped, id: current.id }
    nextId += 1
    return { ...shaped, id: nextId - 1 }
  })
  return {
    nextId,
    structures: [...settlement.structures.filter((item) => item.id !== current.id), ...built],
  }
}

function components(tiles: readonly number[], size: number): number[][] {
  const remaining = new Set(tiles)
  const groups: number[][] = []
  for (const start of tiles) {
    if (!remaining.has(start)) continue
    const group: number[] = []
    const stack = [start]
    remaining.delete(start)
    while (stack.length > 0) {
      const index = stack.pop() as number
      group.push(index)
      for (const neighbor of edgeNeighbors(index, size)) {
        if (!remaining.has(neighbor)) continue
        remaining.delete(neighbor)
        stack.push(neighbor)
      }
    }
    groups.push(uniqueSorted(group))
  }
  return groups
}

/** A closed farmstead absorbs the unoccupied cells it surrounds. */
function closeFarms(
  settlement: Settlement,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  let next = settlement
  const ids = next.structures.filter((item) => item.kind === "farmstead" && !item.removing).map((item) => item.id)
  for (const id of ids) next = enclose(next, id, size, terrain, feature)
  return next
}

function enclose(
  settlement: Settlement,
  id: number,
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
): Settlement {
  const structure = settlement.structures.find((item) => item.id === id)
  if (!structure || structure.kind !== "farmstead" || structure.removing) return settlement
  if (structure.tiles.length < 8) return settlement

  let minX = size
  let minY = size
  let maxX = 0
  let maxY = 0
  const farm = new Set(structure.tiles)
  for (const index of structure.tiles) {
    const x = index % size
    const y = (index - x) / size
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  if (width * height <= structure.tiles.length) return settlement

  const local = (x: number, y: number) => (y - minY) * width + (x - minX)
  const seen = new Uint8Array(width * height)
  const stack: number[] = []
  const consider = (x: number, y: number) => {
    if (x < minX || y < minY || x > maxX || y > maxY) return
    const slot = local(x, y)
    if (seen[slot]) return
    if (farm.has(y * size + x)) return
    seen[slot] = 1
    stack.push(y * size + x)
  }
  for (let x = minX; x <= maxX; x++) {
    consider(x, minY)
    consider(x, maxY)
  }
  for (let y = minY; y <= maxY; y++) {
    consider(minX, y)
    consider(maxX, y)
  }
  while (stack.length > 0) {
    const index = stack.pop() as number
    const x = index % size
    const y = (index - x) / size
    consider(x - 1, y)
    consider(x + 1, y)
    consider(x, y - 1)
    consider(x, y + 1)
  }

  const occupied = new Set<number>()
  for (const other of settlement.structures) {
    if (other.id === structure.id) continue
    for (const tile of other.tiles) occupied.add(tile)
  }

  const queued = new Uint8Array(width * height)
  const queue: number[] = []
  const enqueue = (index: number) => {
    const x = index % size
    const y = (index - x) / size
    if (x < minX || y < minY || x > maxX || y > maxY) return
    const slot = local(x, y)
    if (seen[slot] || queued[slot] || farm.has(index) || occupied.has(index)) return
    queued[slot] = 1
    queue.push(index)
  }
  for (const index of structure.tiles) {
    const x = index % size
    const y = (index - x) / size
    if (x > minX) enqueue(index - 1)
    if (x < maxX) enqueue(index + 1)
    if (y > minY) enqueue(index - size)
    if (y < maxY) enqueue(index + size)
  }

  const added: number[] = []
  const merge = new Map<number, Structure>()
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]
    const near = adjacentFarms(settlement, index, size).filter((item) => item.id !== structure.id && !merge.has(item.id))
    added.push(index)
    for (const item of near) merge.set(item.id, item)
    const x = index % size
    const y = (index - x) / size
    if (x > minX) enqueue(index - 1)
    if (x < maxX) enqueue(index + 1)
    if (y > minY) enqueue(index - size)
    if (y < maxY) enqueue(index + size)
  }
  if (added.length === 0) return settlement

  const merged = [...merge.values()]
  const tiles = uniqueSorted([...structure.tiles, ...added, ...merged.flatMap((item) => item.tiles)])
  const pending = structure.pending && merged.every((item) => item.pending)
  const fresh = pending
    ? tiles
    : uniqueSorted([
        ...added,
        ...structure.fresh,
        ...merged.flatMap((item) => (item.pending ? item.tiles : item.fresh)),
      ])
  const shaped = retile(structure, tiles, fresh, pending, terrain, feature, size, structure.removing)
  return {
    ...settlement,
    structures: settlement.structures
      .filter((item) => !merge.has(item.id))
      .map((item) => (item.id === structure.id ? shaped : item)),
  }
}

function retile(
  structure: Structure,
  tiles: number[],
  fresh: number[],
  pending: boolean,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  removing: boolean,
): Structure {
  const home =
    !pending && structure.home && homeFits(structure.home, tiles) && dryPair(structure.home, terrain, feature)
      ? structure.home
      : placeHome(tiles, terrain, feature, size)
  return { ...structure, tiles, fresh, pending, removing, home }
}

function dryPair(home: [number, number], terrain: Uint8Array, feature: Uint8Array): boolean {
  return !isWater(terrain, feature, home[0]) && !isWater(terrain, feature, home[1])
}

function append(settlement: Settlement, structure: Omit<Structure, "id">): Settlement {
  return {
    nextId: settlement.nextId + 1,
    structures: [...settlement.structures, { ...structure, id: settlement.nextId }],
  }
}

function adjacentFarms(settlement: Settlement, index: number, size: number): Structure[] {
  const found = new Map<number, Structure>()
  for (const neighbor of edgeNeighbors(index, size)) {
    const structure = findStructure(settlement, neighbor)
    if (structure?.kind === "farmstead" && !structure.removing) found.set(structure.id, structure)
  }
  return [...found.values()]
}

function findStructure(settlement: Settlement, index: number): Structure | undefined {
  return settlement.structures.find((structure) => structure.tiles.includes(index))
}

function homeFits(home: [number, number], tiles: readonly number[]): boolean {
  const set = new Set(tiles)
  return set.has(home[0]) && set.has(home[1])
}

function pack(cell: { x: number; y: number }, size: number): number {
  return cell.y * size + cell.x
}

function edgeNeighbors(index: number, size: number): number[] {
  const x = index % size
  const y = (index - x) / size
  const out: number[] = []
  if (x > 0) out.push(index - 1)
  if (x + 1 < size) out.push(index + 1)
  if (y > 0) out.push(index - size)
  if (y + 1 < size) out.push(index + size)
  return out
}

function uniqueSorted(values: number[]): number[] {
  values.sort((a, b) => a - b)
  const out: number[] = []
  for (const value of values) {
    if (out.length === 0 || out[out.length - 1] !== value) out.push(value)
  }
  return out
}

function pairScore(a: number, b: number, tiles: Set<number>, terrain: Uint8Array, size: number): number {
  const flat = terrain[a] === Terrain.Flat && terrain[b] === Terrain.Flat
  const gap = inset(a, tiles, size) && inset(b, tiles, size)
  if (flat && gap) return 0
  if (flat) return 1
  if (gap) return 2
  return 3
}

/** Every edge neighbor is also part of the farm, so the cell sits one step in from the edge. */
function inset(index: number, tiles: Set<number>, size: number): boolean {
  const x = index % size
  const y = (index - x) / size
  if (x <= 0 || y <= 0 || x + 1 >= size || y + 1 >= size) return false
  return tiles.has(index - 1) && tiles.has(index + 1) && tiles.has(index - size) && tiles.has(index + size)
}
