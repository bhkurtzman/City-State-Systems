import type { Structure } from "@/lib/buildings"
import type { OfficeCrew } from "@/lib/construction"
import type { PropertyLine } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { formatTons, GOODS, type Farms, type Good } from "@/lib/produce"
import { Feature, Terrain } from "@/lib/types"

/** Man-hours one laborer can spend in a month. Unused hours are not kept. */
export const MONTHLY_HOURS = 100
const YEARLY_HOURS = MONTHLY_HOURS * 12
const CART_BASE = 10
/** Hundredths. A farmstead's clearing cut is 2 t of woodland or 5 t of forest. */
const WOODLAND_YIELD = 200
const FOREST_YIELD = 500
const WETLAND_WOOD = 100
const SUPPLY_LOT = 10

export type RoadTile = {
  index: number
  projectId: number
  spent: number
  hours: number
  /** Hundredths of wood added to the office pantry when the tile is finished. */
  woodYield: number
  /** Hundredths of wood taken from the pantry when the tile is finished. */
  woodNeed: number
  /** Woodland and forest become prairie. Scrub and wetland stay. */
  clear: boolean
}

export type RoadProject = {
  id: number
  /** Packed indexes, in the order the path was drawn. */
  tiles: number[]
  /** Construction office structure id, or null when nobody is on the job. */
  officeId: number | null
}

export type RoadBook = {
  nextId: number
  projects: RoadProject[]
  tiles: RoadTile[]
  /** Office structure id and the calendar year it last spent a man-hour. */
  worked: { structureId: number; year: number }[]
}

export type StateNeed = { structureId: number; good: Good; hundredths: number }

export function emptyRoads(): RoadBook {
  return { nextId: 1, projects: [], tiles: [], worked: [] }
}

export function paintRoad(
  book: RoadBook,
  cells: readonly { x: number; y: number }[],
  size: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  blocked: (index: number) => boolean,
  offices: readonly OfficeCrew[],
  structures: readonly Structure[],
): RoadBook {
  let next = book
  let run: number[] = []
  let carry: number | null = null
  const flush = () => {
    if (run.length === 0) return
    const touch = new Set<number>()
    if (carry !== null) touch.add(carry)
    for (const index of run) {
      for (const neighbor of beside(index, size)) {
        const tile = tileAt(next, neighbor)
        if (tile) touch.add(tile.projectId)
      }
    }
    const absorbed = absorb(next, [...touch], run, terrain, feature, offices, structures)
    next = absorbed.book
    carry = absorbed.projectId
    run = []
  }
  for (const cell of cells) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= size || cell.y >= size) {
      flush()
      carry = null
      continue
    }
    const index = cell.y * size + cell.x
    const existing = tileAt(next, index)
    if (existing) {
      flush()
      carry = existing.projectId
      continue
    }
    if (!openGround(terrain, index, blocked)) {
      flush()
      carry = null
      continue
    }
    run.push(index)
  }
  flush()
  return assignOffices(next, offices, structures)
}

export function eraseRoad(
  book: RoadBook,
  cells: readonly { x: number; y: number }[],
  size: number,
  offices: readonly OfficeCrew[],
  structures: readonly Structure[],
): RoadBook {
  const drop = new Set<number>()
  for (const cell of cells) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= size || cell.y >= size) continue
    drop.add(cell.y * size + cell.x)
  }
  if (drop.size === 0) return book
  const affected = new Set<number>()
  for (const tile of book.tiles) if (drop.has(tile.index)) affected.add(tile.projectId)
  if (affected.size === 0) return book
  let nextId = book.nextId
  const projects: RoadProject[] = []
  for (const project of book.projects) {
    if (!affected.has(project.id)) {
      projects.push(project)
      continue
    }
    const kept = project.tiles.filter((index) => !drop.has(index))
    const parts = components(kept, size)
    const hoursOf = (indexes: readonly number[]) =>
      indexes.reduce((sum, index) => {
        const tile = book.tiles.find((item) => item.index === index)
        return sum + (tile ? Math.max(0, tile.hours - tile.spent) : 0)
      }, 0)
    parts.sort((a, b) => hoursOf(b) - hoursOf(a) || b.length - a.length || a[0] - b[0])
    parts.forEach((tiles, part) => {
      projects.push({
        id: part === 0 ? project.id : nextId++,
        tiles,
        officeId: part === 0 ? project.officeId : null,
      })
    })
  }
  const live = new Set(projects.map((project) => project.id))
  const tiles = book.tiles.filter((tile) => !drop.has(tile.index) && live.has(tile.projectId))
  return assignOffices({ ...book, nextId, projects, tiles }, offices, structures)
}

