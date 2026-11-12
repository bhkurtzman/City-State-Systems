import { coverClear, type Structure } from "@/lib/buildings"
import type { PropertyLine } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { formatTons, GOOD_LABEL, SHELF_TARGET, type FarmRecord, type Farms, type Good } from "@/lib/produce"
import { type WorkshopSite } from "@/lib/workshop"

/** Man-hours to raise a shop. The family pays the treasury for these up front. */
export const SHOP_HOURS = 500
const YEARLY_HOURS = 1200
const TON = 100

const BUILD: readonly { good: Good; hundredths: number }[] = [
  { good: "lumber", hundredths: 1200 },
  { good: "steel-parts", hundredths: 10 },
]

export type RetailSpecialty = "baker" | "grocer" | "butcher" | "hardware" | "draper"

export const RETAIL_NAME: Record<RetailSpecialty, string> = {
  baker: "Baker",
  grocer: "Grocer",
  butcher: "Butcher",
  hardware: "Hardware",
  draper: "Draper",
}

/** Shelf target in hundredths of a ton. These weights are also the profit weights. */
export const RETAIL_LINE: Record<RetailSpecialty, Partial<Record<Good, number>>> = {
  baker: { grain: 500 },
  grocer: { fruit: 800, vegetables: 800, spices: 100, salt: 200 },
  butcher: { meat: 200, fish: 200, dairy: 400 },
  hardware: { "steel-tools": 200, "steel-parts": 100, barrels: 100 },
  draper: { clothing: 200, leather: 100, textiles: 100 },
}

const RETAIL_ORDER: readonly RetailSpecialty[] = ["baker", "grocer", "butcher", "hardware", "draper"]

export type RetailMonth = { restock: number; reject: number }

export type RetailRank = {
  monthly: Partial<Record<Good, number>>
  prices: Partial<Record<Good, number>>
  retail?: Partial<Record<Good, readonly RetailMonth[]>>
  farms: Farms
  structures: readonly Structure[]
  footprint: readonly number[]
  size: number
  stock: Partial<Record<Good, number>>
  prior: Partial<Record<RetailSpecialty, number>>
}

export type RetailScore = { kind: RetailSpecialty; score: number }

export function shopLabor(wage: number, feature: Uint8Array, tiles: readonly number[]): number {
  return Math.round((Math.max(0, wage) / YEARLY_HOURS) * (SHOP_HOURS + coverClear(feature, tiles).hours))
}

/** Dollars still required for the build, besides the land, the stock, and a year of keep. */
export function shopCash(
  prices: Partial<Record<Good, number>>,
  wage: number,
  site: WorkshopSite | null,
  feature: Uint8Array,
  tiles: readonly number[],
): number {
  if (site && site.spent >= (site.hours ?? SHOP_HOURS) + (site.clearHours ?? 0) && site.needs.every((need) => need.hundredths <= 0)) return 0
  const items = site ? site.needs : BUILD
  let materials = 0
  for (const item of items) materials += Math.round(((prices[item.good] ?? 0) * item.hundredths) / TON)
  return (site ? 0 : shopLabor(wage, feature, tiles)) + materials
}

export function trackShops(
  sites: readonly WorkshopSite[],
  structures: readonly Structure[],
  holdings: readonly { structureId: number; owner: number }[],
  feature: Uint8Array,
): WorkshopSite[] {
  const standing = new Map(structures.filter((structure) => structure.kind === "shop" && !structure.pending && !structure.removing).map((structure) => [structure.id, structure]))
  const owned = new Set(holdings.filter((row) => row.owner >= 0).map((row) => row.structureId))
  const next = sites.filter((site) => standing.has(site.structureId)).map(copySite)
  for (const [id, structure] of standing) {
    if (!owned.has(id) || next.some((site) => site.structureId === id)) continue
    const cover = coverClear(feature, structure.tiles)
    next.push({
      structureId: id,
      spent: 0,
      needs: BUILD.map((item) => ({ ...item })),
      officeId: null,
      clearHours: cover.hours,
      clearWood: cover.wood,
      cleared: cover.hours === 0,
      hours: SHOP_HOURS,
      role: "shop",
    })
  }
  return next
}

