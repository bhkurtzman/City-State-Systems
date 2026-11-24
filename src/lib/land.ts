import type { Structure } from "@/lib/buildings"
import { noteOperatingIncome, occupantCount, openIncomeMonth, propertySeekers, type People } from "@/lib/people"
import { Feature, Terrain } from "@/lib/types"

/** A sale price is twenty yearly lease payments. */
const SALE_PER_LEASE = 20
/** Farmsteads above this many tiles, and every shop, post, and market, need a purse. */
const LARGE_FARM = 1000
/** That purse is this many years of one adult's cost of living, after the opening decade. */
const WEALTH_YEARS = 5
const OPENING_YEARS = 10
const OPENING_MARKET = 2000
const OPENING_HOLDING = 1000

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
 * Record new plots, return a dead owner's plot to the state, charge leases
 * that are due, then offer anything the state still holds.
 * Gated plots go first, largest first, each to the wealthiest buyer who can
 * pay. For the first ten years a market needs $2,000 and a post, workshop, or
 * large farm needs $1,000. After that the purse is five years of one adult's keep.
 * A shack is offered last and uses the small-farm purse rule.
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
  adultCost = 0,
  idMap: Int32Array | null = null,
  workshopsOpen = true,
  foundedYear = year,
  caravan: CaravanOffer | null = null,
): { holdings: Holdings; people: People; toTreasury: number; vacated: number[]; shops: ReadonlyMap<number, string> } {
  void seed
  const byId = new Map(structures.map((structure) => [structure.id, structure]))
  const rows = holdings.rows
    .filter((row) => {
      const structure = byId.get(row.structureId)
      return structure !== undefined && structure.kind !== "construction-office"
    })
    .map((row) => ({ ...row }))
  if (idMap) {
    for (const row of rows) {
      if (row.owner < 0) continue
      row.owner = row.owner < idMap.length ? idMap[row.owner] : -1
    }
  }
  for (const structure of structures) {
    if (structure.pending || structure.removing || structure.kind === "construction-office") continue
    if (rows.some((row) => row.structureId === structure.id)) continue
    rows.push({ structureId: structure.id, owner: -1, lease: 0, leaseMonth: month, paid: 0 })
  }

  const openedBooks = openIncomeMonth(people, month)
  const wealth = new Int32Array(openedBooks.wealth)
  const income = openedBooks.income
  const incomeLog = openedBooks.incomeLog
  let toTreasury = 0
  for (const row of rows) {
    if (row.owner < 0) continue
    if (row.owner < people.alive.length && people.alive[row.owner] !== 0) continue
    row.owner = -1
    row.lease = 0
    row.paid = 0
  }

  for (const row of rows) {
    if (row.lease <= 0 || row.leaseMonth !== month || row.owner < 0) continue
    if (wealth[row.owner] < row.lease) continue
    wealth[row.owner] -= row.lease
    const business = row.lease - homeLease(byId.get(row.structureId), row.lease)
    if (business > 0) noteOperatingIncome(income, incomeLog, row.owner, -business, month)
    toTreasury += row.lease
  }

  const unsold = rows.filter((row) => row.owner < 0)
  let opened = holdings.opened
  let vacated: number[] = []
  let shops: ReadonlyMap<number, string> = new Map()
  if (unsold.length > 0) {
    const quotes = new Map(unsold.map((row) => [row.structureId, quoteFor(byId.get(row.structureId) as Structure, terrain, feature, size, schedule)]))
    const owned = new Set<number>()
    for (const row of rows) if (row.owner >= 0) owned.add(row.owner)
    const offered = offerByWealth(unsold, quotes, byId, people, owned, wealth, income, incomeLog, month, adultCost, workshopsOpen, year, foundedYear, rows, caravan)
    toTreasury += offered.paid
    vacated = offered.vacated
    shops = offered.shops
    opened = true
  }

  return { holdings: { opened, rows }, people: { ...openedBooks, wealth, income, incomeLog }, toTreasury, vacated, shops }
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
  if (structure.kind === "construction-office") return [{ label: "Owner", value: "State" }]
  if (structure.pending) return [{ label: "Offer", value: "Not for sale yet" }]
  const row = holdings.rows.find((item) => item.structureId === structure.id)
  const living = householdLine(structure, holdings, people, row?.owner ?? -1)
  if (!row || row.owner < 0) {
    const quote = quoteFor(structure, terrain, feature, size, schedule)
    return [
      { label: "Offer", value: quote.tenure === "sale" ? "For sale" : "For lease" },
      { label: "Price", value: quote.tenure === "sale" ? dollars(quote.due) : `${dollars(quote.due)} a year` },
      ...(living ? [living] : []),
    ]
  }
  const houseName = people.surnames[people.surname[row.owner]]
  const lines: PropertyLine[] = [
    { label: "Owner", value: houseName || `Family ${row.owner}` },
    { label: "Purse", value: dollars(people.wealth[row.owner] ?? 0) },
  ]
  if (living) lines.push(living)
  if (row.lease > 0) lines.push({ label: "Lease", value: `${dollars(row.lease)} a year` })
  if (row.paid > 0) lines.push({ label: "Paid", value: dollars(row.paid) })
  if (row.lease > 0 || row.paid > 0) lines.push({ label: "Upkeep", value: `${fineMoney(monthlyCapital(row))} a month` })
  return lines
}