/** Offices with a crew take unfinished paths. The soonest finish wins, then the smaller crew. */
export function assignOffices(book: RoadBook, offices: readonly OfficeCrew[], structures: readonly Structure[]): RoadBook {
  const ready = new Map(availableOffices(offices, structures).map((office) => [office.structureId, office]))
  const projects = book.projects.map((project) => ({ ...project, tiles: [...project.tiles] }))
  for (const project of projects) {
    if (remaining(book, project) <= 0 || !project.officeId || !ready.has(project.officeId)) project.officeId = null
  }
  const busy = () => new Set(projects.map((project) => project.officeId).filter((id): id is number => id !== null))
  for (const project of [...projects].sort((a, b) => a.id - b.id)) {
    if (project.officeId !== null || remaining(book, project) <= 0) continue
    const taken = busy()
    const choice = pickOffice(
      [...ready.values()].filter((office) => !taken.has(office.structureId)),
      remaining(book, project),
    )
    project.officeId = choice?.structureId ?? null
  }
  return { ...book, projects }
}

export function projectAt(book: RoadBook, index: number): RoadProject | null {
  const tile = tileAt(book, index)
  if (!tile) return null
  return book.projects.find((project) => project.id === tile.projectId) ?? null
}

export function projectOfOffice(book: RoadBook, structureId: number): RoadProject | null {
  return book.projects.find((project) => project.officeId === structureId && remaining(book, project) > 0) ?? null
}

export function projectLines(
  book: RoadBook,
  project: RoadProject,
  offices: readonly OfficeCrew[],
  wage: number,
  woodPrice: number,
  pantryWood: number,
): PropertyLine[] {
  const tiles = project.tiles.map((index) => tileAt(book, index)).filter((tile): tile is RoadTile => tile !== null)
  const total = tiles.reduce((sum, tile) => sum + tile.hours, 0)
  const left = tiles.reduce((sum, tile) => sum + Math.max(0, tile.hours - tile.spent), 0)
  const spent = total - left
  const need = tiles.reduce((sum, tile) => sum + (tile.spent >= tile.hours ? 0 : tile.woodNeed), 0)
  const yieldWood = tiles.reduce((sum, tile) => sum + (tile.spent >= tile.hours ? 0 : tile.woodYield), 0)
  const buy = Math.max(0, need - yieldWood - Math.max(0, pantryWood))
  const office = project.officeId === null ? null : offices.find((item) => item.structureId === project.officeId) ?? null
  const monthly = (office?.crew.length ?? 0) * MONTHLY_HOURS
  const status = left <= 0 ? "Finished" : spent > 0 ? "Building" : "Planned"
  const months = monthly > 0 ? Math.ceil(left / monthly) : 0
  return [
    { label: "Kind", value: "Cart Path" },
    { label: "Status", value: status },
    { label: "Tiles", value: `${tiles.length}` },
    { label: "Man-hours", value: left === total ? `${total}` : `${left} left of ${total}` },
    { label: "Wood needed", value: need > 0 ? formatTons(need) : "None" },
    { label: "Wood from clearing", value: yieldWood > 0 ? formatTons(yieldWood) : "None" },
    { label: "Resource cost", value: money(Math.round((woodPrice * buy) / 100)) },
    { label: "Labor cost", value: money(Math.round((Math.max(0, wage) / YEARLY_HOURS) * total)) },
    { label: "Time", value: left <= 0 ? "Finished" : monthly > 0 ? `${months} month${months === 1 ? "" : "s"}` : "No crew" },
    { label: "Office", value: project.officeId === null ? "None" : `Office ${project.officeId}` },
  ]
}

