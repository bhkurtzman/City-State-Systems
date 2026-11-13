import { coverClear, type Structure } from "@/lib/buildings"
import { HIRE_MAX_AGE, type Hire, type OfficeCrew } from "@/lib/construction"
import type { PropertyLine } from "@/lib/land"
import { noteOperatingIncome, OCCUPATION, Sex, type People } from "@/lib/people"
import { formatTons, GOOD_LABEL, type Farms, type Good } from "@/lib/produce"
import { Feature } from "@/lib/types"
import { MONTHLY_HOURS, projectOfOffice, type RoadBook } from "@/lib/roads"
import { WORKSHOP_HOURS, type WorkshopSite } from "@/lib/workshop"

/** Man-hours to raise a caravan house. The family pays the treasury for these up front. */
export const CARAVAN_HOURS = 1500
const YEARLY_HOURS = 1200
const HIRE_MIN_AGE = 18
const OUT_ONE = 20
const OUT_TWO = 40

const BUILD: readonly { good: Good; hundredths: number }[] = [
  { good: "lumber", hundredths: 4000 },
  { good: "steel-parts", hundredths: 40 },
  { good: "wagon-parts", hundredths: 100 },
]

/** One operating year with no teamsters yet: 5 t of grain, 0.01 t of leather, 0.01 t of tools, 0.1 t of wagon parts, 1 t of barrels, and 3 t of livestock. The livestock is bought, not granted. Family food is not included. */
const OPERATING: readonly { good: Good; hundredths: number }[] = [
  { good: "grain", hundredths: 500 },
  { good: "leather", hundredths: 1 },
  { good: "steel-tools", hundredths: 1 },
  { good: "wagon-parts", hundredths: 10 },
  { good: "barrels", hundredths: 100 },
  { good: "livestock", hundredths: 300 },
]

export type CaravanNeed = { good: Good; hundredths: number }

export type CaravanMonth = { tons: number; linked: boolean }

export type CaravanHouse = {
  structureId: number
  spent: number
  needs: CaravanNeed[]
  /** Seats the last January decision authorized. Hiring fills these during the year. */
  target: number
  /** Oldest hire first. */
  crew: Hire[]
  /** Months the house was open, oldest first. The January decision reads the last twelve. */
  history: CaravanMonth[]
  officeId: number | null
  /** Man-hours of woodland and forest on the lot, counted before the build itself. */
  clearHours: number
  /** Hundredths of a ton of wood the pantry receives when those hours are done. */
  clearWood: number
  cleared: boolean
}

export function emptyCaravans(): CaravanHouse[] {
  return []
}

export function teamsterIds(houses: readonly CaravanHouse[]): Set<number> {
  const ids = new Set<number>()
  for (const house of houses) for (const hire of house.crew) ids.add(hire.id)
  return ids
}

/** Dollars the purse must hold besides the land price: labor, construction goods, and one operating year. */
export function moveInCash(prices: Partial<Record<Good, number>>, wage: number, feature: Uint8Array, tiles: readonly number[]): number {
  return laborBill(wage, feature, tiles) + priced(prices, BUILD) + priced(prices, OPERATING)
}

export function laborBill(wage: number, feature: Uint8Array, tiles: readonly number[]): number {
  return Math.round((Math.max(0, wage) / YEARLY_HOURS) * (CARAVAN_HOURS + coverClear(feature, tiles).hours))
}

export function caravanGoal(house: CaravanHouse): number {
  return CARAVAN_HOURS + (house.clearHours ?? 0)
}

/** Tons each way. A sound road is 2 t, plus 2 t for each man. A broken road is 1 t, plus 1 t for each man. */
export function wayTons(staff: number, linked: boolean): number {
  const hands = Math.max(0, Math.min(2, staff))
  return linked ? 2 + 2 * hands : 1 + hands
}

export function isOpen(house: CaravanHouse): boolean {
  return house.spent >= caravanGoal(house) && house.needs.every((need) => need.hundredths <= 0)
}