export function shopLines(
  structure: Structure,
  site: WorkshopSite | null,
  wage: number,
  prices: Partial<Record<Good, number>>,
  feature: Uint8Array,
): PropertyLine[] {
  if (structure.kind !== "shop") return []
  const open = site !== null && site.spent >= (site.hours ?? SHOP_HOURS) + (site.clearHours ?? 0) && site.needs.every((need) => need.hundredths <= 0)
  if (!site || open) {
    if (open) return [{ label: "Construction", value: "Open" }]
    const cover = coverClear(feature, structure.tiles)
    const bill = BUILD.map((item) => `${formatTons(item.hundredths)} ${GOOD_LABEL[item.good].toLowerCase()}`).join(", ")
    const clearing = cover.wood > 0 ? `, ${formatTons(cover.wood)} wood into the pantry` : ""
    return [
      { label: "Build", value: `${(SHOP_HOURS + cover.hours).toLocaleString("en-US")} man-hours, ${bill}${clearing}` },
      { label: "To move in", value: `$${Math.round(shopCash(prices, wage, null, feature, structure.tiles)).toLocaleString("en-US")} besides the land and stock` },
    ]
  }
  const left = Math.max(0, (site.hours ?? SHOP_HOURS) + (site.clearHours ?? 0) - site.spent)
  const waiting = site.needs.filter((need) => need.hundredths > 0)
  const lines: PropertyLine[] = [
    { label: "Construction", value: left > 0 ? `${left.toLocaleString("en-US")} man-hours left` : "Waiting on materials" },
    { label: "Materials", value: waiting.length > 0 ? waiting.map((need) => `${formatTons(need.hundredths)} ${GOOD_LABEL[need.good].toLowerCase()}`).join(", ") : "Bought" },
    { label: "Office", value: site.officeId === null ? "None" : `Office ${site.officeId}` },
  ]
  if (!site.cleared && site.clearWood > 0) lines.push({ label: "Clearing", value: `${formatTons(site.clearWood)} wood into the pantry` })
  return lines
}

/** A specialty line counts toward its score only when a year of use is at least a tenth of a ton. */
export function lineActive(monthlyTons: number): boolean {
  return monthlyTons * 12 >= 0.1
}

/** Hundredths to keep on an open shop's shelf. Every line in the specialty is stocked. */
export function shopLineTarget(retail: FarmRecord["retail"], good: Good): number {
  if (!retail) return 0
  return RETAIL_LINE[retail][good] ?? 0
}

/** Dollars to fill every line in the specialty up to its target, at town prices. */
export function fillDollars(kind: RetailSpecialty, prices: Partial<Record<Good, number>>): number {
  let total = 0
  for (const good of Object.keys(RETAIL_LINE[kind]) as Good[]) {
    total += Math.round(((prices[good] ?? 0) * (RETAIL_LINE[kind][good] ?? 0)) / TON)
  }
  return total
}

/**
 * Specialties still at 1 or better, highest first.
 * A bordering shop of the same specialty halves the average, and a second one zeroes it.
 * Each shop that already took that specialty this month halves it again.
 */
export function rankRetail(input: RetailRank): RetailScore[] {
  const ranked: RetailScore[] = []
  for (const kind of RETAIL_ORDER) {
    const lines = Object.keys(RETAIL_LINE[kind]) as Good[]
    if (!lines.some((good) => lineActive(input.monthly[good] ?? 0))) continue
    let sum = 0
    for (const good of lines) {
      if (!lineActive(input.monthly[good] ?? 0)) continue
      sum += goodScore(good, RETAIL_LINE[kind][good] ?? 0, input)
    }
    let score = sum / lines.length
    const neighbors = bordering(kind, input)
    if (neighbors >= 2) score = 0
    else if (neighbors === 1) score *= 0.5
    score *= 0.5 ** (input.prior[kind] ?? 0)
    if (score >= 1) ranked.push({ kind, score })
  }
  ranked.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))
  return ranked
}

/** Cheapest qualifying specialty's stock, or infinity when none qualifies. */
export function cheapestShopFill(input: RetailRank): number {
  const ranked = rankRetail(input)
  if (ranked.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...ranked.map((item) => fillDollars(item.kind, input.prices)))
}

/**
 * 45 / 25 / 15, and the rest split across whatever is still left.
 * Fewer than four qualifiers drop the empty slots and rescale.
 */
export function pickRetail(ranked: readonly RetailScore[], roll: number): RetailSpecialty | null {
  if (ranked.length === 0) return null
  const raw = ranked.map((_, index) => {
    if (ranked.length >= 4 && index >= 3) return 0.15 / (ranked.length - 3)
    return [0.45, 0.25, 0.15, 0.15][index] ?? 0
  })
  const total = raw.reduce((sum, weight) => sum + weight, 0)
  let cursor = 0
  for (let index = 0; index < ranked.length; index++) {
    cursor += raw[index] / total
    if (roll < cursor) return ranked[index].kind
  }
  return ranked[ranked.length - 1].kind
}