/** Wood the project cannot cover, plus a November top-up of tools and leather to 0.1 t. */
export function supplyOrders(book: RoadBook, farms: Farms, structures: readonly Structure[], month: number): StateNeed[] {
  const orders: StateNeed[] = []
  const standing = structures.filter((structure) => structure.kind === "construction-office" && !structure.pending && !structure.removing)
  for (const structure of standing) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row) continue
    if (month === 10) {
      for (const good of ["steel-tools", "leather"] as const) {
        const held = row.store[good] ?? 0
        if (held < SUPPLY_LOT) orders.push({ structureId: structure.id, good, hundredths: SUPPLY_LOT - held })
      }
    }
    const project = projectOfOffice(book, structure.id)
    if (!project) continue
    const tiles = project.tiles.map((index) => tileAt(book, index)).filter((tile): tile is RoadTile => tile !== null)
    const need = tiles.reduce((sum, tile) => sum + (tile.spent >= tile.hours ? 0 : tile.woodNeed), 0)
    const yieldWood = tiles.reduce((sum, tile) => sum + (tile.spent >= tile.hours ? 0 : tile.woodYield), 0)
    const short = need - yieldWood - (row.store.wood ?? 0)
    if (short > 0) orders.push({ structureId: structure.id, good: "wood", hundredths: short })
  }
  return orders
}

/** Offices with wood and no unfinished path. A workshop or market may buy that wood. */
export function idleOffices(book: RoadBook, farms: Farms): number[] {
  const busy = new Set(book.projects.filter((project) => project.officeId !== null && remaining(book, project) > 0).map((project) => project.officeId as number))
  const ids: number[] = []
  for (const row of farms.rows) {
    if (row.owner >= 0 || busy.has(row.structureId) || (row.store.wood ?? 0) <= 0) continue
    ids.push(row.structureId)
  }
  return ids
}

/**
 * Spend each assigned office's man-hours. Finished woodland and forest become
 * prairie and put their wood in the pantry. Wetland takes its wood then.
 * In December an office that worked this year may use tools and leather.
 */
export function runRoads(
  book: RoadBook,
  farms: Farms,
  featureIn: Uint8Array,
  offices: readonly OfficeCrew[],
  structures: readonly Structure[],
  month: number,
  year: number,
  seed: string,
): { book: RoadBook; farms: Farms; feature: Uint8Array; changedLand: boolean } {
  const assigned = assignOffices(book, offices, structures)
  const rows = farms.rows.map((row) => ({ ...row, store: { ...row.store } }))
  const nextFarms: Farms = { rows }
  let feature = featureIn
  let changed = false
  const write = () => {
    if (changed) return
    feature = new Uint8Array(featureIn)
    changed = true
  }
  const tiles = assigned.tiles.map((tile) => ({ ...tile }))
  const projects = assigned.projects.map((project) => ({ ...project }))
  const worked = assigned.worked.map((item) => ({ ...item }))
  const tileOf = new Map(tiles.map((tile) => [tile.index, tile]))

  for (const project of [...projects].sort((a, b) => a.id - b.id)) {
    if (project.officeId === null) continue
    const office = offices.find((item) => item.structureId === project.officeId)
    let budget = (office?.crew.length ?? 0) * MONTHLY_HOURS
    if (budget <= 0) continue
    const row = rows.find((item) => item.structureId === project.officeId)
    let spent = 0
    let moved = true
    while (budget > 0 && moved) {
      moved = false
      for (const index of project.tiles) {
        if (budget <= 0) break
        const tile = tileOf.get(index)
        if (!tile || tile.spent >= tile.hours) continue
        if (tile.woodNeed > (row?.store.wood ?? 0)) continue
        const step = Math.min(budget, tile.hours - tile.spent)
        tile.spent += step
        budget -= step
        spent += step
        moved = true
        if (tile.spent < tile.hours) continue
        if (row) {
          row.store.wood = (row.store.wood ?? 0) + tile.woodYield - tile.woodNeed
        }
        if (tile.clear) {
          write()
          feature[tile.index] = Feature.Prairie
        }
      }
    }
    if (spent > 0) {
      const prior = worked.find((item) => item.structureId === project.officeId)
      if (prior) prior.year = year
      else if (project.officeId !== null) worked.push({ structureId: project.officeId, year })
    }
    const finished = project.tiles.length > 0 && project.tiles.every((index) => {
      const tile = tileOf.get(index)
      return tile !== undefined && tile.spent >= tile.hours
    })
    if (finished) project.officeId = null
  }

  if (month === 11) {
    for (const office of offices) {
      const mark = worked.find((item) => item.structureId === office.structureId)
      if (!mark || mark.year !== year) continue
      const pairs = Math.floor(office.crew.length / 2)
      if (pairs <= 0) continue
      const row = rows.find((item) => item.structureId === office.structureId)
      if (!row) continue
      const rng = mulberry32(hashSeed(`${seed}:office-supplies:${office.structureId}:${year}`))
      if (rng() < Math.min(1, pairs * 0.1) && (row.store["steel-tools"] ?? 0) >= SUPPLY_LOT) {
        row.store["steel-tools"] = (row.store["steel-tools"] ?? 0) - SUPPLY_LOT
      }
      if (rng() < Math.min(1, pairs * 0.05) && (row.store.leather ?? 0) >= SUPPLY_LOT) {
        row.store.leather = (row.store.leather ?? 0) - SUPPLY_LOT
      }
    }
  }

  for (const row of rows) for (const good of GOODS) if ((row.store[good] ?? 0) < 0) row.store[good] = 0
  return {
    book: { ...assigned, projects, tiles, worked },
    farms: nextFarms,
    feature,
    changedLand: changed,
  }
}

