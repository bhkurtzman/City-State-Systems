import { coverClear, type Structure } from "@/lib/buildings"
import type { PropertyLine } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { formatTons, GOOD_LABEL, type FarmRecord, type Farms, type Good } from "@/lib/produce"
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

/** Shelf target in hundredths of a ton. */
export const RETAIL_LINE: Record<RetailSpecialty, Partial<Record<Good, number>>> = {
  baker: { grain: 500 },
  grocer: { fruit: 800, vegetables: 800, spices: 100, salt: 200 },
  butcher: { meat: 200, fish: 200, dairy: 400 },
  hardware: { "steel-tools": 200, "steel-parts": 100, barrels: 100 },
  draper: { clothing: 200, leather: 100, textiles: 100 },
}

export const RETAIL_ORDER: readonly RetailSpecialty[] = ["baker", "grocer", "butcher", "hardware", "draper"]

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
 * 45% the best specialty, 25% the second, 15% the third, and the rest split across whatever is left.
 * Fewer than four drop the empty slots and rescale. The purse has to cover a fill of the specialty.
 */
export function chooseShopSpecialty(
  ranked: readonly RetailSpecialty[],
  structureId: number,
  seed: string,
  year: number,
  month: number,
  purse: number,
  prices: Partial<Record<Good, number>>,
): RetailSpecialty | null {
  const affordable = ranked.filter((kind) => fillDollars(kind, prices) <= purse)
  if (affordable.length === 0) return null
  const roll = mulberry32(hashSeed(`${seed}:retail:${structureId}:${year}:${month}`))()
  const raw = affordable.map((_, index) => {
    if (affordable.length >= 4 && index >= 3) return 0.15 / (affordable.length - 3)
    return [0.45, 0.25, 0.15, 0.15][index] ?? 0
  })
  const total = raw.reduce((sum, weight) => sum + weight, 0)
  let cursor = 0
  for (let index = 0; index < affordable.length; index++) {
    cursor += raw[index] / total
    if (roll < cursor) return affordable[index]
  }
  return affordable[affordable.length - 1]
}

/** An owned shop with no specialty draws from this month's ranked list. Every shop uses that same list. */
export function assignShopSpecialties(
  farms: Farms,
  structures: readonly Structure[],
  ranked: readonly RetailSpecialty[],
  prices: Partial<Record<Good, number>>,
  wealth: Int32Array,
  seed: string,
  month: number,
  year: number,
  closed: ReadonlySet<number>,
): void {
  const shops = structures.filter((structure) => structure.kind === "shop" && !structure.pending && !structure.removing && !closed.has(structure.id)).sort((a, b) => a.id - b.id)
  for (const structure of shops) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row || row.owner < 0 || row.retail) continue
    const pick = chooseShopSpecialty(ranked, structure.id, seed, year, month, wealth[row.owner] ?? 0, prices)
    if (pick) row.retail = pick
  }
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
