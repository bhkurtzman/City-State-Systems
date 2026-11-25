import type { Structure } from "@/lib/buildings"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { SHELF_TARGET, type FarmRecord, type Farms, type Good } from "@/lib/produce"
import { fillDollars, RETAIL_LINE, RETAIL_ORDER, type RetailSpecialty } from "@/lib/shop"

/**
 * The stocking score that used to choose a shop specialty.
 * A new shop now uses the workshop profit draw. Nothing in the live month calls this file.
 */

const TON = 100

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

/** A specialty line counts toward its score only when a year of use is at least a tenth of a ton. */
export function lineActive(monthlyTons: number): boolean {
  return monthlyTons * 12 >= 0.1
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

/** One specialty this purse can stock, using the stocking score. */
export function chooseShopSpecialty(
  input: RetailRank,
  structureId: number,
  seed: string,
  year: number,
  month: number,
  purse: number,
): RetailSpecialty | null {
  const ranked = rankRetail(input)
  const affordable = ranked.filter((item) => fillDollars(item.kind, input.prices) <= purse)
  return pickRetail(affordable, mulberry32(hashSeed(`${seed}:retail:${structureId}:${year}:${month}`))())
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
