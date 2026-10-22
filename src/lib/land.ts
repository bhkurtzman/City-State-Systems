import type { Structure } from "@/lib/buildings"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { Sex, type People } from "@/lib/people"
import { Feature, Terrain } from "@/lib/types"

/** A sale price is twenty yearly lease payments. */
const SALE_PER_LEASE = 20

export const LAND_TYPES = ["farmland", "forest", "marginal", "urban", "coast"] as const
export type LandType = (typeof LAND_TYPES)[number]
export type LandTenure = "sale" | "lease"

export const LAND_LABEL: Record<LandType, string> = {
  farmland: "Farmland",
  forest: "Forest",
  marginal: "Marginal land",
  urban: "Urban land",
  coast: "Coast",
}

export type LandRate = {
  /** What the entered price means for this land type. */
  tenure: LandTenure
  /** Whole dollars per tile. */
  price: number
}

export type LandSchedule = Record<LandType, LandRate>

export type Holding = {
  structureId: number
  /** Person id of the household head, or −1 while the state holds the plot. */
  owner: number
  /** Yearly lease locked at signing. 0 when the plot was bought. */
  lease: number
  /** Calendar month the lease was signed. */
  leaseMonth: number
  /** Dollars paid the last time this plot was bought. 0 while it is leased or unsold. */
  paid: number
}

export type Holdings = {
  /** True after the first month that had a plot to offer. Later sales are random. */
  opened: boolean
  rows: Holding[]
}

export type PropertyLine = { label: string; value: string }

export function defaultLandSchedule(): LandSchedule {
  return {
    farmland: { tenure: "sale", price: 0 },
    forest: { tenure: "sale", price: 0 },
    marginal: { tenure: "sale", price: 0 },
    urban: { tenure: "sale", price: 0 },
    coast: { tenure: "sale", price: 0 },
  }
}

export function emptyHoldings(): Holdings {
  return { opened: false, rows: [] }
}

type Quote = {
  tenure: LandTenure
  /** Dollars due at signing. The sale price, or the first year's lease. */
  due: number
  /** Yearly amount after a lease. 0 after a sale. */
  lease: number
}

/**
 * Record new plots, pass a dead owner's plot to a living spouse, charge leases
 * that are due, then offer anything the state still holds.
 * The first offering gives the cheapest affordable plot to the poorest family.
 * Later offerings pick a random family who can afford that plot.
 */
export function settleHoldings(
  holdings: Holdings,
  structures: readonly Structure[],
  people: People,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  schedule: LandSchedule,
  month: number,
  year: number,
  seed: string,
  idMap: Int32Array | null = null,
): { holdings: Holdings; people: People; toTreasury: number } {
  const byId = new Map(structures.map((structure) => [structure.id, structure]))
  const rows = holdings.rows
    .filter((row) => byId.has(row.structureId))
    .map((row) => ({ ...row }))
  if (idMap) {
    for (const row of rows) {
      if (row.owner < 0) continue
      row.owner = row.owner < idMap.length ? idMap[row.owner] : -1
    }
  }
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    if (rows.some((row) => row.structureId === structure.id)) continue
    rows.push({ structureId: structure.id, owner: -1, lease: 0, leaseMonth: month, paid: 0 })
  }

  const wealth = new Int32Array(people.wealth)
  let toTreasury = 0
  for (const row of rows) {
    if (row.owner < 0) continue
    if (wealth.length <= row.owner || people.alive[row.owner] !== 0) continue
    const mate = people.spouse[row.owner]
    const heir = mate >= 0 && mate < people.alive.length && people.alive[mate] !== 0
    row.owner = heir ? mate : -1
    if (!heir) {
      row.lease = 0
      row.paid = 0
    }
  }

  for (const row of rows) {
    if (row.lease <= 0 || row.leaseMonth !== month || row.owner < 0) continue
    if (wealth[row.owner] < row.lease) continue
    wealth[row.owner] -= row.lease
    toTreasury += row.lease
  }

  const unsold = rows.filter((row) => row.owner < 0)
  let opened = holdings.opened
  if (unsold.length > 0) {
    const quotes = new Map(unsold.map((row) => [row.structureId, quoteFor(byId.get(row.structureId) as Structure, terrain, feature, size, schedule)]))
    const heads = familyHeads(people).filter((id) => !rows.some((row) => row.owner === id))
    if (!opened) {
      toTreasury += offerToPoorest(unsold, quotes, heads, wealth, month)
      opened = true
    } else {
      const random = mulberry32(hashSeed(`${seed}:land:${year}:${month}`))
      toTreasury += offerAtRandom(unsold, quotes, heads, wealth, month, random)
    }
  }

  return { holdings: { opened, rows }, people: { ...people, wealth }, toTreasury }
}

/** Extra inspector lines for the plot on this cell. */
export function propertyLines(
  structure: Structure,
  holdings: Holdings,
  people: People,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  schedule: LandSchedule,
): PropertyLine[] {
  if (structure.pending) return [{ label: "Offer", value: "Not for sale yet" }]
  const row = holdings.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) {
    const quote = quoteFor(structure, terrain, feature, size, schedule)
    return [
      { label: "Offer", value: quote.tenure === "sale" ? "For sale" : "For lease" },
      { label: "Price", value: quote.tenure === "sale" ? dollars(quote.due) : `${dollars(quote.due)} a year` },
    ]
  }
  const lines: PropertyLine[] = [
    { label: "Owner", value: `Family ${row.owner}` },
    { label: "Purse", value: dollars(people.wealth[row.owner] ?? 0) },
  ]
  if (row.lease > 0) lines.push({ label: "Lease", value: `${dollars(row.lease)} a year` })
  if (row.paid > 0) lines.push({ label: "Paid", value: dollars(row.paid) })
  if (row.lease > 0 || row.paid > 0) lines.push({ label: "Upkeep", value: `${fineMoney(monthlyCapital(row))} a month` })
  return lines
}