const HOUSEHOLD_KIND = new Set<Structure["kind"]>(["farmstead", "shack", "market", "trading-post", "caravan-house", "workshop", "sawpit", "shop"])

function householdLine(structure: Structure, holdings: Holdings, people: People, owner: number): PropertyLine | null {
  if (!HOUSEHOLD_KIND.has(structure.kind)) return null
  const owners = new Set<number>()
  for (const row of holdings.rows) if (row.owner >= 0) owners.add(row.owner)
  return { label: "Occupants", value: `${owner < 0 ? 0 : occupantCount(people, owner, owners)}` }
}

/** What the treasury pays to take this plot back. A lease is converted at twenty years. */
export function plotSalePrice(
  structure: Structure,
  terrain: Uint8Array,
  feature: Uint8Array,
  size: number,
  schedule: LandSchedule,
): number {
  const quote = quoteFor(structure, terrain, feature, size, schedule)
  return quote.tenure === "sale" ? quote.due : quote.due * SALE_PER_LEASE
}

/** One urban tile for a year: the lease, or a sale price divided by 20. */
export function yearlyUrbanTile(schedule: LandSchedule): number {
  const rate = schedule.urban
  return rate.tenure === "lease" ? rate.price : rate.price / SALE_PER_LEASE
}

/** Lease divided by 12, or the sale price divided by 20 and then by 12. */
export function monthlyCapital(row: Holding): number {
  if (row.lease > 0) return row.lease / 12
  return row.paid / 240
}

type CaravanOffer = {
  /** Dollars required besides the land price. */
  extra: (structure: Structure) => number
  /** A finished road reaches the map edge from this house. */
  linked: (structure: Structure) => boolean
  /** Man-hour bill paid to the treasury when the family buys. */
  labor: (structure: Structure) => number
  /** A specialty this purse can stock, or null when none of the ranked specialties fit. */
  shop?: {
    choose: (structure: Structure, purse: number) => string | null
    commit: (specialty: string) => void
  }
}

