import { coverClear, type Structure } from "@/lib/buildings"
import type { PropertyLine } from "@/lib/land"
import { formatTons, GOOD_LABEL, type Good } from "@/lib/produce"

/** Man-hours to raise a workshop. The family pays the treasury for these up front. */
export const WORKSHOP_HOURS = 800
const YEARLY_HOURS = 1200

const BUILD: readonly { good: Good; hundredths: number }[] = [
  { good: "lumber", hundredths: 2000 },
  { good: "steel-parts", hundredths: 30 },
]

export type WorkshopNeed = { good: Good; hundredths: number }

export type WorkshopSite = {
  structureId: number
  spent: number
  needs: WorkshopNeed[]
  officeId: number | null
  /** Man-hours of woodland and forest on the lot, counted before the build itself. */
  clearHours: number
  /** Hundredths of a ton of wood the pantry receives when those hours are done. */
  clearWood: number
  cleared: boolean
  /** Build hours before clearing. A shop sets this; a workshop leaves it empty. */
  hours?: number
  /** Set on a shop so its site is not stored with the workshops. */
  role?: "shop"
}

export function emptyWorkshops(): WorkshopSite[] {
  return []
}

export function workshopLabor(wage: number, feature: Uint8Array, tiles: readonly number[]): number {
  return Math.round((Math.max(0, wage) / YEARLY_HOURS) * (WORKSHOP_HOURS + coverClear(feature, tiles).hours))
}

/** Dollars still required for the build, besides the land and the specialty purse. Labor is included only before work has started. */
export function workshopCash(
  prices: Partial<Record<Good, number>>,
  wage: number,
  site: WorkshopSite | null,
  feature: Uint8Array,
  tiles: readonly number[],
): number {
  if (site && isWorkshopOpen(site)) return 0
  return (site ? 0 : workshopLabor(wage, feature, tiles)) + priced(prices, site ? site.needs : BUILD)
}

/** Material dollars still in the purse and not yet spent. Specialty cash is what remains after this. */
export function materialReserve(site: WorkshopSite | null, prices: Partial<Record<Good, number>>): number {
  if (!site || isWorkshopOpen(site)) return 0
  return priced(prices, site.needs)
}

export function workshopGoal(site: WorkshopSite): number {
  return (site.hours ?? WORKSHOP_HOURS) + (site.clearHours ?? 0)
}

export function isWorkshopOpen(site: WorkshopSite): boolean {
  return site.spent >= workshopGoal(site) && site.needs.every((need) => need.hundredths <= 0)
}

export function closedWorkshops(sites: readonly WorkshopSite[]): Set<number> {
  return new Set(sites.filter((site) => !isWorkshopOpen(site)).map((site) => site.structureId))
}

/** Keep a site for every owned workshop. A new one starts with the full material bill. */
export function trackWorkshops(
  sites: readonly WorkshopSite[],
  structures: readonly Structure[],
  holdings: readonly { structureId: number; owner: number }[],
  feature: Uint8Array,
): WorkshopSite[] {
  const standing = new Map(structures.filter((structure) => structure.kind === "workshop" && !structure.pending && !structure.removing).map((structure) => [structure.id, structure]))
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
    })
  }
  return next
}

export function workshopLines(
  structure: Structure,
  site: WorkshopSite | null,
  wage: number,
  prices: Partial<Record<Good, number>>,
  feature: Uint8Array,
): PropertyLine[] {
  if (structure.kind !== "workshop") return []
  if (!site || isWorkshopOpen(site)) {
    if (site && isWorkshopOpen(site)) return [{ label: "Construction", value: "Open" }]
    const cover = coverClear(feature, structure.tiles)
    const bill = BUILD.map((item) => `${formatTons(item.hundredths)} ${GOOD_LABEL[item.good].toLowerCase()}`).join(", ")
    return [
      { label: "Build", value: buildValue(WORKSHOP_HOURS + cover.hours, bill, cover.wood) },
      { label: "To move in", value: `${money(workshopCash(prices, wage, null, feature, structure.tiles))} besides the land` },
      { label: "Specialty purse", value: "$1,000, or $5,000 for a blacksmith" },
    ]
  }
  const left = Math.max(0, workshopGoal(site) - site.spent)
  const waiting = site.needs.filter((need) => need.hundredths > 0)
  const lines: PropertyLine[] = [
    { label: "Construction", value: left > 0 ? `${left.toLocaleString("en-US")} man-hours left` : "Waiting on materials" },
    { label: "Materials", value: waiting.length > 0 ? waiting.map((need) => `${formatTons(need.hundredths)} ${GOOD_LABEL[need.good].toLowerCase()}`).join(", ") : "Bought" },
    { label: "Office", value: site.officeId === null ? "None" : `Office ${site.officeId}` },
  ]
  if (!site.cleared && site.clearWood > 0) lines.push({ label: "Clearing", value: `${formatTons(site.clearWood)} wood into the pantry` })
  return lines
}

export function workshopOrders(
  sites: readonly WorkshopSite[],
  holdings: readonly { structureId: number; owner: number }[],
): { structureId: number; buyer: number; good: Good; hundredths: number }[] {
  const ownerOf = new Map(holdings.filter((row) => row.owner >= 0).map((row) => [row.structureId, row.owner]))
  const orders: { structureId: number; buyer: number; good: Good; hundredths: number }[] = []
  for (const site of sites) {
    const buyer = ownerOf.get(site.structureId)
    if (buyer === undefined) continue
    for (const need of site.needs) {
      if (need.hundredths > 0) orders.push({ structureId: site.structureId, buyer, good: need.good, hundredths: need.hundredths })
    }
  }
  return orders
}

export function applyWorkshopBought(
  sites: readonly WorkshopSite[],
  bought: readonly { structureId: number; good: Good; taken: number }[],
): WorkshopSite[] {
  if (bought.length === 0) return sites.map(copySite)
  return sites.map((site) => {
    const mine = bought.filter((item) => item.structureId === site.structureId && item.taken > 0)
    if (mine.length === 0) return site
    return {
      ...copySite(site),
      needs: site.needs.map((need) => {
        const taken = mine.filter((item) => item.good === need.good).reduce((sum, item) => sum + item.taken, 0)
        return taken > 0 ? { ...need, hundredths: Math.max(0, need.hundredths - taken) } : need
      }),
    }
  })
}

function copySite(site: WorkshopSite): WorkshopSite {
  const clearHours = site.clearHours ?? 0
  return {
    ...site,
    needs: site.needs.map((need) => ({ ...need })),
    clearHours,
    clearWood: site.clearWood ?? 0,
    cleared: site.cleared ?? clearHours === 0,
  }
}

function buildValue(hours: number, bill: string, wood: number): string {
  const clearing = wood > 0 ? `, ${formatTons(wood)} wood into the pantry` : ""
  return `${hours.toLocaleString("en-US")} man-hours, ${bill}${clearing}`
}

function priced(prices: Partial<Record<Good, number>>, items: readonly { good: Good; hundredths: number }[]): number {
  let total = 0
  for (const item of items) total += Math.round(((prices[item.good] ?? 0) * item.hundredths) / 100)
  return total
}

function money(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString("en-US")}`
}