/** Lease divided by 12, or the sale price divided by 20 and then by 12. */
export function monthlyCapital(row: Holding): number {
  if (row.lease > 0) return row.lease / 12
  return row.paid / 240
}

function offerToPoorest(
  unsold: Holding[],
  quotes: Map<number, Quote>,
  heads: number[],
  wealth: Int32Array,
  month: number,
): number {
  const order = [...heads].sort((a, b) => wealth[a] - wealth[b] || a - b)
  let paid = 0
  for (const head of order) {
    const choices = unsold
      .filter((row) => row.owner < 0 && affordable(wealth[head], quotes.get(row.structureId) as Quote))
      .sort((a, b) => {
        const due = (quotes.get(a.structureId) as Quote).due - (quotes.get(b.structureId) as Quote).due
        return due || a.structureId - b.structureId
      })
    const pick = choices[0]
    if (!pick) continue
    paid += assign(pick, quotes.get(pick.structureId) as Quote, head, wealth, month)
  }
  return paid
}

function offerAtRandom(
  unsold: Holding[],
  quotes: Map<number, Quote>,
  heads: number[],
  wealth: Int32Array,
  month: number,
  random: () => number,
): number {
  let paid = 0
  const open = [...unsold].sort((a, b) => a.structureId - b.structureId)
  for (const row of open) {
    if (row.owner >= 0) continue
    const quote = quotes.get(row.structureId) as Quote
    const choices = heads
      .filter((id) => !unsold.some((item) => item.owner === id) && affordable(wealth[id], quote))
      .sort((a, b) => a - b)
    if (choices.length === 0) continue
    const index = Math.min(choices.length - 1, Math.floor(random() * choices.length))
    paid += assign(row, quote, choices[index], wealth, month)
  }
  return paid
}

function assign(row: Holding, quote: Quote, head: number, wealth: Int32Array, month: number): number {
  wealth[head] -= quote.due
  row.owner = head
  row.lease = quote.tenure === "lease" ? quote.lease : 0
  row.paid = quote.tenure === "sale" ? quote.due : 0
  row.leaseMonth = month
  return quote.due
}

function affordable(wealth: number, quote: Quote): boolean {
  const share = quote.tenure === "sale" ? 70 : 20
  return quote.due <= Math.floor((wealth * share) / 100)
}

function familyHeads(people: People): number[] {
  const heads: number[] = []
  for (let id = 0; id < people.alive.length; id++) {
    if (people.alive[id] === 0) continue
    const mate = people.spouse[id]
    const mateAlive = mate >= 0 && mate < people.alive.length && people.alive[mate] !== 0
    if (mateAlive) {
      if (people.sex[id] === Sex.Male) heads.push(id)
      continue
    }
    if (mate >= 0 && people.age[id] >= 18) heads.push(id)
  }
  return heads
}

function quoteFor(
  structure: Structure,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  schedule: LandSchedule,
): Quote {
  const contract: LandTenure = structure.kind === "farmstead" ? schedule.farmland.tenure : schedule.urban.tenure
  let due = 0
  for (const index of structure.tiles) {
    const type = landTypeAt(index, terrain, feature, size, structure.kind !== "farmstead")
    if (!type) continue
    due += tilePrice(schedule[type], contract)
  }
  return { tenure: contract, due, lease: contract === "lease" ? due : 0 }
}

/** Dollars for one tile, folded into the plot's sale or lease. */
function tilePrice(rate: LandRate, contract: LandTenure): number {
  const price = Math.max(0, Math.floor(rate.price))
  if (rate.tenure === contract) return price
  return contract === "sale" ? price * SALE_PER_LEASE : Math.round(price / SALE_PER_LEASE)
}

/**
 * Farmland, forest, marginal, urban, or coast. Open water that does not touch
 * land has no price and is not owned, so this returns null.
 */
function landTypeAt(
  index: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  urban: boolean,
): LandType | null {
  const ground = terrain[index]
  if (ground === Terrain.Sea || ground === Terrain.Fresh) {
    return bordersLand(index, terrain, size) ? "coast" : null
  }
  if (urban) return "urban"
  const cover = feature[index]
  if (cover === Feature.Prairie) return "farmland"
  if (cover === Feature.Forest || cover === Feature.Woodland) return "forest"
  return "marginal"
}

function bordersLand(index: number, terrain: Uint8Array, size: number): boolean {
  const x = index % size
  const y = (index - x) / size
  const neighbors = [index - 1, index + 1, index - size, index + size]
  if (x === 0) neighbors[0] = -1
  if (x + 1 === size) neighbors[1] = -1
  if (y === 0) neighbors[2] = -1
  if (y + 1 === size) neighbors[3] = -1
  return neighbors.some((neighbor) => {
    if (neighbor < 0) return false
    const ground = terrain[neighbor]
    return ground !== Terrain.Sea && ground !== Terrain.Fresh
  })
}

function dollars(value: number): string {
  return `$${value.toLocaleString("en-US")}`
}

function fineMoney(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