function offerByWealth(
  unsold: Holding[],
  quotes: Map<number, Quote>,
  byId: Map<number, Structure>,
  people: People,
  owned: ReadonlySet<number>,
  wealth: Int32Array,
  income: Int32Array,
  incomeLog: Int32Array,
  month: number,
  adultCost: number,
  workshopsOpen: boolean,
  year: number,
  foundedYear: number,
  rows: Holding[],
  caravan: CaravanOffer | null,
): { paid: number; vacated: number[]; shops: Map<number, string> } {
  let traders = caravanTraders(rows, byId, people)
  let seekers = propertySeekers(people, owned)
  const vacated: number[] = []
  const shops = new Map<number, string>()
  const open = [...unsold].sort((a, b) => {
    const left = byId.get(a.structureId) as Structure
    const right = byId.get(b.structureId) as Structure
    const rank = offerRank(left) - offerRank(right)
    const tiles = right.tiles.length - left.tiles.length
    return rank || tiles || a.structureId - b.structureId
  })
  let paid = 0
  for (const row of open) {
    if (row.owner >= 0) continue
    const structure = byId.get(row.structureId) as Structure
    if (structure.kind === "workshop" && !workshopsOpen) continue
    if (structure.kind === "caravan-house" && !caravan?.linked(structure)) continue
    const quote = quotes.get(row.structureId) as Quote
    if (structure.kind === "shop") {
      const chosen = settleShop(structure, quote, seekers, wealth, adultCost, caravan)
      if (!chosen) continue
      paid += assign(row, structure, quote, chosen.id, wealth, income, incomeLog, month)
      const labor = caravan?.labor(structure) ?? 0
      if (labor > 0 && chosen.id < wealth.length) {
        wealth[chosen.id] -= labor
        noteOperatingIncome(income, incomeLog, chosen.id, -labor, month)
        paid += labor
      }
      caravan?.shop?.commit(chosen.specialty)
      shops.set(structure.id, chosen.specialty)
      seekers = seekers.filter((id) => id !== chosen.id)
      continue
    }
    const builds = structure.kind === "caravan-house" || structure.kind === "workshop"
    const extra = builds ? caravan?.extra(structure) ?? (structure.kind === "caravan-house" ? Number.POSITIVE_INFINITY : 0) : 0
    const pool = structure.kind === "caravan-house" ? [...new Set([...traders, ...seekers])] : seekers
    const choices = pool
      .filter((id) => canBuy(wealth[id] ?? 0, quote, structure, adultCost, year, foundedYear, extra))
      .sort((a, b) => Number(traders.includes(b)) - Number(traders.includes(a)) || (wealth[b] ?? 0) - (wealth[a] ?? 0) || a - b)
    const pick = choices[0]
    if (pick === undefined) continue
    paid += assign(row, structure, quote, pick, wealth, income, incomeLog, month)
    if ((structure.kind === "caravan-house" || structure.kind === "workshop") && caravan) {
      const labor = caravan.labor(structure)
      if (labor > 0 && pick < wealth.length) {
        wealth[pick] -= labor
        noteOperatingIncome(income, incomeLog, pick, -labor, month)
        paid += labor
      }
      if (structure.kind === "caravan-house") vacated.push(...vacatePosts(rows, byId, pick))
    }
    seekers = seekers.filter((id) => id !== pick)
    traders = traders.filter((id) => id !== pick)
  }
  return { paid, vacated, shops }
}

/** The wealthiest seeker who can stock a ranked specialty. The purse is what remains after the land, the build, and a year of keep. */
function settleShop(
  structure: Structure,
  quote: Quote,
  seekers: readonly number[],
  wealth: Int32Array,
  adultCost: number,
  caravan: CaravanOffer | null,
): { id: number; specialty: string } | null {
  if (!caravan?.shop) return null
  const build = caravan.extra(structure)
  if (!Number.isFinite(build)) return null
  const keep = Math.max(0, Math.floor(adultCost))
  const ordered = [...seekers].sort((a, b) => (wealth[b] ?? 0) - (wealth[a] ?? 0) || a - b)
  for (const id of ordered) {
    const purse = (wealth[id] ?? 0) - quote.due - build - keep
    const specialty = caravan.shop.choose(structure, purse)
    if (!specialty) continue
    return { id, specialty }
  }
  return null
}