/** A finished cart path runs from a tile beside the house to the map edge. */
export function roadLinked(structure: Structure, book: RoadBook, size: number): boolean {
  const finished = new Set(book.tiles.filter((tile) => tile.spent >= tile.hours).map((tile) => tile.index))
  const seen = new Set<number>()
  const queue: number[] = []
  for (const tile of structure.tiles) {
    for (const next of neighbors(tile, size)) {
      if (!finished.has(next) || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const tile = queue[index]
    if (onEdge(tile, size)) return true
    for (const next of neighbors(tile, size)) {
      if (!finished.has(next) || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

export function caravanLines(
  structure: Structure,
  house: CaravanHouse | null,
  linked: boolean,
  wage: number,
  prices: Partial<Record<Good, number>>,
  feature: Uint8Array,
): PropertyLine[] {
  if (structure.kind !== "caravan-house") return []
  const lines: PropertyLine[] = [{ label: "Road", value: linked ? "To the map edge" : "None" }]
  if (!house) {
    const cover = coverClear(feature, structure.tiles)
    const bill = BUILD.map((item) => `${formatTons(item.hundredths)} ${GOOD_LABEL[item.good].toLowerCase()}`).join(", ")
    const clearing = cover.wood > 0 ? `, ${formatTons(cover.wood)} wood into the pantry` : ""
    lines.push({ label: "Build", value: `${(CARAVAN_HOURS + cover.hours).toLocaleString("en-US")} man-hours, ${bill}${clearing}` })
    lines.push({ label: "To move in", value: `${money(moveInCash(prices, wage, feature, structure.tiles))} besides the land` })
    return lines
  }
  const open = isOpen(house)
  const left = Math.max(0, caravanGoal(house) - house.spent)
  lines.push({ label: "Construction", value: open ? "Open" : left > 0 ? `${left.toLocaleString("en-US")} man-hours left` : "Waiting on materials" })
  if (!open && !house.cleared && house.clearWood > 0) lines.push({ label: "Clearing", value: `${formatTons(house.clearWood)} wood into the pantry` })
  if (!open) {
    const waiting = house.needs.filter((need) => need.hundredths > 0)
    lines.push({ label: "Materials", value: waiting.length > 0 ? waiting.map((need) => `${formatTons(need.hundredths)} ${GOOD_LABEL[need.good].toLowerCase()}`).join(", ") : "Bought" })
  }
  if (!open) lines.push({ label: "Office", value: house.officeId === null ? "None" : `Office ${house.officeId}` })
  const tons = wayTons(house.crew.length, linked)
  lines.push({ label: "Capacity", value: open ? `${tons} t each way` : "None yet" })
  lines.push({ label: "Staff", value: `${house.crew.length} of ${house.target}` })
  lines.push({ label: "Wages", value: `${money(Math.max(0, Math.floor(wage)))} a year, from the owner` })
  const recent = house.history.slice(-12)
  const shipped = recent.reduce((sum, month) => sum + month.tons, 0)
  lines.push({ label: "Shipped out", value: recent.length > 0 ? `${shipped} t over ${recent.length} month${recent.length === 1 ? "" : "s"}` : "None yet" })
  return lines
}

export function materialOrders(
  houses: readonly CaravanHouse[],
  holdings: readonly { structureId: number; owner: number }[],
): { structureId: number; buyer: number; good: Good; hundredths: number }[] {
  const ownerOf = new Map(holdings.filter((row) => row.owner >= 0).map((row) => [row.structureId, row.owner]))
  const orders: { structureId: number; buyer: number; good: Good; hundredths: number }[] = []
  for (const house of houses) {
    const buyer = ownerOf.get(house.structureId)
    if (buyer === undefined) continue
    for (const need of house.needs) {
      if (need.hundredths > 0) orders.push({ structureId: house.structureId, buyer, good: need.good, hundredths: need.hundredths })
    }
  }
  return orders
}

export function applyBought(
  houses: readonly CaravanHouse[],
  bought: readonly { structureId: number; good: Good; taken: number }[],
): CaravanHouse[] {
  if (bought.length === 0) return [...houses]
  return houses.map((house) => {
    const mine = bought.filter((item) => item.structureId === house.structureId && item.taken > 0)
    if (mine.length === 0) return house
    const needs = house.needs.map((need) => {
      const taken = mine.filter((item) => item.good === need.good).reduce((sum, item) => sum + item.taken, 0)
      return taken > 0 ? { ...need, hundredths: Math.max(0, need.hundredths - taken) } : need
    })
    return { ...house, needs }
  })
}

/** Houses that can ship this month, with the crew they have after hiring. */
export function openCaps(
  houses: readonly CaravanHouse[],
  structures: readonly Structure[],
  book: RoadBook,
  size: number,
): { structureId: number; staff: number; eachWay: number }[] {
  const standing = new Set(structures.filter((structure) => structure.kind === "caravan-house" && !structure.pending && !structure.removing).map((structure) => structure.id))
  const caps: { structureId: number; staff: number; eachWay: number }[] = []
  for (const house of houses) {
    if (!standing.has(house.structureId) || !isOpen(house)) continue
    const structure = structures.find((item) => item.id === house.structureId)
    if (!structure) continue
    const staff = house.crew.length
    caps.push({ structureId: house.structureId, staff, eachWay: wayTons(staff, roadLinked(structure, book, size)) })
  }
  return caps
}

/**
 * Keep men who still have no house job. In December the owner pays each man
 * the E1 wage. In January, a full year on a sound road sets the seats: 20 t
 * outbound hires the first, 40 t the second, and a quieter year drops the newest.
 * Open seats are filled every month.
 */
export function staffCaravans(
  people: People,
  houses: readonly CaravanHouse[],
  structures: readonly Structure[],
  holdings: readonly { structureId: number; owner: number }[],
  takenIds: ReadonlySet<number>,
  month: number,
  year: number,
  idMap: Int32Array | null,
  wage: number,
  feature: Uint8Array,
): { people: People; houses: CaravanHouse[] } {
  const standing = new Map<number, Structure>()
  for (const structure of structures) {
    if (structure.kind !== "caravan-house" || structure.removing) continue
    standing.set(structure.id, structure)
  }
  const owners = new Map(holdings.filter((row) => row.owner >= 0).map((row) => [row.structureId, row.owner]))
  const taken = new Set(takenIds)
  const next: CaravanHouse[] = []
  for (const house of [...houses].sort((a, b) => a.structureId - b.structureId)) {
    if (!standing.has(house.structureId) || !owners.has(house.structureId)) continue
    const crew: Hire[] = []
    for (const hire of house.crew) {
      const moved = remap(hire, idMap)
      if (!moved || !keepsJob(people, moved.id) || taken.has(moved.id)) continue
      taken.add(moved.id)
      crew.push(moved)
    }
    const clearHours = house.clearHours ?? 0
    next.push({
      ...house,
      crew,
      needs: house.needs.map((need) => ({ ...need })),
      history: [...house.history],
      clearHours,
      clearWood: house.clearWood ?? 0,
      cleared: house.cleared ?? clearHours === 0,
    })
  }
  for (const structure of standing.values()) {
    if (!owners.has(structure.id) || next.some((house) => house.structureId === structure.id)) continue
    const cover = coverClear(feature, structure.tiles)
    next.push({
      structureId: structure.id,
      spent: 0,
      needs: BUILD.map((item) => ({ ...item })),
      target: 0,
      crew: [],
      history: [],
      officeId: null,
      clearHours: cover.hours,
      clearWood: cover.wood,
      cleared: cover.hours === 0,
    })
  }
  next.sort((a, b) => a.structureId - b.structureId)

  const wealth = new Int32Array(people.wealth)
  const income = new Int32Array(people.income)
  const incomeLog = new Int32Array(people.incomeLog)
  const yearly = Math.max(0, Math.floor(wage))
  for (const house of next) {
    const owner = owners.get(house.structureId) ?? -1
    if (month === 11 && isOpen(house)) {
      for (const hire of house.crew) {
        if (hire.id < 0 || hire.id >= wealth.length || owner < 0 || owner >= wealth.length) continue
        wealth[owner] -= yearly
        noteOperatingIncome(income, incomeLog, owner, -yearly, month)
        wealth[hire.id] += yearly
        noteOperatingIncome(income, incomeLog, hire.id, yearly, month)
      }
    }
    if (month === 0 && isOpen(house)) house.target = seats(house.target, house.history)
    if (house.crew.length > house.target) {
      const kept = [...house.crew].sort(oldest).slice(0, house.target)
      for (const hire of house.crew) if (!kept.some((item) => item.id === hire.id)) taken.delete(hire.id)
      house.crew = kept
    }
    while (house.crew.length < house.target) {
      const id = seekHand(people, taken)
      if (id < 0) break
      taken.add(id)
      house.crew.push({ id, year, month })
    }
  }
  return { people: { ...people, wealth, income, incomeLog }, houses: next }
}

/**
 * Spend free office hours on caravan houses and workshops still going up.
 * Lower structure ids take an office first, and that office is the one that
 * would finish the building soonest. A caravan house that was already open
 * records this month's outbound tons.
 */
export function workCaravans(
  houses: readonly CaravanHouse[],
  structures: readonly Structure[],
  offices: readonly OfficeCrew[],
  book: RoadBook,
  shipments: readonly { postId: number; way: string }[],
  shipping: ReadonlySet<number>,
  size: number,
  sites: readonly WorkshopSite[] = [],
  farms: Farms = { rows: [] },
  feature: Uint8Array = new Uint8Array(),
): { houses: CaravanHouse[]; sites: WorkshopSite[]; farms: Farms; feature: Uint8Array; changedLand: boolean } {
  const standing = new Map(structures.filter((structure) => structure.kind === "caravan-house" && !structure.pending && !structure.removing).map((structure) => [structure.id, structure]))
  const next = houses
    .filter((house) => standing.has(house.structureId))
    .map((house) => {
      const clearHours = house.clearHours ?? 0
      return {
        ...house,
        needs: house.needs.map((need) => ({ ...need })),
        history: [...house.history],
        crew: [...house.crew],
        clearHours,
        clearWood: house.clearWood ?? 0,
        cleared: house.cleared ?? clearHours === 0,
      }
    })
  const shopStanding = new Map(structures.filter((structure) => (structure.kind === "workshop" || structure.kind === "shop") && !structure.pending && !structure.removing).map((structure) => [structure.id, structure]))
  const shops = sites
    .filter((site) => shopStanding.has(site.structureId))
    .map((site) => {
      const clearHours = site.clearHours ?? 0
      return { ...site, needs: site.needs.map((need) => ({ ...need })), clearHours, clearWood: site.clearWood ?? 0, cleared: site.cleared ?? clearHours === 0 }
    })
  const jobs: { kind: "caravan" | "workshop"; structureId: number; spent: number; goal: number; officeId: number | null }[] = [
    ...next.map((house) => ({ kind: "caravan" as const, structureId: house.structureId, spent: house.spent, goal: caravanGoal(house), officeId: house.officeId })),
    ...shops.map((site) => ({ kind: "workshop" as const, structureId: site.structureId, spent: site.spent, goal: (site.hours ?? WORKSHOP_HOURS) + (site.clearHours ?? 0), officeId: site.officeId })),
  ]
  const busy = new Set(offices.map((office) => office.structureId).filter((id) => projectOfOffice(book, id) !== null))
  const ready = offices.filter((office) => office.crew.length > 0 && !busy.has(office.structureId) && structures.some((structure) => structure.id === office.structureId && structure.kind === "construction-office" && !structure.pending && !structure.removing))
  const waiting = jobs.filter((job) => job.spent < job.goal).sort((a, b) => a.structureId - b.structureId)
  for (const job of waiting) {
    const left = job.goal - job.spent
    const choice = pickOffice(ready.filter((office) => !busy.has(office.structureId)), left)
    job.officeId = choice?.structureId ?? null
    if (!choice) continue
    busy.add(choice.structureId)
    job.spent += Math.min(left, choice.crew.length * MONTHLY_HOURS)
  }
  for (const job of jobs) if (job.spent >= job.goal) job.officeId = null
  let stock = farms
  let cover = feature
  let changedLand = false
  for (const house of next) {
    const job = jobs.find((item) => item.kind === "caravan" && item.structureId === house.structureId)
    if (!job) continue
    house.spent = job.spent
    house.officeId = job.officeId
    const structure = standing.get(house.structureId)
    if (structure && job.spent >= (house.clearHours ?? 0) && !house.cleared) {
      const granted = grantClearing(stock, cover, house.structureId, structure.tiles, house.clearWood ?? 0)
      stock = granted.farms
      cover = granted.feature
      changedLand = changedLand || granted.changedLand
      house.cleared = true
    }
  }
  for (const site of shops) {
    const job = jobs.find((item) => item.kind === "workshop" && item.structureId === site.structureId)
    if (!job) continue
    site.spent = job.spent
    site.officeId = job.officeId
    const structure = shopStanding.get(site.structureId)
    if (structure && job.spent >= (site.clearHours ?? 0) && !site.cleared) {
      const granted = grantClearing(stock, cover, site.structureId, structure.tiles, site.clearWood ?? 0)
      stock = granted.farms
      cover = granted.feature
      changedLand = changedLand || granted.changedLand
      site.cleared = true
    }
  }
  for (const house of next) {
    const structure = standing.get(house.structureId)
    if (!structure || !shipping.has(house.structureId)) continue
    const tons = shipments.filter((item) => item.postId === house.structureId && item.way === "export").length
    house.history = [...house.history, { tons, linked: roadLinked(structure, book, size) }].slice(-24)
  }
  return { houses: next, sites: shops, farms: stock, feature: cover, changedLand }
}

/** The clearing hours are a prefix of the build. Their wood goes into this building's pantry, and the woods become prairie. */
function grantClearing(
  farms: Farms,
  feature: Uint8Array,
  structureId: number,
  tiles: readonly number[],
  wood: number,
): { farms: Farms; feature: Uint8Array; changedLand: boolean } {
  let rows = farms.rows
  if (wood > 0) {
    rows = farms.rows.map((row) =>
      row.structureId === structureId ? { ...row, store: { ...row.store, wood: (row.store.wood ?? 0) + wood } } : row,
    )
  }
  let next = feature
  let changedLand = false
  for (const index of tiles) {
    if (index < 0 || index >= feature.length) continue
    const cover = feature[index]
    if (cover !== Feature.Woodland && cover !== Feature.Forest) continue
    if (next === feature) next = feature.slice()
    next[index] = Feature.Prairie
    changedLand = true
  }
  return { farms: rows === farms.rows ? farms : { rows }, feature: next, changedLand }
}

function seats(current: number, history: readonly CaravanMonth[]): number {
  const year = history.slice(-12)
  if (year.length < 12 || year.some((month) => !month.linked)) return current
  const tons = year.reduce((sum, month) => sum + month.tons, 0)
  if (current <= 0) return tons >= OUT_ONE ? 1 : 0
  if (current === 1) {
    if (tons >= OUT_TWO) return 2
    if (tons < OUT_ONE) return 0
    return 1
  }
  return tons < OUT_TWO ? 1 : 2
}

function pickOffice(ready: readonly OfficeCrew[], hours: number): OfficeCrew | null {
  let best: OfficeCrew | null = null
  let bestMonths = Number.POSITIVE_INFINITY
  for (const office of ready) {
    const monthly = office.crew.length * MONTHLY_HOURS
    if (monthly <= 0) continue
    const months = Math.ceil(hours / monthly)
    const better =
      best === null ||
      months < bestMonths ||
      (months === bestMonths && office.crew.length < best.crew.length) ||
      (months === bestMonths && office.crew.length === best.crew.length && office.structureId < best.structureId)
    if (!better) continue
    best = office
    bestMonths = months
  }
  return best
}

function keepsJob(people: People, id: number): boolean {
  if (id < 0 || id >= people.alive.length || people.alive[id] === 0) return false
  if ((people.retired?.[id] ?? 0) !== 0) return false
  const job = people.occupation?.[id] ?? OCCUPATION.unemployed
  return job === OCCUPATION.unemployed || job === OCCUPATION.teamster
}

function seekHand(people: People, taken: ReadonlySet<number>): number {
  for (let id = 0; id < people.age.length; id++) {
    if (taken.has(id) || people.alive[id] === 0 || people.sex[id] !== Sex.Male) continue
    if (people.age[id] < HIRE_MIN_AGE || people.age[id] > HIRE_MAX_AGE) continue
    if ((people.retired?.[id] ?? 0) !== 0) continue
    if ((people.occupation?.[id] ?? OCCUPATION.unemployed) !== OCCUPATION.unemployed) continue
    return id
  }
  return -1
}

function remap(hire: Hire, idMap: Int32Array | null): Hire | null {
  if (!idMap) return hire
  const id = hire.id < idMap.length ? idMap[hire.id] : -1
  if (id < 0) return null
  return { ...hire, id }
}

function oldest(a: Hire, b: Hire): number {
  return a.year - b.year || a.month - b.month || a.id - b.id
}

function priced(prices: Partial<Record<Good, number>>, items: readonly { good: Good; hundredths: number }[]): number {
  let total = 0
  for (const item of items) total += Math.round(((prices[item.good] ?? 0) * item.hundredths) / 100)
  return total
}

function money(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString("en-US")}`
}

function onEdge(index: number, size: number): boolean {
  const x = index % size
  const y = (index - x) / size
  return x === 0 || y === 0 || x === size - 1 || y === size - 1
}

function neighbors(index: number, size: number): number[] {
  const x = index % size
  const y = (index - x) / size
  const out: number[] = []
  if (x > 0) out.push(index - 1)
  if (x + 1 < size) out.push(index + 1)
  if (y > 0) out.push(index - size)
  if (y + 1 < size) out.push(index + size)
  return out
}