/** The first open month a shop can pay for a specialty, it takes one. Later shops that month are marked down. */
export function assignShops(
  farms: Farms,
  structures: readonly Structure[],
  input: Omit<RetailRank, "footprint" | "prior">,
  wealth: Int32Array,
  seed: string,
  month: number,
  year: number,
  closed: ReadonlySet<number>,
): void {
  const prior: Partial<Record<RetailSpecialty, number>> = {}
  const shops = structures.filter((structure) => structure.kind === "shop" && !structure.pending && !structure.removing && !closed.has(structure.id)).sort((a, b) => a.id - b.id)
  for (const structure of shops) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row || row.owner < 0 || row.retail) continue
    const ranked = rankRetail({ ...input, footprint: structure.tiles, prior })
    const purse = wealth[row.owner] ?? 0
    const affordable = ranked.filter((item) => fillDollars(item.kind, input.prices) <= purse)
    const pick = pickRetail(affordable, mulberry32(hashSeed(`${seed}:retail:${structure.id}:${year}:${month}`))())
    if (!pick) continue
    row.retail = pick
    prior[pick] = (prior[pick] ?? 0) + 1
  }
}

function goodScore(good: Good, target: number, input: RetailRank): number {
  const sellers = carriers(good, input)
  let points = logged(good, input)
  if (sellers === 0) {
    const yearly = (input.monthly[good] ?? 0) * 12
    points = yearly >= 0.1 && hasTon(good, input) ? 50 * yearly : 0
  }
  const meter = points / Math.max(1, sellers) - 4
  const profitPerTon = 10 + 0.1 * paid(good, input)
  const profitPerStock = profitPerTon * (target / TON)
  const score = meter * (1 + profitPerStock / 10)
  return score < 1 ? 0 : score
}

function paid(good: Good, input: RetailRank): number {
  let weighted = 0
  let tons = 0
  for (const row of input.farms.rows) {
    const market = input.structures.some((structure) => structure.id === row.structureId && structure.kind === "market" && !structure.pending && !structure.removing) && SHELF_TARGET[good]
    if (!market && !carriesRow(row, good)) continue
    const cost = row.cost?.[good]
    const held = row.store[good] ?? 0
    if (!cost || cost <= 0 || held <= 0) continue
    weighted += cost * held
    tons += held
  }
  if (tons <= 0) return input.prices[good] ?? 0
  return weighted / tons
}

function carriers(good: Good, input: RetailRank): number {
  let count = 0
  if (SHELF_TARGET[good]) {
    for (const structure of input.structures) {
      if (structure.kind === "market" && !structure.pending && !structure.removing) count += 1
    }
  }
  for (const row of input.farms.rows) if (carriesRow(row, good)) count += 1
  return count
}

function carriesRow(row: FarmRecord, good: Good): boolean {
  if (!row.retail) return false
  return (RETAIL_LINE[row.retail][good] ?? 0) > 0
}

function logged(good: Good, input: RetailRank): number {
  let points = 0
  for (const month of input.retail?.[good] ?? []) points += month.restock + month.reject * 5
  return points
}

function hasTon(good: Good, input: RetailRank): boolean {
  if ((input.stock[good] ?? 0) >= TON) return true
  return input.farms.rows.some((row) => (row.store[good] ?? 0) >= TON)
}

function bordering(kind: RetailSpecialty, input: RetailRank): number {
  let count = 0
  for (const structure of input.structures) {
    if (structure.kind !== "shop" || structure.pending || structure.removing) continue
    if (sameFoot(structure.tiles, input.footprint)) continue
    const row = input.farms.rows.find((item) => item.structureId === structure.id)
    if (row?.retail !== kind) continue
    if (shareEdge(structure.tiles, input.footprint, input.size)) count += 1
  }
  return count
}

function sameFoot(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const tiles = new Set(a)
  return b.every((tile) => tiles.has(tile))
}

function shareEdge(a: readonly number[], b: readonly number[], size: number): boolean {
  if (size <= 0) return false
  const tiles = new Set(a)
  for (const tile of b) {
    const x = tile % size
    const y = (tile - x) / size
    if (x > 0 && tiles.has(tile - 1)) return true
    if (x + 1 < size && tiles.has(tile + 1)) return true
    if (y > 0 && tiles.has(tile - size)) return true
    if (y + 1 < size && tiles.has(tile + size)) return true
  }
  return false
}

function copySite(site: WorkshopSite): WorkshopSite {
  const clearHours = site.clearHours ?? 0
  return {
    ...site,
    needs: site.needs.map((need) => ({ ...need })),
    clearHours,
    clearWood: site.clearWood ?? 0,
    cleared: site.cleared ?? clearHours === 0,
    hours: site.hours ?? SHOP_HOURS,
    role: "shop",
  }
}