/** Heads who already run a trading post. They are offered a caravan house ahead of everyone else. */
function caravanTraders(rows: readonly Holding[], byId: Map<number, Structure>, people: People): number[] {
  const ids: number[] = []
  for (const row of rows) {
    if (row.owner < 0 || ids.includes(row.owner)) continue
    if (byId.get(row.structureId)?.kind !== "trading-post") continue
    if (row.owner >= people.alive.length || people.alive[row.owner] === 0) continue
    if ((people.retired?.[row.owner] ?? 0) !== 0) continue
    ids.push(row.owner)
  }
  return ids
}

/** The family's posts are left empty. The caller removes the buildings after the pantry has moved. */
function vacatePosts(rows: Holding[], byId: Map<number, Structure>, head: number): number[] {
  const ids: number[] = []
  for (const row of rows) {
    if (row.owner !== head || byId.get(row.structureId)?.kind !== "trading-post") continue
    ids.push(row.structureId)
    row.owner = -1
    row.lease = 0
    row.paid = 0
  }
  return ids
}

function offerRank(structure: Structure): number {
  if (structure.kind === "caravan-house") return -1
  if (structure.kind === "trading-post") return 0
  if (structure.kind === "market") return 1
  if (structure.kind === "workshop" || structure.kind === "shop") return 2
  if (structure.kind === "farmstead" && structure.tiles.length > LARGE_FARM) return 3
  if (structure.kind === "farmstead") return 4
  return 5
}

function needsPurse(structure: Structure): boolean {
  if (structure.kind === "trading-post" || structure.kind === "market" || structure.kind === "workshop" || structure.kind === "shop") return true
  return structure.kind === "farmstead" && structure.tiles.length > LARGE_FARM
}

/** The home's share of a lease. A farmstead's land is all business. A shop's land is all personal. A post, caravan house, workshop, market, or sawpit keeps two tiles personal. */
function homeLease(structure: Structure | undefined, lease: number): number {
  if (!structure || lease <= 0) return 0
  const tiles = structure.tiles.length
  if (structure.kind === "farmstead") return 0
  if (structure.kind === "trading-post" || structure.kind === "caravan-house" || structure.kind === "workshop" || structure.kind === "market" || structure.kind === "sawpit") {
    if (tiles <= 0) return 0
    return Math.round((lease * Math.min(2, tiles)) / tiles)
  }
  return lease
}

function assign(
  row: Holding,
  structure: Structure,
  quote: Quote,
  head: number,
  wealth: Int32Array,
  income: Int32Array,
  incomeLog: Int32Array,
  month: number,
): number {
  wealth[head] -= quote.due
  if (quote.tenure === "lease") {
    const business = quote.due - homeLease(structure, quote.due)
    if (business > 0) noteOperatingIncome(income, incomeLog, head, -business, month)
  }
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

function openingPurse(structure: Structure): number {
  if (structure.kind === "market") return OPENING_MARKET
  return OPENING_HOLDING
}

function canBuy(wealth: number, quote: Quote, structure: Structure, adultCost: number, year: number, foundedYear: number, extra = 0): boolean {
  if (structure.kind === "caravan-house") return wealth >= quote.due + extra
  if (structure.kind === "shop") return Number.isFinite(extra) && wealth >= quote.due + extra + Math.max(0, Math.floor(adultCost))
  if (structure.kind === "workshop") {
    const opening = openingPurse(structure)
    const keep = year < foundedYear + OPENING_YEARS ? opening : Math.max(opening, WEALTH_YEARS * Math.max(0, Math.floor(adultCost)))
    return wealth >= quote.due + extra + keep
  }
  if (!affordable(wealth, quote)) return false
  if (!needsPurse(structure)) return true
  const keep = year < foundedYear + OPENING_YEARS ? openingPurse(structure) : WEALTH_YEARS * Math.max(0, Math.floor(adultCost))
  return wealth >= keep
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