export function roadCells(book: RoadBook): { index: number; done: boolean }[] {
  return book.tiles.map((tile) => ({ index: tile.index, done: tile.spent >= tile.hours }))
}

/** A straight east, west, north, or south line from the first cell toward the second. */
export function cardinalLine(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    const step = Math.sign(dx) || 1
    if (dx === 0) return [{ x: from.x, y: from.y }]
    for (let x = from.x; x !== to.x + step; x += step) cells.push({ x, y: from.y })
  } else {
    const step = Math.sign(dy)
    for (let y = from.y; y !== to.y + step; y += step) cells.push({ x: from.x, y })
  }
  return cells
}

function absorb(
  book: RoadBook,
  projectIds: readonly number[],
  fresh: readonly number[],
  terrain: Uint8Array,
  feature: Uint8Array,
  offices: readonly OfficeCrew[],
  structures: readonly Structure[],
): { book: RoadBook; projectId: number } {
  const ids = [...new Set(projectIds)].filter((id) => book.projects.some((project) => project.id === id)).sort((a, b) => a - b)
  const additions = fresh.filter((index) => !tileAt(book, index))
  if (ids.length === 0) {
    const id = book.nextId
    const tiles = additions.map((index) => makeTile(index, id, terrain, feature))
    const project: RoadProject = { id, tiles: additions, officeId: null }
    return {
      book: { ...book, nextId: id + 1, projects: [...book.projects, project], tiles: [...book.tiles, ...tiles] },
      projectId: id,
    }
  }
  const keep = ids[0]
  const rest = new Set(ids.slice(1))
  const order: number[] = []
  const seen = new Set<number>()
  const push = (index: number) => {
    if (seen.has(index)) return
    seen.add(index)
    order.push(index)
  }
  for (const project of book.projects) {
    if (project.id !== keep && !rest.has(project.id)) continue
    for (const index of project.tiles) push(index)
  }
  for (const index of additions) push(index)
  const moved = book.tiles.map((tile) => (rest.has(tile.projectId) ? { ...tile, projectId: keep } : tile))
  const created = additions.map((index) => makeTile(index, keep, terrain, feature))
  const held = new Map<number, RoadTile>()
  for (const tile of moved) if (tile.projectId === keep) held.set(tile.index, tile)
  for (const tile of created) held.set(tile.index, tile)
  let hours = 0
  for (const index of order) {
    const tile = held.get(index)
    if (tile) hours += Math.max(0, tile.hours - tile.spent)
  }
  const previous = new Set(
    book.projects.filter((project) => project.id === keep || rest.has(project.id)).map((project) => project.officeId).filter((id): id is number => id !== null),
  )
  const choice = pickOffice(
    availableOffices(offices, structures).filter((office) => previous.has(office.structureId)),
    Math.max(1, hours),
  )
  const projects = book.projects
    .filter((project) => !rest.has(project.id))
    .map((project) => (project.id === keep ? { ...project, tiles: order, officeId: choice?.structureId ?? null } : project))
  return { book: { ...book, projects, tiles: [...moved, ...created] }, projectId: keep }
}

function makeTile(index: number, projectId: number, terrain: Uint8Array, feature: Uint8Array): RoadTile {
  const cost = cartCost(terrain[index], feature[index])
  return { index, projectId, spent: 0, hours: cost.hours, woodYield: cost.woodYield, woodNeed: cost.woodNeed, clear: cost.clear }
}

/** Hill adds half the base. Scrub, woods, and wetland then add their own hours. */
function cartCost(ground: number, cover: number): { hours: number; woodYield: number; woodNeed: number; clear: boolean } {
  let hours = ground === Terrain.Hill ? 15 : CART_BASE
  let woodYield = 0
  let woodNeed = 0
  let clear = false
  if (cover === Feature.Scrub) hours += 10
  else if (cover === Feature.Woodland) {
    hours += 20
    woodYield = WOODLAND_YIELD
    clear = true
  } else if (cover === Feature.Forest) {
    hours += 50
    woodYield = FOREST_YIELD
    clear = true
  } else if (cover === Feature.Wetland) {
    hours += 30
    woodNeed = WETLAND_WOOD
  }
  return { hours, woodYield, woodNeed, clear }
}

function openGround(terrain: Uint8Array, index: number, blocked: (index: number) => boolean): boolean {
  if (blocked(index)) return false
  const ground = terrain[index]
  return ground !== Terrain.Sea && ground !== Terrain.Fresh && ground !== Terrain.Mountain
}

function availableOffices(offices: readonly OfficeCrew[], structures: readonly Structure[]): OfficeCrew[] {
  const standing = new Set(
    structures.filter((structure) => structure.kind === "construction-office" && !structure.pending && !structure.removing).map((structure) => structure.id),
  )
  return offices.filter((office) => standing.has(office.structureId) && office.crew.length > 0)
}

function pickOffice(offices: readonly OfficeCrew[], hours: number): OfficeCrew | null {
  let best: OfficeCrew | null = null
  let bestMonths = Number.POSITIVE_INFINITY
  let bestCrew = Number.POSITIVE_INFINITY
  for (const office of offices) {
    const months = Math.ceil(hours / (office.crew.length * MONTHLY_HOURS))
    const crew = office.crew.length
    const better =
      months < bestMonths ||
      (months === bestMonths && crew < bestCrew) ||
      (months === bestMonths && crew === bestCrew && (best === null || office.structureId < best.structureId))
    if (!better) continue
    best = office
    bestMonths = months
    bestCrew = crew
  }
  return best
}

function remaining(book: RoadBook, project: RoadProject): number {
  let left = 0
  for (const index of project.tiles) {
    const tile = tileAt(book, index)
    if (!tile) continue
    left += Math.max(0, tile.hours - tile.spent)
  }
  return left
}

function tileAt(book: RoadBook, index: number): RoadTile | undefined {
  return book.tiles.find((tile) => tile.index === index)
}

function beside(index: number, size: number): number[] {
  const x = index % size
  const y = (index - x) / size
  const found: number[] = []
  if (x > 0) found.push(index - 1)
  if (x + 1 < size) found.push(index + 1)
  if (y > 0) found.push(index - size)
  if (y + 1 < size) found.push(index + size)
  return found
}

function components(tiles: readonly number[], size: number): number[][] {
  const left = new Set(tiles)
  const parts: number[][] = []
  for (const start of tiles) {
    if (!left.has(start)) continue
    const part: number[] = []
    const queue = [start]
    left.delete(start)
    while (queue.length > 0) {
      const index = queue.shift() as number
      part.push(index)
      for (const neighbor of beside(index, size)) {
        if (!left.has(neighbor)) continue
        left.delete(neighbor)
        queue.push(neighbor)
      }
    }
    parts.push(part)
  }
  parts.sort((a, b) => b.length - a.length || a[0] - b[0])
  return parts
}

function money(dollars: number): string {
  return `$${Math.max(0, Math.round(dollars)).toLocaleString("en-US")}`
}
