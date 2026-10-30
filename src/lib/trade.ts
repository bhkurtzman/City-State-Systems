import { monthlyCapital, type Holding, type Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { copyIncomeLog, householdHomes, householdRanks, noteOperatingIncome, Sex, type People, type SocialClass } from "@/lib/people"
import { familyPortions, GOOD_LABEL, GOODS, SHELF_TARGET, type Farms, type Good, type ShopSpecialty } from "@/lib/produce"
import type { PropertyLine } from "@/lib/land"
import { isWater, type Structure } from "@/lib/buildings"
import { Feature, Terrain } from "@/lib/types"

/** Hundredths of a ton. */
const TON = 100
const TARGET_MONTHS = 3
/** Cover below this is a shortage: use has outrun production. */
const COVER_SHORT = 3
/** Cover above this is a surplus. A year of harvest plus three months of slack sits in between. */
const COVER_LONG = 15
const PRICE_CEILING = 100_000
/** Years of expected use a household or business holds back, and tries to buy up to. */
const STOCK_YEARS = 2
/** A market sells at this markup over what it paid. */
const MARKUP = 0.1
/** Smallest lot a market buys or sells. */
const RETAIL_MIN = 10
/** Smallest lot a farm, workshop, or post wholesales. */
const WHOLESALE_MIN = TON
/**
 * Expected tons a farm uses per year for each 1,000 dry tiles.
 * Steel is a 10% chance of 0.1 ton. Leather and textiles are a 5% chance.
 */
const FARM_STEEL_PER_THOUSAND = 0.1 * 0.1
const FARM_LEATHER_PER_THOUSAND = 0.05 * 0.1
const FARM_TEXTILE_PER_THOUSAND = 0.05 * 0.1
/** Chance a person of 13 or older buys 0.1 ton of clothing in January. Leather is half of this. Under 13, clothing is half and leather is never bought. */
const CLOTH_CHANCE: Record<SocialClass, number> = {
  poor: 0.02,
  working: 0.04,
  middle: 0.05,
  upper: 0.07,
  wealthy: 0.1,
}

type Deal = "retail" | "workshop" | "market"

type Routes = {
  farmIds: Set<number>
  workshopIds: Set<number>
  marketIds: number[]
  kindOf: Map<number, Structure["kind"]>
}

function bindRoutes(structures: readonly Structure[], ownedIds: ReadonlySet<number>) {
  const ids = (kind: Structure["kind"]) =>
    structures
      .filter((structure) => structure.kind === kind && !structure.pending && !structure.removing && ownedIds.has(structure.id))
      .map((structure) => structure.id)
  routes.farmIds = new Set(ids("farmstead"))
  routes.workshopIds = new Set(ids("workshop"))
  routes.marketIds = ids("market").sort((a, b) => a - b)
  routes.kindOf = new Map(structures.map((structure) => [structure.id, structure.kind]))
}

let routes: Routes = {
  farmIds: new Set(),
  workshopIds: new Set(),
  marketIds: [],
  kindOf: new Map(),
}

type UseContext = {
  farms: Farms
  prices: Record<Good, number>
  fee: number
  stock: Record<Good, number>
  stockOwner: Partial<Record<Good, number>>
  stockAsk: Partial<Record<Good, number>>
  targets: Map<number, Record<Good, number>>
  wealth: Int32Array
  /** Year's protein order per household head. The first good is the one they keep. */
  proteinOrders?: Map<number, Good[]>
  headOf?: Int32Array
  /** Where each good's price is heading. Workshops score a batch against these. */
  marks?: Record<Good, number>
  /** Class of each household head. Clothing and leather follow it. */
  rank?: Map<number, SocialClass>
}
const PRICE_FLOOR = 1

type IncomeBooks = { income: Int32Array; log: Int32Array; month: number }

/** Set for the month being settled. Cash from sales, fees, goods, and nothing else goes through credit. */
let books: IncomeBooks | null = null
/** Wood a finished construction office may sell to a market or workshop. */
let idleWoodOffices = new Set<number>()
/** Dollars paid to the treasury for state goods, and dollars the treasury spends buying them. */
let stateTill = 0
let stateSpent = 0

function credit(wealth: Int32Array, id: number, dollars: number) {
  if (!Number.isFinite(dollars) || dollars === 0) return
  if (id < 0) {
    if (dollars > 0) stateTill += dollars
    return
  }
  if (id >= wealth.length) return
  wealth[id] += dollars
  if (books) noteOperatingIncome(books.income, books.log, id, dollars, books.month)
}

type Quote = { price: number; export: boolean; import?: boolean }

/** What buyers in Western Europe pay per ton. Other regions use this list until they have their own. */
export const WEST_EUROPE: Record<Good, Quote | null> = {
  grain: { price: 180, export: true },
  fiber: { price: 350, export: true },
  fruit: null,
  "dried-fruit": { price: 225, export: true, import: false },
  vegetables: null,
  dairy: null,
  cheese: { price: 350, export: true, import: false },
  meat: null,
  hide: null,
  wood: { price: 15, export: true },
  lumber: { price: 40, export: true },
  barrels: { price: 400, export: true, import: false },
  fish: null,
  "cured-fish": { price: 300, export: true },
  "cured-meat": { price: 600, export: true },
  leather: { price: 900, export: false },
  textiles: { price: 550, export: false },
  clothing: { price: 700, export: false },
  coal: { price: 90, export: true },
  salt: { price: 90, export: true },
  steel: { price: 1200, export: true },
  "steel-parts": { price: 1500, export: true },
  "steel-tools": { price: 850, export: true },
}

/**
 * Expected supplies for one post over a year, priced at the foreign list:
 * 1 t grain, 0.05 t leather, 0.05 t textiles, 0.025 t steel tools.
 */
const SUPPLY_DOLLARS = 180 + 0.05 * 900 + 0.05 * 550 + 0.025 * 850

/**
 * A standard household of five (two adults, children 14, 8, and 3) for a year.
 * Wood is 26 tons at the foreign $15. The ask is not used here, or the fee would depend on itself.
 */
const KEEP_YEAR =
  26 * 15 +
  4.25 * 0.1 * 180 +
  4.25 * 0.3 * 1 +
  4.25 * 0.1 * 1 +
  3 * 0.05 * 0.1 * 900 +
  3 * 0.1 * 0.1 * 700 +
  2 * 0.05 * 0.1 * 700
const MONTHLY_KEEP = SUPPLY_DOLLARS / 12 + KEEP_YEAR / 12

export type Shipment = {
  postId: number
  good: Good
  way: "export" | "import"
  dollars: number
}

export type TownTrade = {
  prices: Record<Good, number>
  /** Hundredths of a ton the post is selling wholesale. */
  stock: Record<Good, number>
  /** Who is paid when the pool is bought from, per good. */
  stockOwner: Partial<Record<Good, number>>
  /** Dollars per ton a buyer pays for imported stock. The foreign price plus the importing post's fee. */
  stockAsk: Partial<Record<Good, number>>
  shipments: Shipment[]
  /** Calendar year the protein orders were chosen. */
  proteinYear?: number
  /** Household head to this year's protein order. The first good is the one they keep. */
  proteinPick?: Partial<Record<number, Good[]>>
}

export function emptyTown(): TownTrade {
  const prices = {} as Record<Good, number>
  const stock = {} as Record<Good, number>
  for (const good of GOODS) {
    prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
    stock[good] = 0
  }
  return { prices, stock, stockOwner: {}, stockAsk: {}, shipments: [] }
}

/** Dollars per ton. Land, the post's supplies, and a household's keep. Charged on the way out and added to the price on the way in. */
export function postFee(row: Holding): number {
  return Math.round(monthlyCapital(row) + MONTHLY_KEEP)
}

export function tradeLines(structure: Structure, holdings: Holdings, town: TownTrade): PropertyLine[] {
  if (structure.kind !== "trading-post" || structure.pending) return []
  const row = holdings.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) return []
  const fee = postFee(row)
  const bids = GOODS.filter((good) => WEST_EUROPE[good]?.export)
    .map((good) => `${GOOD_LABEL[good]} ${dollars(Math.max(0, (WEST_EUROPE[good] as Quote).price - fee))}`)
    .join(", ")
  const asks = GOODS.filter((good) => WEST_EUROPE[good] && WEST_EUROPE[good].import !== false)
    .map((good) => `${GOOD_LABEL[good]} ${dollars((WEST_EUROPE[good] as Quote).price + fee)}`)
    .join(", ")
  const lines: PropertyLine[] = [
    { label: "Fee", value: `${dollars(fee)} per ton` },
    { label: "Bids", value: bids },
    { label: "Asks", value: asks },
  ]
  const shipped = town.shipments.filter((item) => item.postId === structure.id)
  if (shipped.length > 0) {
    lines.push({
      label: "Shipped",
      value: shipped.map((item) => `${item.way === "export" ? "Out" : "In"} 1 t ${GOOD_LABEL[item.good].toLowerCase()}`).join(", "),
    })
  }
  return lines
}

export function marketLines(structure: Structure, farms: Farms): PropertyLine[] {
  if (structure.kind !== "market" || structure.pending) return []
  const row = farms.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) return []
  const lines: PropertyLine[] = [{ label: "Sells", value: "10% over cost" }]
  for (const good of GOODS) {
    const unit = row.cost?.[good]
    if (!unit || (row.store[good] ?? 0) <= 0) continue
    lines.push({ label: `${GOOD_LABEL[good]} price`, value: `${dollars(sellPrice(unit))} per ton` })
  }
  return lines
}

export function townPriceRows(
  town: TownTrade,
  farms: Farms,
  structures: readonly Structure[],
  holdings: Holdings,
  people: People | null,
  low: number,
  terrain: Uint8Array = new Uint8Array(),
  feature: Uint8Array = new Uint8Array(),
  lows: readonly number[] = [],
  seed = "",
  year = 0,
  urbanTile = 0,
): { label: string; value: string; note?: string; sub?: string }[] {
  const stock = totalStock(farms, town)
  const ownedIds = new Set(holdings.rows.filter((row) => row.owner >= 0).map((row) => row.structureId))
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : Array.from({ length: 12 }, () => low)
  const fee = cheapFee(holdings, structures) ?? 0
  const plan = people
    ? planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town, urbanTile)
    : null
  const targets = people ? stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices, plan ?? undefined) : new Map()
  bindRoutes(structures, ownedIds)
  const marketIds = structures.filter((structure) => structure.kind === "market" && !structure.pending && !structure.removing && owned.has(structure.id)).map((structure) => structure.id)
  const postCount = structures.filter((structure) => structure.kind === "trading-post" && !structure.pending && !structure.removing && owned.has(structure.id)).length
  const measure = (marks?: Record<Good, number>) =>
    monthlyUse(structures, people, low, ownedIds, terrain, feature, {
      farms,
      prices: town.prices,
      fee,
      stock: town.stock,
      stockOwner: town.stockOwner,
      stockAsk: town.stockAsk ?? {},
      targets,
      wealth: people?.wealth ?? new Int32Array(),
      proteinOrders: plan?.orders,
      headOf: plan?.headOf,
      rank: plan?.rank,
      marks,
    })
  const quote = quotedPrices(stock, town.prices, fee, postCount, measure)
  const selling = marketSale(farms, marketIds)
  const use = measure(quote)
  return GOODS.map((good) => {
    const foreign = WEST_EUROPE[good]
    const onHand = stock[good] / TON
    const note = [
      foreign ? `Foreign $${foreign.price}` : "Local only",
      `${onHand.toLocaleString("en-US", { maximumFractionDigits: 2 })} t on hand`,
      use[good] > 0 ? `${use[good].toLocaleString("en-US", { maximumFractionDigits: 2 })} t a month` : "",
    ]
      .filter(Boolean)
      .join(" · ")
    const market = selling[good]
    return { label: GOOD_LABEL[good], value: market == null ? "—" : dollars(market), sub: dollars(quote[good]), note }
  })
}

/**
 * One household's year, and the smaller share for each extra person.
 * Food, working-class clothing and leather, a full year of fuel, and two
 * urban tiles. The extra share is food, clothing, and leather at three quarters.
 */
export function livingCosts(prices: Record<Good, number>, lows: readonly number[], urbanTile = 0): { full: number; member: number } {
  const price = (good: Good) => prices[good] ?? PRICE_FLOOR
  const board =
    price("grain") * 0.1 +
    ((price("fruit") + price("vegetables")) / 2) * 0.3 +
    price("meat") * 0.1 * 0.1 +
    price("fish") * 0.1 * 0.45 +
    price("dairy") * 0.4 * 0.45 +
    price("clothing") * 0.004 +
    price("leather") * 0.002
  const woodYear = lows.reduce((sum, value) => sum + (value < 4 ? 4 : 2), 0)
  const wood = price("wood")
  const coal = price("coal")
  const fuel = wood * 4 <= coal ? woodYear * wood : (woodYear / 4) * coal
  return { full: Math.round(board + fuel + urbanTile * 2), member: Math.round(board * 0.75) }
}

/** The full household cost: food, working-class clothing and leather, fuel, and two urban tiles. */
export function costOfLiving(prices: Record<Good, number>, lows: readonly number[], urbanTile = 0): number {
  return livingCosts(prices, lows, urbanTile).full
}

/**
 * The cheapest post sets the bid and the ask. Each post ships one ton of whatever
 * high-score good it rolls, so the same good can leave more than once. A good that
 * left is not imported in the same month.
 */
export function tradeMonth(
  people: People,
  farms: Farms,
  structures: readonly Structure[],
  holdings: Holdings,
  town: TownTrade,
  month: number,
  year: number,
  low: number,
  seed: string,
  lows: readonly number[] = [],
  terrain: Uint8Array = new Uint8Array(),
  feature: Uint8Array = new Uint8Array(),
  high = 0,
  precip = 0,
  urbanTile = 0,
  stateNeeds: readonly { structureId: number; good: Good; hundredths: number }[] = [],
  idleWood: readonly number[] = [],
): { people: People; farms: Farms; town: TownTrade; toTreasury: number } {
  const wealth = new Int32Array(people.wealth)
  const income = new Int32Array(people.income ?? people.age.length)
  const incomeLog = copyIncomeLog(people, people.age.length)
  books = { income, log: incomeLog, month }
  idleWoodOffices = new Set(idleWood)
  stateTill = 0
  stateSpent = 0
  const rows = farms.rows.map((row) => ({
    ...row,
    store: { ...emptyGoods(), ...row.store },
    trade: row.trade ? { ...row.trade } : undefined,
  }))
  for (const row of rows) for (const good of GOODS) if (!Number.isFinite(row.store[good])) row.store[good] = 0
  const nextFarms: Farms = { rows }
  const stock = { ...town.stock }
  const stockOwner = { ...town.stockOwner }
  const stockAsk = { ...(town.stockAsk ?? {}) }
  for (const good of GOODS) if (stock[good] == null) stock[good] = 0
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : [low]
  const protein = planProtein(people, structures, owned, nextFarms, town.prices, yearLows, terrain, feature, seed, year, month, town, urbanTile)
  bindProteinSales(protein.sources, protein.farmsteads)
  const posts = structures
    .filter((structure) => structure.kind === "trading-post" && !structure.pending && !structure.removing && owned.has(structure.id))
    .map((structure) => owned.get(structure.id) as Holding)
    .sort((a, b) => postFee(a) - postFee(b) || a.structureId - b.structureId)

  const shipments: Shipment[] = []
  const exported = new Set<Good>()
  const ownedIds = new Set(owned.keys())
  const targets = stockTargets(people, structures, owned, yearLows, terrain, feature, nextFarms, town.prices, protein)
  dryFruit(nextFarms, structures, owned, targets, high, precip)
  makeCoal(nextFarms, structures, owned, targets, feature, month)
  const marketIds = marketStructures(structures, owned)
  bindRoutes(structures, ownedIds)
  for (const row of nextFarms.rows) foldBin(row)
  feedHouseholds(people, structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, terrain, feature, seed, year, month, protein.orders, protein.headOf)
  const tradeContext = (): UseContext => ({
    farms: nextFarms,
    prices: town.prices,
    fee: posts.length > 0 ? postFee(posts[0]) : 0,
    stock,
    stockOwner,
    stockAsk,
    targets,
    wealth,
    proteinOrders: protein.orders,
    headOf: protein.headOf,
    rank: protein.rank,
  })
  const use = monthlyUse(structures, people, low, ownedIds, terrain, feature, tradeContext())
  for (const post of posts) {
    const fee = postFee(post)
    const rng = mulberry32(hashSeed(`${seed}:export:${post.structureId}:${year}:${month}`))
    const ranked = rankedExports(nextFarms, stock, targets, fee, marketIds.length === 0, use)
    if (ranked.length === 0) break
    const start = pickExport(ranked, rng)
    for (let attempt = 0; attempt < 5 && start + attempt < ranked.length; attempt++) {
      const good = ranked[start + attempt]
      const bid = (WEST_EUROPE[good] as Quote).price - fee
      if (!shipExport(nextFarms, targets, wealth, good, bid, rng)) continue
      credit(wealth, post.owner, fee)
      exported.add(good)
      shipments.push({ postId: post.structureId, good, way: "export", dollars: bid })
      break
    }
  }

  const imported = new Set<Good>()
  for (const post of posts) {
    const fee = postFee(post)
    const good = worstShort(nextFarms, stock, structures, people, low, imported, exported, ownedIds, terrain, feature, tradeContext())
    if (!good) break
    const regional = (WEST_EUROPE[good] as Quote).price
    if (wealth.length <= post.owner || wealth[post.owner] < regional) continue
    credit(wealth, post.owner, -regional)
    stock[good] += TON
    stockOwner[good] = post.owner
    stockAsk[good] = regional + fee
    imported.add(good)
    shipments.push({ postId: post.structureId, good, way: "import", dollars: regional + fee })
  }
  fillShelves(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, month)

  burnFuel(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, low)
  if (month === 10) {
    for (const post of posts) feedPostGrain(post, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, postFee(post))
  }
  if (month === 0) {
    for (const post of posts) feedPost(post, nextFarms, stock, stockOwner, year, seed)
    feedFarms(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, terrain, feature, year, seed)
    feedShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, seed)
    wear(people, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, seed, protein.rank, protein.headOf)
  }
  const prices = { ...town.prices }
  for (const good of GOODS) if (prices[good] == null) prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
  const feeNow = posts.length > 0 ? postFee(posts[0]) : 0
  const measure = (marks?: Record<Good, number>) =>
    monthlyUse(structures, people, low, ownedIds, terrain, feature, { ...tradeContext(), marks })
  const shopMarks = quotedPrices(totalStock(nextFarms, { ...town, stock }), prices, feeNow, posts.length, measure)
  runShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, posts, month, shopMarks)
  fillShelves(nextFarms, stock, stockOwner, stockAsk, wealth, prices, targets, posts, month)
  restock(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, protein.orders, protein.headOf)
  for (const need of stateNeeds) {
    if (need.hundredths <= 0) continue
    const row = nextFarms.rows.find((item) => item.structureId === need.structureId)
    if (!row) continue
    const deal = need.hundredths >= TON ? "workshop" : "retail"
    const bought = buyGoods(nextFarms, stock, stockOwner, stockAsk, wealth, -1, need.good, need.hundredths, prices, targets, marketIds, feeNow, deal)
    if (bought.taken > 0) row.store[need.good] = (row.store[need.good] ?? 0) + bought.taken
  }
  for (const good of GOODS) {
    if ((stock[good] ?? 0) > 0) continue
    stock[good] = 0
    delete stockOwner[good]
    delete stockAsk[good]
  }

  const after = totalStock(nextFarms, { ...town, stock })
  const desired = quotedPrices(after, prices, feeNow, posts.length, measure)
  for (const good of GOODS) prices[good] = glidePrice(prices[good], desired[good])

  const toTreasury = stateTill - stateSpent
  books = null
  idleWoodOffices = new Set()
  stateTill = 0
  stateSpent = 0
  sellProtein = () => true
  return {
    people: { ...people, wealth, income, incomeLog },
    farms: nextFarms,
    town: { prices, stock, stockOwner, stockAsk, shipments, proteinYear: year, proteinPick: storeProteinPick(protein.orders, people, protein.headOf) },
    toTreasury,
  }
}

function glidePrice(price: number, desired: number): number {
  const next = Math.round(price + 0.25 * (desired - price))
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, next))
}

/** Months of stock. Null when the good is neither used nor stored. */
function coverMonths(stock: number, use: number): number | null {
  if (use <= 0 && stock <= 0) return null
  if (use <= 0) return Number.POSITIVE_INFINITY
  return (stock / TON) / use
}

/** The last ton is the smallest import. Price cover ignores it. Import cover still counts it. */
function priceStock(stock: number): number {
  return Math.max(0, stock - TON)
}

function tradeEnds(good: Good, fee: number): { list: number | null; bid: number | null; ask: number | null } {
  const foreign = WEST_EUROPE[good]
  if (!foreign) return { list: null, bid: null, ask: null }
  const charge = fee > 0 ? fee : 0
  const bid = foreign.export ? Math.max(PRICE_FLOOR, foreign.price - charge) : null
  const ask = foreign.import === false ? null : foreign.price + charge
  return { list: foreign.price, bid, ask }
}

function saturations(stock: Record<Good, number>, use: Record<Good, number>, fee: number, posts: number): { imports: number; exports: number } {
  const slots = posts * 12
  let exportPile = 0
  let importPile = 0
  for (const good of GOODS) {
    const cover = coverMonths(stock[good] ?? 0, use[good] ?? 0)
    if (cover === null) continue
    const ends = tradeEnds(good, fee)
    const tons = (stock[good] ?? 0) / TON
    if (cover > COVER_LONG && ends.bid !== null) exportPile += Math.max(0, tons - COVER_LONG * (use[good] ?? 0))
    if (cover < COVER_SHORT && ends.ask !== null) importPile += Math.max(0, COVER_SHORT * (use[good] ?? 0) - tons)
  }
  const ratio = (pile: number) => (pile <= 0 ? 0 : slots <= 0 ? 1 : pile / (pile + slots))
  return { imports: ratio(importPile), exports: ratio(exportPile) }
}

/**
 * The price a good is heading toward. From 3 to 15 months of cover it sits on the
 * foreign list. A shortage can rise above the import ask once the year's import
 * slots are full. A surplus can fall below the export bid once the export slots are full.
 */
function desiredPrice(
  good: Good,
  posted: number,
  stock: number,
  use: number,
  fee: number,
  pressure: { imports: number; exports: number },
): number {
  const ends = tradeEnds(good, fee)
  const sticker = Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, posted))
  const cover = coverMonths(priceStock(stock), use)
  if (cover === null) return clampPrice(ends.list ?? sticker)
  if (cover < COVER_SHORT) {
    const safe = Math.max(cover, 0.05)
    if (ends.ask === null) return clampPrice(sticker * Math.sqrt(COVER_SHORT / safe))
    const lifted = ends.ask * Math.sqrt(COVER_SHORT / safe)
    return clampPrice(ends.ask + (lifted - ends.ask) * pressure.imports)
  }
  if (cover > COVER_LONG) {
    const finite = Math.min(cover, 1e6)
    if (ends.bid === null) return clampPrice(sticker * Math.sqrt(COVER_LONG / finite))
    const domestic = ends.bid * Math.sqrt(COVER_LONG / finite)
    return clampPrice(ends.bid + (domestic - ends.bid) * pressure.exports)
  }
  return clampPrice(ends.list ?? sticker)
}

function clampPrice(value: number): number {
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, value))
}

/** Cheapest price a market with the good in its barn is asking. */
function marketSale(farms: Farms, marketIds: readonly number[]): Partial<Record<Good, number>> {
  const ask: Partial<Record<Good, number>> = {}
  for (const row of farms.rows) {
    if (!marketIds.includes(row.structureId)) continue
    for (const good of GOODS) {
      const cost = row.cost?.[good]
      if (!cost || (row.store[good] ?? 0) <= 0) continue
      const sale = sellPrice(cost)
      const prior = ask[good]
      if (prior === undefined || sale < prior) ask[good] = sale
    }
  }
  return ask
}

/** One ton a year, in tons per month. A good the town does not use is priced at this rate. */
const ASSUMED_MONTHLY_USE = 1 / 12

function assumedUse(use: Record<Good, number>): Record<Good, number> {
  const next = { ...use }
  for (const good of GOODS) if ((next[good] ?? 0) <= 0) next[good] = ASSUMED_MONTHLY_USE
  return next
}

/** Local foods and hides have no export list. These are the highest town quotes they can reach. */
const LOCAL_PRICE_CAP: Partial<Record<Good, number>> = {
  fish: 100,
  meat: 200,
  dairy: 30,
  vegetables: 35,
  fruit: 45,
  hide: 700,
}

function priceCeiling(good: Good, localMonthly: number): number {
  const foreign = WEST_EUROPE[good]
  if ((localMonthly ?? 0) <= 0 && foreign?.export) return foreign.price
  if (!foreign?.export) return LOCAL_PRICE_CAP[good] ?? PRICE_CEILING
  return PRICE_CEILING
}

function priceMarks(
  stock: Record<Good, number>,
  use: Record<Good, number>,
  posted: Record<Good, number>,
  fee: number,
  posts: number,
): Record<Good, number> {
  const demand = assumedUse(use)
  const priced = {} as Record<Good, number>
  for (const good of GOODS) priced[good] = priceStock(stock[good] ?? 0)
  const pressure = saturations(priced, demand, fee, posts)
  const marks = {} as Record<Good, number>
  for (const good of GOODS) {
    const quote = desiredPrice(good, posted[good] ?? PRICE_FLOOR, stock[good] ?? 0, demand[good] ?? 0, fee, pressure)
    marks[good] = Math.min(quote, priceCeiling(good, use[good] ?? 0))
  }
  return marks
}

function quotedPrices(
  stock: Record<Good, number>,
  posted: Record<Good, number>,
  fee: number,
  posts: number,
  measure: (marks?: Record<Good, number>) => Record<Good, number>,
): Record<Good, number> {
  const draft = priceMarks(stock, measure(undefined), posted, fee, posts)
  return priceMarks(stock, measure(draft), posted, fee, posts)
}

/** Spare tons divided by tons used in a year. A good nobody uses is scored as if the town used one ton. */
function exportScore(spareHundredths: number, monthly: number): number {
  return spareHundredths / TON / Math.max(monthly * 12, 1)
}

function rankedExports(
  farms: Farms,
  stock: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  fee: number,
  includePool: boolean,
  use: Record<Good, number>,
): Good[] {
  const ranked: { good: Good; score: number }[] = []
  for (const good of GOODS) {
    const foreign = WEST_EUROPE[good]
    if (!foreign?.export || foreign.price - fee < 1) continue
    const score = exportScore(exportable(farms, stock, targets, good, includePool), use[good] ?? 0)
    if (score > 1.1) ranked.push({ good, score })
  }
  ranked.sort((a, b) => b.score - a.score || GOODS.indexOf(a.good) - GOODS.indexOf(b.good))
  return ranked.map((item) => item.good)
}

/** 80% the highest export score, 10% the second, 10% one of the rest. The index is where a post starts. */
function pickExport(ranked: readonly Good[], rng: () => number): number {
  if (ranked.length <= 1) return 0
  const roll = rng()
  if (roll < 0.8) return 0
  if (roll < 0.9 || ranked.length === 2) return 1
  return 2 + Math.min(ranked.length - 3, Math.floor(rng() * (ranked.length - 2)))
}

function worstShort(
  farms: Farms,
  stock: Record<Good, number>,
  structures: readonly Structure[],
  people: People | null,
  low: number,
  skip: Set<Good>,
  exported: Set<Good>,
  ownedIds: Set<number>,
  terrain: Uint8Array,
  feature: Uint8Array,
  context?: UseContext,
): Good | null {
  const use = monthlyUse(structures, people, low, ownedIds, terrain, feature, context)
  const onHand = totalStock(farms, { prices: emptyTown().prices, stock, stockOwner: {}, stockAsk: {}, shipments: [] })
  let best: Good | null = null
  let cover = TARGET_MONTHS
  let need = 0
  for (const good of GOODS) {
    const foreign = WEST_EUROPE[good]
    if (!foreign || foreign.import === false || skip.has(good) || exported.has(good) || use[good] <= 0) continue
    const months = onHand[good] / TON / use[good]
    if (months < cover || (months === cover && use[good] > need)) {
      cover = months
      need = use[good]
      best = good
    }
  }
  return best
}

function burnFuel(
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  low: number,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  const woodFirst = preferWood(prices)
  const good: Good = woodFirst ? "wood" : "coal"
  const need = woodFirst ? (low < 4 ? 4 : 2) * TON : low < 4 ? TON : TON / 2
  for (const structure of structures) {
    const row = owned.get(structure.id)
    if (!row || !heatsHouse(structure, farms)) continue
    const left = need - takeOwned(farms, stock, stockOwner, row.owner, good, need)
    if (left > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, row.owner, good, left, prices, targets, marketIds, fee, dealFor(structure.id))
  }
}

/** Dry farm tiles per thousand. Water and wetland do not wear tools. */
function dryFarmScale(structure: Structure, terrain: Uint8Array, feature: Uint8Array): number {
  if (structure.kind !== "farmstead" || structure.pending || structure.removing) return 0
  let land = 0
  for (const index of structure.tiles) if (!isWater(terrain, feature, index)) land += 1
  return land / 1000
}

/** January. Each farm rolls once: 0.1 ton of tools, with the chance scaled by dry land. */
function feedFarms(
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  terrain: Uint8Array,
  feature: Uint8Array,
  year: number,
  seed: string,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (const structure of structures) {
    const row = owned.get(structure.id)
    if (!row) continue
    const scale = dryFarmScale(structure, terrain, feature)
    if (scale <= 0) continue
    const rng = mulberry32(hashSeed(`${seed}:farm-supply:${structure.id}:${year}`))
    if (rng() < Math.min(1, 0.1 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee, "retail")
    if (rng() < Math.min(1, 0.05 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "leather", 10, prices, targets, marketIds, fee, "retail")
    if (rng() < Math.min(1, 0.05 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "textiles", 10, prices, targets, marketIds, fee, "retail")
  }
}

const DIET: readonly Good[] = ["grain", "fruit", "vegetables", "meat", "fish", "dairy"]
const HARVEST_MONTH: Partial<Record<Good, number>> = {
  fish: 3,
  dairy: 4,
  vegetables: 6,
  fruit: 7,
  grain: 9,
  meat: 10,
}
/** A market fills these the month after the harvest. Other months it buys only what a bidder asks. */
const SHELF_MONTH: Partial<Record<Good, number>> = {
  fish: 4,
  dairy: 5,
  vegetables: 7,
  fruit: 8,
  grain: 10,
  meat: 11,
}

/**
 * One year of food per household. A farm eats a food it grows in that crop's harvest month.
 * Everyone else buys it in the household head's birth month. Fruit or vegetables is an even
 * chance, or three to one toward the crop the farm grows, unless one costs more than ten
 * times the other. Then the household takes the cheaper one. Leftover food is kept only when
 * the household produces it or a workshop uses it. Anything else is wasted.
 */
function feedHouseholds(
  people: People,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  posts: Holding[],
  terrain: Uint8Array,
  feature: Uint8Array,
  seed: string,
  year: number,
  month: number,
  orders: Map<number, Good[]>,
  headOf: Int32Array,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  const diets = new Map<number, { produced: Set<Good>; fruit: boolean; veg: boolean; keep: Set<Good> }>()
  const diet = (head: number) => {
    let bag = diets.get(head)
    if (!bag) {
      bag = { produced: new Set(), fruit: false, veg: false, keep: new Set() }
      diets.set(head, bag)
    }
    return bag
  }
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    const holding = owned.get(structure.id)
    if (!holding || holding.owner < 0) continue
    const bag = diet(homeHead(headOf, holding.owner))
    const record = farms.rows.find((row) => row.structureId === structure.id)
    if (structure.kind === "farmstead") {
      const uses = record?.uses ?? []
      if (uses.includes("grain") || uses.includes("fiber")) bag.produced.add("grain")
      if (uses.includes("vegetables")) {
        bag.produced.add("vegetables")
        bag.veg = true
      }
      if (uses.includes("fruit")) {
        bag.produced.add("fruit")
        bag.fruit = true
      }
      if (uses.includes("dairy")) bag.produced.add("dairy")
      if (uses.includes("meat")) bag.produced.add("meat")
      for (const tile of structure.tiles) {
        const ground = terrain[tile]
        if (ground === Terrain.Sea || ground === Terrain.Fresh) bag.produced.add("fish")
        const cover = feature[tile]
        if (cover === Feature.Woodland) {
          bag.produced.add("fruit")
          bag.produced.add("meat")
        } else if (cover === Feature.Forest) {
          bag.produced.add("vegetables")
          bag.produced.add("meat")
        } else if (cover === Feature.Wetland) bag.produced.add("meat")
      }
    }
    if (structure.kind === "workshop" && record?.specialty === "creamery") bag.keep.add("dairy")
    if (structure.kind === "workshop" && record?.specialty === "smokehouse") {
      bag.keep.add("fish")
      bag.keep.add("meat")
    }
  }

  const held = (head: number, good: Good) => {
    let total = 0
    for (const row of farms.rows) {
      if (routes.marketIds.includes(row.structureId) || homeHead(headOf, row.owner) !== head) continue
      total += row.store[good] ?? 0
    }
    if (stockOwner[good] !== undefined && homeHead(headOf, stockOwner[good] ?? -1) === head) total += stock[good] ?? 0
    return total
  }
  const canFeed = (head: number, good: Good, hundredths: number) => {
    const have = held(head, good)
    if (have >= hundredths) return true
    const deal = buyerDeal(farms, head)
    const short = hundredths - have
    const onOffer = proteinForSale(farms, stock, stockOwner, targets, good, head, deal) || seasonalForSale(farms, stock, stockOwner, stockAsk, wealth, prices, targets, good, head, short, fee)
    if (!onOffer) return false
    const cost = Math.round((offerPrice(good, prices, fee) * short) / TON)
    return wealth.length > head && (wealth[head] ?? 0) >= cost
  }
  const eat = (head: number, good: Good, hundredths: number) => {
    if (hundredths <= 0) return
    let left = hundredths
    for (const row of farms.rows) {
      if (left <= 0) break
      if (routes.marketIds.includes(row.structureId) || homeHead(headOf, row.owner) !== head) continue
      const take = Math.min(row.store[good] ?? 0, left)
      row.store[good] -= take
      left -= take
    }
    if (left > 0 && stockOwner[good] !== undefined && homeHead(headOf, stockOwner[good] ?? -1) === head) {
      const take = Math.min(stock[good] ?? 0, left)
      stock[good] -= take
      left -= take
    }
    if (left > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, head, good, left, prices, targets, [], fee, buyerDeal(farms, head))
  }

  for (let head = 0; head < people.alive.length; head++) {
    if (people.alive[head] === 0 || homeHead(headOf, head) !== head) continue
    const family = familyPortions(people, head)
    if (family.scale <= 0) continue
    const bag = diet(head)
    const birth = people.birthMonth[head] ?? 0
    const grain = Math.round(family.scale * 10)
    const gardenNeed = Math.round(family.scale * 30)
    const fruitPrice = offerPrice("fruit", prices, fee)
    const vegPrice = offerPrice("vegetables", prices, fee)
    const fruitChance = bag.fruit && !bag.veg ? 0.75 : bag.veg && !bag.fruit ? 0.25 : 0.5
    const roll = mulberry32(hashSeed(`${seed}:garden:${head}:${year}`))()
    const garden: Good = fruitPrice > vegPrice * 10 ? "vegetables" : vegPrice > fruitPrice * 10 ? "fruit" : roll < fruitChance ? "fruit" : "vegetables"
    const other: Good = garden === "fruit" ? "vegetables" : "fruit"
    const due = (good: Good) => month === (bag.produced.has(good) ? HARVEST_MONTH[good] : birth)
    if (due("grain")) eat(head, "grain", grain)
    if (due(garden)) {
      const choice = !bag.produced.has(garden) && !canFeed(head, garden, gardenNeed) && canFeed(head, other, gardenNeed) ? other : garden
      eat(head, choice, gardenNeed)
    }
    const protein = orders.get(head) ?? []
    const first = protein[0]
    if (first && due(first)) {
      const fallback = protein.find((good) => good !== first && canFeed(head, good, Math.round(family.scale * proteinTons(good) * TON)))
      const choice = !bag.produced.has(first) && !canFeed(head, first, Math.round(family.scale * proteinTons(first) * TON)) && fallback ? fallback : first
      eat(head, choice, Math.round(family.scale * proteinTons(choice) * TON))
    }
  }

  for (const row of farms.rows) {
    if (routes.marketIds.includes(row.structureId)) continue
    const bag = diets.get(homeHead(headOf, row.owner))
    for (const good of DIET) {
      if (bag?.produced.has(good) || bag?.keep.has(good)) continue
      row.store[good] = 0
    }
  }
}

/** November, the month after the grain harvest. */
function feedPostGrain(
  post: Holding,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  fee: number,
) {
  const grain = TON - takeOwned(farms, stock, stockOwner, post.owner, "grain", TON)
  if (grain > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, post.owner, "grain", grain, prices, targets, marketIds, fee, buyerDeal(farms, post.owner))
}

function feedPost(post: Holding, farms: Farms, stock: Record<Good, number>, stockOwner: Partial<Record<Good, number>>, year: number, seed: string) {
  const rng = mulberry32(hashSeed(`${seed}:supply:${post.structureId}:${year}`))
  if (rng() < 0.5) takeOwned(farms, stock, stockOwner, post.owner, "leather", 10)
  if (rng() < 0.5) takeOwned(farms, stock, stockOwner, post.owner, "textiles", 10)
  if (rng() < 0.25) takeOwned(farms, stock, stockOwner, post.owner, "steel-tools", 10)
}

function wear(
  people: People,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  year: number,
  seed: string,
  rank: Map<number, SocialClass>,
  headOf: Int32Array,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const rng = mulberry32(hashSeed(`${seed}:wear:${year}:${id}`))
    const buyer = purseOf(people, id)
    const clothing = CLOTH_CHANCE[rank.get(homeHead(headOf, id)) ?? "poor"]
    if (people.age[id] >= 13) {
      if (rng() < clothing / 2) buyNeed(farms, stock, stockOwner, stockAsk, wealth, buyer, "leather", 10, prices, targets, marketIds, fee, "retail")
      if (rng() < clothing) buyNeed(farms, stock, stockOwner, stockAsk, wealth, buyer, "clothing", 10, prices, targets, marketIds, fee, "retail")
    } else if (rng() < clothing / 2) buyNeed(farms, stock, stockOwner, stockAsk, wealth, buyer, "clothing", 10, prices, targets, marketIds, fee, "retail")
  }
}

function buyNeed(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  head: number,
  good: Good,
  hundredths: number,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  fee: number,
  deal: Deal,
) {
  const owned = takeOwned(farms, stock, stockOwner, head, good, hundredths)
  const rest = hundredths - owned
  if (rest > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, head, good, rest, prices, targets, marketIds, fee, deal)
}

function takeOwned(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  owner: number,
  good: Good,
  hundredths: number,
): number {
  let left = hundredths
  for (const row of farms.rows) {
    if (left <= 0) break
    if (row.owner !== owner) continue
    const taken = Math.min(row.store[good] ?? 0, left)
    row.store[good] = (row.store[good] ?? 0) - taken
    left -= taken
  }
  if (left > 0 && stockOwner[good] === owner) {
    const taken = Math.min(stock[good] ?? 0, left)
    stock[good] -= taken
    left -= taken
  }
  return hundredths - left
}

/** Hundredths of a good above each owner's two-year reserve. The pool is sold only when nobody is still short. */
function exportable(farms: Farms, stock: Record<Good, number>, targets: Map<number, Record<Good, number>>, good: Good, includePool: boolean): number {
  const seen = new Set<number>()
  let extra = 0
  let short = false
  for (const row of farms.rows) {
    if (seen.has(row.owner)) continue
    seen.add(row.owner)
    const reserve = targets.get(row.owner)?.[good] ?? 0
    const held = barnHeld(farms, row.owner, good)
    extra += Math.max(0, held - reserve)
    if (reserve > 0 && held < reserve) short = true
  }
  for (const [owner, need] of targets) {
    if (seen.has(owner)) continue
    if ((need[good] ?? 0) > 0) short = true
  }
  if (includePool && !short) extra += stock[good] ?? 0
  for (const row of farms.rows) extra += row.trade?.[good] ?? 0
  return extra
}

/** Five tons of fruit become one ton of dried fruit, once per farm, in a hot dry month. The two-year fruit pantry stays. */
function dryFruit(
  farms: Farms,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  targets: Map<number, Record<Good, number>>,
  high: number,
  precip: number,
) {
  if (high < 29 || precip > 25) return
  const batch = 5 * TON
  for (const structure of [...structures].sort((a, b) => a.id - b.id)) {
    if (structure.kind !== "farmstead" || structure.pending || structure.removing) continue
    const holding = owned.get(structure.id)
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!holding || !row || (row.store.fruit ?? 0) < batch) continue
    const reserve = targets.get(row.owner)?.fruit ?? 0
    if (barnHeld(farms, row.owner, "fruit") - batch < reserve) continue
    row.store.fruit -= batch
    row.store["dried-fruit"] = (row.store["dried-fruit"] ?? 0) + TON
  }
}

function barnHeld(farms: Farms, owner: number, good: Good): number {
  let held = 0
  for (const row of farms.rows) if (row.owner === owner) held += row.store[good] ?? 0
  return held
}

/** Hundredths the market still needs so this barn shows the full shelf above the household reserve. 0 when the shelf is at least half full. */
function shelfGap(
  farms: Farms,
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  targets: Map<number, Record<Good, number>>,
  target: number,
): number {
  const reserve = targets.get(row.owner)?.[good] ?? 0
  const onRow = row.store[good] ?? 0
  const elsewhere = barnHeld(farms, row.owner, good) - onRow
  const reserveHere = Math.max(0, reserve - elsewhere)
  const shelf = Math.max(0, onRow - reserveHere)
  if (shelf * 2 >= target) return 0
  return Math.max(0, reserveHere + target - onRow)
}

/** Stock on this barn above the owner's reserve. The reserve is met from other barns first. */
function sellable(
  farms: Farms,
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  targets: Map<number, Record<Good, number>>,
): number {
  const reserve = targets.get(row.owner)?.[good] ?? 0
  return Math.max(0, Math.min(row.store[good] ?? 0, barnHeld(farms, row.owner, good) - reserve))
}

/** A year of protein is 0.1 t of meat, 0.1 t of fish, or 0.4 t of dairy. */
const PROTEINS: readonly Good[] = ["meat", "dairy", "fish"]

function proteinTons(good: Good): number {
  return good === "dairy" ? 0.4 : 0.1
}

function proteinBasket(good: Good, prices: Record<Good, number>): number {
  return (prices[good] ?? PRICE_FLOOR) * proteinTons(good)
}

/** Farmsteads may sell a protein only when that farm produces it. Other barns sell as before. */
let sellProtein: (structureId: number, good: Good) => boolean = () => true

function producedOn(
  structures: readonly Structure[],
  farms: Farms,
  terrain: Uint8Array,
  feature: Uint8Array,
): { sources: Map<number, Set<Good>>; farmsteads: Set<number> } {
  const sources = new Map<number, Set<Good>>()
  const farmsteads = new Set<number>()
  for (const structure of structures) {
    if (structure.kind !== "farmstead" || structure.pending || structure.removing) continue
    farmsteads.add(structure.id)
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row) continue
    const made = new Set<Good>()
    if (row.uses.includes("dairy")) made.add("dairy")
    if (row.uses.includes("meat")) made.add("meat")
    for (const tile of structure.tiles) {
      const ground = terrain[tile]
      if (ground === Terrain.Sea || ground === Terrain.Fresh) made.add("fish")
      const cover = feature[tile]
      if (cover === Feature.Woodland || cover === Feature.Forest || cover === Feature.Wetland) made.add("meat")
    }
    sources.set(structure.id, made)
  }
  return { sources, farmsteads }
}

function bindProteinSales(sources: Map<number, Set<Good>>, farmsteads: Set<number>) {
  sellProtein = (structureId, good) => {
    if (good !== "meat" && good !== "fish" && good !== "dairy") return true
    if (!farmsteads.has(structureId)) return true
    return sources.get(structureId)?.has(good) ?? false
  }
}

function homeHead(headOf: Int32Array, id: number): number {
  if (id < 0 || id >= headOf.length) return id
  const head = headOf[id]
  return head >= 0 ? head : id
}

function byBasket(prices: Record<Good, number>) {
  return (a: Good, b: Good) => proteinBasket(a, prices) - proteinBasket(b, prices) || PROTEINS.indexOf(a) - PROTEINS.indexOf(b)
}

/** Market order. Producers later move the proteins they raise to the front. */
function marketProteinOrder(rank: SocialClass, prices: Record<Good, number>, rng: () => number): Good[] {
  const ranked = (["meat", "fish", "dairy"] as Good[]).sort(byBasket(prices))
  if (rank === "poor" || rank === "working") return ranked
  if (rank === "wealthy") {
    const roll = rng()
    const start = roll < 0.5 ? 0 : roll < 0.75 ? 1 : 2
    return [0, 1, 2].map((step) => PROTEINS[(start + step) % 3])
  }
  const cheapest = ranked[0]
  const second = ranked[1]
  const dearest = ranked[2]
  const roll = rng()
  let first = cheapest
  if (roll >= 0.9 && proteinBasket(dearest, prices) <= proteinBasket(cheapest, prices) * 10) first = dearest
  else if (roll >= 0.5 && proteinBasket(second, prices) <= proteinBasket(cheapest, prices) * 5) first = second
  return [first, ...ranked.filter((good) => good !== first)]
}

function proteinOrder(rank: SocialClass, produced: Set<Good> | undefined, prices: Record<Good, number>, rng: () => number): Good[] {
  const market = marketProteinOrder(rank, prices, rng)
  if (!produced || produced.size === 0) return market
  const made = [...produced].sort(byBasket(prices))
  if (rank === "wealthy") made.reverse()
  return [...made, ...market.filter((good) => !produced.has(good))]
}

function readProteinPick(town: TownTrade, year: number, month: number): Map<number, Good[]> {
  const orders = new Map<number, Good[]>()
  if (month === 0 || town.proteinYear !== year || !town.proteinPick) return orders
  for (const [key, order] of Object.entries(town.proteinPick)) {
    if (!order || order.length === 0) continue
    const goods = order.filter((good): good is Good => good === "meat" || good === "fish" || good === "dairy")
    if (goods.length > 0) orders.set(Number(key), goods)
  }
  return orders
}

/**
 * One protein order per household for the calendar year. January starts fresh.
 * A head who appears later in the year is chosen once and kept until January.
 */
function planProtein(
  people: People,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  prices: Record<Good, number>,
  lows: readonly number[],
  terrain: Uint8Array,
  feature: Uint8Array,
  seed: string,
  year: number,
  month: number,
  town: TownTrade,
  urbanTile = 0,
): { orders: Map<number, Good[]>; headOf: Int32Array; rank: Map<number, SocialClass>; sources: Map<number, Set<Good>>; farmsteads: Set<number> } {
  const homes = householdHomes(structures, [...owned.values()])
  const costs = livingCosts(prices, lows, urbanTile)
  const { rank, headOf } = householdRanks(people, costs.full, costs.member, homes)
  const { sources, farmsteads } = producedOn(structures, farms, terrain, feature)
  const produced = new Map<number, Set<Good>>()
  for (const structure of structures) {
    if (!farmsteads.has(structure.id)) continue
    const holding = owned.get(structure.id)
    if (!holding) continue
    const head = homeHead(headOf, holding.owner)
    const bag = produced.get(head) ?? new Set<Good>()
    for (const good of sources.get(structure.id) ?? []) bag.add(good)
    produced.set(head, bag)
  }
  const orders = readProteinPick(town, year, month)
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = homeHead(headOf, id)
    if (orders.has(head)) continue
    const rng = mulberry32(hashSeed(`${seed}:protein:${head}:${year}`))
    orders.set(head, proteinOrder(rank.get(head) ?? "poor", produced.get(head), prices, rng))
  }
  return { orders, headOf, rank, sources, farmsteads }
}

function storeProteinPick(orders: Map<number, Good[]>, people: People, headOf: Int32Array): Partial<Record<number, Good[]>> {
  const pick: Partial<Record<number, Good[]>> = {}
  for (let id = 0; id < people.alive.length; id++) {
    if (people.alive[id] === 0) continue
    const head = homeHead(headOf, id)
    const order = orders.get(head)
    if (order) pick[head] = order
  }
  return pick
}

function proteinForSale(
  farms: Farms,
  stock: Record<Good, number>,
  _stockOwner: Partial<Record<Good, number>>,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  buyer: number,
  deal: Deal,
): boolean {
  const spare = new Map<number, number>()
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer || !sellProtein(row.structureId, good)) continue
    const min = lotMin(deal, row.structureId)
    if (min === 0) continue
    if (!spare.has(row.owner)) spare.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - (targets.get(row.owner)?.[good] ?? 0)))
    const room = Math.min(row.store[good] ?? 0, spare.get(row.owner) ?? 0)
    if (room >= min) return true
  }
  if (deal !== "retail") {
    const seller = _stockOwner[good]
    if ((stock[good] ?? 0) >= WHOLESALE_MIN && seller !== undefined && seller !== buyer) return true
  }
  return false
}

/** Two years of fuel and clothing, plus 0.1 t of the tools and fiber each farm or workshop keeps. Food is eaten, not stored. */
function stockTargets(
  people: People,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  lows: readonly number[],
  _terrain: Uint8Array,
  _feature: Uint8Array,
  farms: Farms,
  prices: Record<Good, number>,
  protein?: { orders: Map<number, Good[]>; headOf: Int32Array; rank: Map<number, SocialClass> },
): Map<number, Record<Good, number>> {
  const woodYear = lows.reduce((sum, value) => sum + (value < 4 ? 4 : 2), 0)
  const houses = new Map<number, number>()
  const fuelHomes = new Map<number, number>()
  const shops = new Map<number, number>()
  const stocked = new Map<number, number>()
  const kept = new Map<number, { tools: number; leather: number; textiles: number; salt: number }>()
  const inputHold = new Map<number, Record<Good, number>>()
  const hold = (owner: number) => {
    const bag = kept.get(owner) ?? { tools: 0, leather: 0, textiles: 0, salt: 0 }
    kept.set(owner, bag)
    return bag
  }
  for (const structure of structures) {
    const row = owned.get(structure.id)
    if (!row || structure.pending || structure.removing) continue
    if (isHouse(structure)) houses.set(row.owner, (houses.get(row.owner) ?? 0) + 1)
    if (heatsHouse(structure, farms)) fuelHomes.set(row.owner, (fuelHomes.get(row.owner) ?? 0) + 1)
    if (structure.kind === "market" || structure.kind === "trading-post") {
      shops.set(row.owner, (shops.get(row.owner) ?? 0) + 1)
      stocked.set(row.owner, (stocked.get(row.owner) ?? 0) + 1)
    }
    if (structure.kind === "workshop") {
      const bag = hold(row.owner)
      bag.tools += 1
      const specialty = farms.rows.find((item) => item.structureId === structure.id)?.specialty
      if (specialty === "creamery") {
        bag.textiles += 1
        bag.salt += 1
      }
      shops.set(row.owner, (shops.get(row.owner) ?? 0) + 1)
      const extra = inputHold.get(row.owner) ?? emptyGoods()
      const store = farms.rows.find((item) => item.structureId === structure.id)?.store
      holdShopInputs(extra, farms.rows.find((item) => item.structureId === structure.id)?.specialty, store)
      inputHold.set(row.owner, extra)
    }
    if (structure.kind === "farmstead") {
      const bag = hold(row.owner)
      bag.tools += 1
      bag.leather += 1
      bag.textiles += 1
    }
  }
  const woodFirst = preferWood(prices)
  const targets = new Map<number, Record<Good, number>>()
  for (const owner of new Set([...houses.keys(), ...shops.keys(), ...kept.keys()])) {
    const tons = emptyGoods()
    const home = houses.get(owner) ?? 0
    if (home > 0) {
      const family = familyPortions(people, owner)
      const head = protein ? homeHead(protein.headOf, owner) : owner
      const clothing = CLOTH_CHANCE[protein?.rank.get(head) ?? "poor"]
      tons.clothing += family.adults * clothing * 0.1 + family.children * clothing * 0.05
      tons.leather += family.adults * clothing * 0.05
    }
    const fires = fuelHomes.get(owner) ?? 0
    if (woodFirst) tons.wood += fires * woodYear
    else tons.coal += fires * (woodYear / 4)
    const supplied = stocked.get(owner) ?? 0
    tons.leather += supplied * 0.05
    tons.textiles += supplied * 0.05
    tons["steel-tools"] += supplied * 0.025
    const hundredths = emptyGoods()
    for (const good of GOODS) hundredths[good] = Math.ceil(tons[good] * STOCK_YEARS * TON - 1e-6)
    const pile = kept.get(owner)
    if (pile) {
      hundredths["steel-tools"] += pile.tools * 10
      hundredths.leather += pile.leather * 10
      hundredths.textiles += pile.textiles * 10
      hundredths.salt += pile.salt * 10
    }
    const extra = inputHold.get(owner)
    if (extra) {
      for (const good of GOODS) {
        if (extra[good] <= 0) continue
        hundredths[good] += Math.min(extra[good], barnHeld(farms, owner, good))
      }
    }
    targets.set(owner, hundredths)
  }
  return targets
}

function marketStructures(structures: readonly Structure[], owned: Map<number, Holding>): number[] {
  return structures
    .filter((structure) => structure.kind === "market" && !structure.pending && !structure.removing && owned.has(structure.id))
    .map((structure) => structure.id)
    .sort((a, b) => a - b)
}

/** Ten percent over cost, and at least one dollar of profit on a full ton. */
function sellPrice(unit: number): number {
  const marked = Math.round(unit * (1 + MARKUP))
  const least = Math.ceil(unit + 1 - 1e-9)
  return Math.max(marked, least)
}

/** What a local buyer pays. The post's bid and ask are separate, and the town price can sit outside them. */
function offerPrice(good: Good, prices: Record<Good, number>, _fee: number): number {
  return clampPrice(prices[good] ?? PRICE_FLOOR)
}

/** Fruit pairs with vegetables. Meat, fish, and dairy each pair with the cheaper of the other two. */
function substituteQuote(good: Good, prices: Record<Good, number>, fee: number): number | null {
  if (good === "fruit") return offerPrice("vegetables", prices, fee)
  if (good === "vegetables") return offerPrice("fruit", prices, fee)
  if (good === "meat" || good === "fish" || good === "dairy") {
    const others = (["meat", "fish", "dairy"] as const).filter((item) => item !== good)
    return Math.min(offerPrice(others[0], prices, fee), offerPrice(others[1], prices, fee))
  }
  return null
}

function rememberCost(row: { cost?: Partial<Record<Good, number>>; store: Record<Good, number> }, good: Good, added: number, unit: number) {
  const next = { ...(row.cost ?? {}) }
  const held = row.store[good] ?? 0
  const previous = next[good] ?? unit
  next[good] = held + added <= 0 ? unit : (held * previous + added * unit) / (held + added)
  row.cost = next
}

/** Return an old export pile to the barn. A post ships from a producer, not from this pile. */
function foldBin(row: { store: Record<Good, number>; trade?: Partial<Record<Good, number>> }) {
  const bin = row.trade
  if (!bin) return
  for (const good of GOODS) {
    const sitting = bin[good] ?? 0
    if (sitting > 0) row.store[good] = (row.store[good] ?? 0) + sitting
  }
  row.trade = undefined
}

function spareAt(
  farms: Farms,
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  targets: Map<number, Record<Good, number>>,
  budget: Map<number, number>,
): number {
  if (!budget.has(row.owner)) budget.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - (targets.get(row.owner)?.[good] ?? 0)))
  return Math.max(0, Math.min(row.store[good] ?? 0, budget.get(row.owner) ?? 0))
}

/** Largest multiple of step that room can fill. */
function wholeLots(room: number, step: number): number {
  if (room < step || step <= 0) return 0
  return Math.floor(room / step) * step
}

/** Smallest multiple of step that covers the need. */
function coverLots(need: number, step: number): number {
  if (need <= 0 || step <= 0) return 0
  return Math.ceil(need / step) * step
}

/** A purchase in whole steps: tenths of a ton at a market, whole tons for a post, farm, or workshop. */
function buyLot(wealth: Int32Array, buyer: number, price: number, room: number, need: number, step: number): number {
  const qty = Math.min(wholeLots(room, step), coverLots(need, step))
  if (qty < step) return 0
  if (buyer < 0) return qty
  if (wealth.length <= buyer) return 0
  return wholeLots(affordable(wealth[buyer], price, qty), step)
}

function payFor(wealth: Int32Array, buyer: number, seller: number, price: number, qty: number): number {
  const cost = price <= 0 ? 0 : Math.round((price * qty) / TON)
  if (buyer < 0) stateSpent += cost
  else credit(wealth, buyer, -cost)
  credit(wealth, seller, cost)
  return cost
}

/** Ship one ton from a farm or workshop that has a ton to spare. The seller is paid the bid. The caller pays the post its fee. */
function shipExport(
  farms: Farms,
  targets: Map<number, Record<Good, number>>,
  wealth: Int32Array,
  good: Good,
  bid: number,
  rng: () => number,
): boolean {
  const budget = new Map<number, number>()
  const sellers = farms.rows
    .filter((row) => {
      if (!routes.farmIds.has(row.structureId) && !routes.workshopIds.has(row.structureId)) return false
      if (!sellProtein(row.structureId, good)) return false
      return spareAt(farms, row, good, targets, budget) >= TON
    })
    .sort((a, b) => a.structureId - b.structureId)
  if (sellers.length === 0) return false
  const row = sellers[Math.min(sellers.length - 1, Math.floor(rng() * sellers.length))]
  row.store[good] = (row.store[good] ?? 0) - TON
  credit(wealth, row.owner, bid)
  return true
}

function dealFor(structureId: number): Deal {
  const kind = routes.kindOf.get(structureId)
  if (kind === "farmstead" || kind === "shack") return "retail"
  if (kind === "market") return "market"
  return "workshop"
}

function buyerDeal(farms: Farms, owner: number): Deal {
  const own = farms.rows.filter((row) => row.owner === owner).sort((a, b) => a.structureId - b.structureId)
  const barn = own.find((row) => !routes.marketIds.includes(row.structureId)) ?? own[0]
  return barn ? dealFor(barn.structureId) : "retail"
}

/** 0 means this buyer does not deal with that barn. */
function lotMin(deal: Deal, structureId: number): number {
  if (routes.marketIds.includes(structureId)) return RETAIL_MIN
  if (routes.farmIds.has(structureId)) return deal === "retail" ? 0 : deal === "market" ? RETAIL_MIN : WHOLESALE_MIN
  if (routes.workshopIds.has(structureId)) return deal === "market" ? RETAIL_MIN : 0
  return 0
}

type ProducerOffer = { row: { owner: number; structureId: number; store: Record<Good, number> }; room: number }

function producerOffers(
  farms: Farms,
  buyer: number,
  good: Good,
  targets: Map<number, Record<Good, number>>,
  workshops: boolean,
): ProducerOffer[] {
  const budget = new Map<number, number>()
  const offers: ProducerOffer[] = []
  const rows = farms.rows
    .filter((row) => {
      if (row.owner < 0 || row.owner === buyer) return false
      if (routes.farmIds.has(row.structureId)) return true
      return workshops && routes.workshopIds.has(row.structureId)
    })
    .sort((a, b) => a.structureId - b.structureId)
  for (const row of rows) {
    if (!sellProtein(row.structureId, good)) continue
    const room = wholeLots(spareAt(farms, row, good, targets, budget), RETAIL_MIN)
    if (room < RETAIL_MIN) continue
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
    offers.push({ row, room })
  }
  if (good === "wood") {
    for (const row of farms.rows) {
      if (!idleWoodOffices.has(row.structureId)) continue
      const room = wholeLots(row.store.wood ?? 0, RETAIL_MIN)
      if (room < RETAIL_MIN) continue
      offers.push({ row, room })
    }
  }
  offers.sort((a, b) => b.room - a.room || a.row.structureId - b.row.structureId)
  return offers
}

function takeProducers(
  shop: { owner: number; store: Record<Good, number>; cost?: Partial<Record<Good, number>> },
  wealth: Int32Array,
  good: Good,
  offers: ProducerOffer[],
  amount: number,
  unit: number,
) {
  let left = amount
  for (const offer of offers) {
    if (left <= 0) break
    const bought = buyLot(wealth, shop.owner, unit, offer.room, left, RETAIL_MIN)
    if (bought < RETAIL_MIN) continue
    payFor(wealth, shop.owner, offer.row.owner, unit, bought)
    offer.row.store[good] = (offer.row.store[good] ?? 0) - bought
    offer.room -= bought
    rememberCost(shop, good, bought, unit)
    shop.store[good] = (shop.store[good] ?? 0) + bought
    left -= bought
  }
}

function poolOffer(
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  prices: Record<Good, number>,
  good: Good,
  buyer: number,
): { owner: number; room: number; price: number } | null {
  const owner = stockOwner[good]
  const room = stock[good] ?? 0
  if (owner === undefined || owner === buyer || room < WHOLESALE_MIN) return null
  return { owner, room, price: stockAsk[good] ?? prices[good] ?? PRICE_FLOOR }
}

function takePool(
  stock: Record<Good, number>,
  shop: { owner: number; store: Record<Good, number>; cost?: Partial<Record<Good, number>> },
  wealth: Int32Array,
  good: Good,
  pool: { owner: number; room: number; price: number },
  qty: number,
) {
  const bought = buyLot(wealth, shop.owner, pool.price, pool.room, qty, WHOLESALE_MIN)
  if (bought < WHOLESALE_MIN) return
  payFor(wealth, shop.owner, pool.owner, pool.price, bought)
  rememberCost(shop, good, bought, pool.price)
  shop.store[good] = (shop.store[good] ?? 0) + bought
  stock[good] -= bought
  pool.room -= bought
}

/** A market can buy this much seasonal food from a farm or the import pile without filling its shelf. */
function seasonalForSale(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  buyer: number,
  hundredths: number,
  fee: number,
): boolean {
  if (SHELF_MONTH[good] === undefined) return false
  const need = coverLots(hundredths, RETAIL_MIN)
  if (need < RETAIL_MIN) return false
  const unit = offerPrice(good, prices, fee)
  for (const id of routes.marketIds) {
    const shop = farms.rows.find((row) => row.structureId === id)
    if (!shop || shop.owner === buyer || wealth.length <= shop.owner) continue
    const locals = producerOffers(farms, shop.owner, good, targets, true)
    const localSum = locals.reduce((sum, offer) => sum + offer.room, 0)
    const affordable = (qty: number, price: number) => Math.round((price * qty) / TON) <= (wealth[shop.owner] ?? 0)
    if (localSum >= need && affordable(need, unit)) return true
    const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, shop.owner)
    const poolTake = coverLots(Math.max(need - localSum, 0), WHOLESALE_MIN)
    if (pool && poolTake > 0 && wholeLots(pool.room, WHOLESALE_MIN) >= poolTake) {
      const cost = Math.round((unit * localSum) / TON) + Math.round((pool.price * poolTake) / TON)
      if (cost <= (wealth[shop.owner] ?? 0)) return true
    }
  }
  return false
}

/** Buy just enough of a seasonal food to cover one bid, then let the buyer take it off the shelf. */
function sourceBid(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  buyer: number,
  good: Good,
  hundredths: number,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  fee: number,
): boolean {
  const need = coverLots(hundredths, RETAIL_MIN)
  if (need < RETAIL_MIN) return false
  const unit = offerPrice(good, prices, fee)
  for (const id of routes.marketIds) {
    const shop = farms.rows.find((row) => row.structureId === id)
    if (!shop || shop.owner === buyer || wealth.length <= shop.owner) continue
    const before = shop.store[good] ?? 0
    const locals = producerOffers(farms, shop.owner, good, targets, true)
    const localSum = locals.reduce((sum, offer) => sum + offer.room, 0)
    const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, shop.owner)
    const poolLots = pool ? wholeLots(pool.room, WHOLESALE_MIN) : 0
    if (localSum >= need) takeProducers(shop, wealth, good, locals, need, unit)
    else {
      const poolTake = coverLots(need - localSum, WHOLESALE_MIN)
      if (localSum > 0 && pool && poolLots >= poolTake) {
        takeProducers(shop, wealth, good, locals, localSum, unit)
        takePool(stock, shop, wealth, good, pool, poolTake)
      } else if (pool && poolLots >= coverLots(need, WHOLESALE_MIN)) takePool(stock, shop, wealth, good, pool, coverLots(need, WHOLESALE_MIN))
      else if (localSum > 0) takeProducers(shop, wealth, good, locals, localSum, unit)
    }
    if ((shop.store[good] ?? 0) > before) return true
  }
  return false
}

/** Top a market up to its shelf target once the good is under half. Seasonal food waits for the month after harvest. */
function fillShelves(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  posts: Holding[],
  month: number,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (const id of routes.marketIds) {
    const shop = farms.rows.find((row) => row.structureId === id)
    if (!shop || wealth.length <= shop.owner) continue
    for (const good of GOODS) {
      const target = SHELF_TARGET[good]
      if (!target) continue
      const season = SHELF_MONTH[good]
      if (season !== undefined && season !== month) continue
      const gap = shelfGap(farms, shop, good, targets, target)
      if (gap <= 0) continue
      const need = coverLots(gap, RETAIL_MIN)
      const unit = offerPrice(good, prices, fee)
      const other = substituteQuote(good, prices, fee)
      if (other !== null && unit > other * 100) continue
      const locals = producerOffers(farms, shop.owner, good, targets, true)
      const localSum = locals.reduce((sum, offer) => sum + offer.room, 0)
      const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, shop.owner)
      const poolLots = pool ? wholeLots(pool.room, WHOLESALE_MIN) : 0
      if (localSum >= need) {
        takeProducers(shop, wealth, good, locals, need, unit)
        continue
      }
      const poolCover = coverLots(need, WHOLESALE_MIN)
      const poolOnly = poolLots >= poolCover ? poolCover : 0
      const postTake = coverLots(need - localSum, WHOLESALE_MIN)
      const withLocal = localSum > 0 && postTake > 0 && poolLots >= postTake ? localSum + postTake : 0
      if (poolOnly > 0 && pool && (withLocal === 0 || poolOnly <= withLocal)) {
        takePool(stock, shop, wealth, good, pool, poolOnly)
        continue
      }
      if (withLocal > 0 && pool) {
        takeProducers(shop, wealth, good, locals, localSum, unit)
        takePool(stock, shop, wealth, good, pool, postTake)
        continue
      }
      if (localSum > 0) takeProducers(shop, wealth, good, locals, localSum, unit)
    }
  }
}

function buyGoods(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  buyer: number,
  good: Good,
  hundredths: number,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  _marketIds: number[],
  fee: number,
  deal: Deal,
): { taken: number; spent: number } {
  let left = hundredths
  let spent = 0
  if (left <= 0 || wealth.length <= buyer) return { taken: 0, spent: 0 }
  const unit = offerPrice(good, prices, fee)
  const producerMin = deal === "market" ? RETAIL_MIN : WHOLESALE_MIN

  const shops = farms.rows.filter((row) => routes.marketIds.includes(row.structureId) && row.owner !== buyer).sort((a, b) => a.structureId - b.structureId)
  let taken = 0
  const fromMarkets = () => {
    for (const shop of shops) {
      if (left <= 0) break
      const room = sellable(farms, shop, good, targets)
      const price = sellPrice(shop.cost?.[good] ?? unit)
      const qty = buyLot(wealth, buyer, price, room, left, RETAIL_MIN)
      if (qty < RETAIL_MIN) continue
      spent += payFor(wealth, buyer, shop.owner, price, qty)
      shop.store[good] = (shop.store[good] ?? 0) - qty
      left -= qty
      taken += qty
    }
  }
  fromMarkets()
  if (left > 0 && SHELF_MONTH[good] !== undefined && sourceBid(farms, stock, stockOwner, stockAsk, wealth, buyer, good, left, prices, targets, fee)) fromMarkets()

  if ((deal === "workshop" || deal === "market") && left > 0) {
    const budget = new Map<number, number>()
    const sellers = farms.rows
      .filter((row) => {
        if (row.owner < 0 || row.owner === buyer) return false
        if (routes.farmIds.has(row.structureId)) return true
        return deal === "market" && routes.workshopIds.has(row.structureId)
      })
      .sort((a, b) => (b.store[good] ?? 0) - (a.store[good] ?? 0) || a.structureId - b.structureId)
    for (const row of sellers) {
      if (left <= 0) break
      if (!sellProtein(row.structureId, good)) continue
      const room = spareAt(farms, row, good, targets, budget)
      const qty = buyLot(wealth, buyer, unit, room, left, producerMin)
      if (qty < producerMin) continue
      spent += payFor(wealth, buyer, row.owner, unit, qty)
      row.store[good] = (row.store[good] ?? 0) - qty
      budget.set(row.owner, (budget.get(row.owner) ?? 0) - qty)
      left -= qty
      taken += qty
    }
  }

  if ((deal === "workshop" || deal === "market") && left > 0) {
    const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
    if (pool) {
      const qty = buyLot(wealth, buyer, pool.price, pool.room, left, WHOLESALE_MIN)
      if (qty >= WHOLESALE_MIN) {
        spent += payFor(wealth, buyer, pool.owner, pool.price, qty)
        stock[good] -= qty
        taken += qty
      }
    }
  }
  return { taken, spent }
}

function restock(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  proteinOrders: Map<number, Good[]> = new Map(),
  headOf?: Int32Array,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  const deliver = (owner: number, good: Good, hundredths: number): number => {
    const barn = farms.rows.filter((row) => row.owner === owner && !marketIds.includes(row.structureId)).sort((a, b) => a.structureId - b.structureId)[0]
      ?? farms.rows.filter((row) => row.owner === owner).sort((a, b) => a.structureId - b.structureId)[0]
    if (!barn || wealth.length <= owner || hundredths <= 0) return 0
    if (marketIds.includes(barn.structureId) && !SHELF_TARGET[good]) return 0
    const deal = dealFor(barn.structureId)
    const want = hundredths > 0 && hundredths < RETAIL_MIN ? RETAIL_MIN : hundredths
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, owner, good, want, prices, targets, marketIds, fee, deal)
    if (bought.taken <= 0) return 0
    if (marketIds.includes(barn.structureId)) rememberCost(barn, good, bought.taken, (bought.spent * TON) / bought.taken)
    barn.store[good] = (barn.store[good] ?? 0) + bought.taken
    return bought.taken
  }
  for (const good of GOODS) {
    const seekers = [...targets.entries()]
      .map(([owner, need]) => ({ owner, reserve: need[good] ?? 0, held: barnHeld(farms, owner, good) }))
      .filter((seeker) => seeker.reserve > 0 && seeker.held < seeker.reserve)
      .sort((a, b) => a.held / a.reserve - b.held / b.reserve || a.owner - b.owner)
    for (const seeker of seekers) deliver(seeker.owner, good, seeker.reserve - seeker.held)
  }
  if (!headOf) return
  const fallbacks = [...proteinOrders.entries()]
    .map(([head, order]) => {
      const first = order[0]
      const homes = [...targets.keys()].filter((owner) => homeHead(headOf, owner) === head && (targets.get(owner)?.[first] ?? 0) > 0)
      return { head, order, homes }
    })
    .filter((item) => item.homes.length > 0 && item.order.length > 1)
  for (const item of fallbacks) {
    for (const owner of item.homes) {
      const first = item.order[0]
      const reserve = targets.get(owner)?.[first] ?? 0
      const held = barnHeld(farms, owner, first)
      if (reserve <= 0 || held >= reserve) continue
      if (proteinForSale(farms, stock, stockOwner, targets, first, owner, buyerDeal(farms, owner))) continue
      const short = reserve - held
      for (const good of item.order.slice(1)) {
        if (!proteinForSale(farms, stock, stockOwner, targets, good, owner, buyerDeal(farms, owner))) continue
        const cap = Math.ceil((reserve * proteinTons(good)) / proteinTons(first) - 1e-6)
        const want = Math.ceil((short * proteinTons(good)) / proteinTons(first) - 1e-6)
        const gap = Math.min(want, Math.max(0, cap - barnHeld(farms, owner, good)))
        if (gap <= 0) continue
        deliver(owner, good, gap)
        break
      }
    }
  }
}

function affordable(purse: number, pricePerTon: number, want: number): number {
  if (want <= 0 || purse < 0) return 0
  if (pricePerTon <= 0) return want
  let count = Math.min(want, Math.floor((purse * TON) / pricePerTon))
  while (count < want && Math.round((pricePerTon * (count + 1)) / TON) <= purse) count += 1
  while (count > 0 && Math.round((pricePerTon * count) / TON) > purse) count -= 1
  return count
}

function monthlyUse(
  structures: readonly Structure[],
  people: People | null,
  low: number,
  ownedIds: Set<number>,
  terrain: Uint8Array = new Uint8Array(),
  feature: Uint8Array = new Uint8Array(),
  context?: UseContext,
): Record<Good, number> {
  const use = emptyGoods()
  let fuel = 0
  let posts = 0
  let farmSteel = 0
  let farmLeather = 0
  let farmTextiles = 0
  for (const structure of structures) {
    if (!ownedIds.has(structure.id)) continue
    if (context ? heatsHouse(structure, context.farms) : isHouse(structure) && structure.kind !== "workshop") fuel += 1
    if (structure.kind === "trading-post") posts += 1
    const scale = dryFarmScale(structure, terrain, feature)
    farmSteel += FARM_STEEL_PER_THOUSAND * scale
    farmLeather += FARM_LEATHER_PER_THOUSAND * scale
    farmTextiles += FARM_TEXTILE_PER_THOUSAND * scale
  }
  const woodMonth = low < 4 ? 4 : 2
  if (!context || preferWood(context.prices)) use.wood += fuel * woodMonth
  else use.coal += fuel * (woodMonth / 4)
  use.grain += posts / 12
  use.leather += (posts * 0.05) / 12 + farmLeather / 12
  use.textiles += (posts * 0.05) / 12 + farmTextiles / 12
  use["steel-tools"] += (posts * 0.025) / 12 + farmSteel / 12
  if (context) addShopUse(use, structures, ownedIds, context)
  if (!people) return use
  let scale = 0
  let clothYear = 0
  let leatherYear = 0
  const orders = context?.proteinOrders
  const headOf = context?.headOf
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const portion = people.age[id] <= 5 ? 0.5 : people.age[id] <= 12 ? 0.75 : 1
    scale += portion
    const clothing = CLOTH_CHANCE[context?.rank?.get(headOf ? homeHead(headOf, id) : id) ?? "poor"]
    if (people.age[id] >= 13) {
      clothYear += clothing * 0.1
      leatherYear += clothing * 0.05
    } else clothYear += clothing * 0.05
    if (!orders || !headOf) continue
    const pick = orders.get(homeHead(headOf, id))?.[0]
    if (pick) use[pick] += (portion * proteinTons(pick)) / 12
  }
  use.grain += (scale * 0.1) / 12
  use.fruit += (scale * 0.15) / 12
  use.vegetables += (scale * 0.15) / 12
  if (!orders || !headOf) {
    use.fish += (scale * 0.1) / 36
    use.meat += (scale * 0.1) / 36
    use.dairy += (scale * 0.4) / 36
  }
  use.clothing += clothYear / 12
  use.leather += leatherYear / 12
  return use
}

function totalStock(farms: Farms, town: TownTrade): Record<Good, number> {
  const stock = { ...town.stock }
  for (const row of farms.rows) {
    for (const good of GOODS) {
      stock[good] += row.store[good] ?? 0
      stock[good] += row.trade?.[good] ?? 0
    }
  }
  return stock
}

function isHouse(structure: Structure): boolean {
  return !structure.pending && !structure.removing && (structure.kind === "farmstead" || structure.kind === "shack" || structure.kind === "market" || structure.kind === "trading-post" || structure.kind === "workshop")
}

/** Sawmills and blacksmiths heat with their own waste. Every other house burns fuel. */
function heatsHouse(structure: Structure, farms: Farms): boolean {
  if (!isHouse(structure)) return false
  if (structure.kind !== "workshop") return true
  const specialty = farms.rows.find((row) => row.structureId === structure.id)?.specialty
  return specialty === "smokehouse"
}

/** Wood is kept when it costs a quarter of coal or less. Otherwise one ton of coal replaces four of wood. */
function preferWood(prices: Record<Good, number>): boolean {
  return (prices.wood ?? PRICE_FLOOR) * 4 <= (prices.coal ?? PRICE_FLOOR)
}

function purseOf(people: People, id: number): number {
  const mate = people.spouse[id]
  const mateAlive = mate >= 0 && mate < people.alive.length && people.alive[mate] !== 0
  if (people.sex[id] === Sex.Female && mateAlive) return mate
  if ((people.spouse[id] ?? -1) < 0) {
    const dad = people.father[id]
    if (dad >= 0 && dad < people.alive.length && people.alive[dad] !== 0) return dad
    const mom = people.mother[id]
    if (mom >= 0 && mom < people.alive.length && people.alive[mom] !== 0) return mom
  }
  return id
}

type RecipeInput = { good: Good; hundredths: number }
type Batch = { output: Good; out: number; inputs: RecipeInput[]; cap: number }

/** Caps are five years of that workshop's own output, in hundredths of a ton. */
const SAWMILL_BATCH: Batch = { output: "lumber", out: 6 * TON, inputs: [{ good: "wood", hundredths: 9 * TON }], cap: 360 * TON }
const PARTS_BATCH: Batch = {
  output: "steel-parts",
  out: TON,
  inputs: [
    { good: "coal", hundredths: 2 * TON },
    { good: "steel", hundredths: TON },
  ],
  cap: 15 * TON,
}
const TOOLS_BATCH: Batch = {
  output: "steel-tools",
  out: 2 * TON,
  inputs: [
    { good: "steel-parts", hundredths: TON / 2 },
    { good: "lumber", hundredths: TON / 2 },
  ],
  cap: 30 * TON,
}
const FISH_BATCH: Batch = {
  output: "cured-fish",
  out: TON,
  inputs: [
    { good: "fish", hundredths: 2 * TON },
    { good: "wood", hundredths: 2 * TON },
    { good: "salt", hundredths: 10 },
  ],
  cap: 60 * TON,
}
const MEAT_BATCH: Batch = {
  output: "cured-meat",
  out: TON,
  inputs: [
    { good: "meat", hundredths: 2 * TON },
    { good: "wood", hundredths: 2 * TON },
    { good: "salt", hundredths: 10 },
  ],
  cap: 60 * TON,
}
/** March, April, May, September, October, and November. Five years of that output. */
const CHEESE_CAP = 30 * TON
const CHEESE_WOOD: Batch = {
  output: "cheese",
  out: TON,
  inputs: [
    { good: "dairy", hundredths: 8 * TON },
    { good: "wood", hundredths: TON },
    { good: "salt", hundredths: 2 },
  ],
  cap: CHEESE_CAP,
}
const CHEESE_COAL: Batch = {
  output: "cheese",
  out: TON,
  inputs: [
    { good: "dairy", hundredths: 8 * TON },
    { good: "coal", hundredths: TON / 4 },
    { good: "salt", hundredths: 2 },
  ],
  cap: CHEESE_CAP,
}
const BARREL_BATCH: Batch = {
  output: "barrels",
  out: TON,
  inputs: [
    { good: "wood", hundredths: 2 * TON },
    { good: "steel-parts", hundredths: TON / 5 },
  ],
  cap: 60 * TON,
}
const CHEESE_MONTHS = new Set([2, 3, 4, 8, 9, 10])

function holdShopInputs(extra: Record<Good, number>, specialty: ShopSpecialty | undefined, store: Record<Good, number> | undefined) {
  const held = (good: Good) => store?.[good] ?? 0
  const open = (batch: Batch) => held(batch.output) + batch.out <= batch.cap
  if (specialty === "sawmill" && open(SAWMILL_BATCH)) addInputs(extra, SAWMILL_BATCH)
  if (specialty === "blacksmith") {
    if (open(PARTS_BATCH)) addInputs(extra, PARTS_BATCH)
    if (open(TOOLS_BATCH)) addInputs(extra, TOOLS_BATCH)
  }
  if (specialty === "smokehouse") {
    const fishOpen = open(FISH_BATCH)
    const meatOpen = open(MEAT_BATCH)
    if (fishOpen) extra.fish += 2 * TON
    if (meatOpen) extra.meat += 2 * TON
    if (fishOpen || meatOpen) {
      extra.wood += 2 * TON
      extra.salt += 10
    }
  }
  if (specialty === "creamery" && open(CHEESE_WOOD)) addInputs(extra, CHEESE_WOOD)
  if (specialty === "cooper" && open(BARREL_BATCH)) addInputs(extra, BARREL_BATCH)
}

function addInputs(extra: Record<Good, number>, batch: Batch) {
  for (const input of batch.inputs) extra[input.good] += input.hundredths
}

const SHOP_BATCHES: Record<ShopSpecialty, Batch[]> = {
  sawmill: [SAWMILL_BATCH],
  blacksmith: [PARTS_BATCH, TOOLS_BATCH],
  smokehouse: [FISH_BATCH, MEAT_BATCH],
  creamery: [CHEESE_WOOD, CHEESE_COAL],
  cooper: [BARREL_BATCH],
}

/** Dollars of expected margin for one batch. Null when an input cannot be had. */
function batchQuote(batch: Batch, marks: Record<Good, number>, stock: Record<Good, number>, fee: number): number | null {
  for (const input of batch.inputs) {
    if ((stock[input.good] ?? 0) >= input.hundredths) continue
    if (fee <= 0 || tradeEnds(input.good, fee).ask === null) return null
  }
  let cost = 0
  for (const input of batch.inputs) cost += Math.round(((marks[input.good] ?? PRICE_FLOOR) * input.hundredths) / TON)
  const revenue = Math.round(((marks[batch.output] ?? PRICE_FLOOR) * batch.out) / TON)
  return revenue - cost
}

/** Best batch of each specialty that still earns money, highest monthly margin first. A blacksmith runs three months a year, a creamery six. */
function rankedSpecialties(marks: Record<Good, number>, stock: Record<Good, number>, fee: number): ShopSpecialty[] {
  const order: ShopSpecialty[] = ["sawmill", "blacksmith", "smokehouse", "creamery", "cooper"]
  const scored: { specialty: ShopSpecialty; margin: number }[] = []
  for (const specialty of order) {
    let top: number | null = null
    for (const batch of SHOP_BATCHES[specialty]) {
      const margin = batchQuote(batch, marks, stock, fee)
      if (margin === null || margin <= 0) continue
      if (top === null || margin > top) top = margin
    }
    if (top === null) continue
    const months = specialty === "blacksmith" ? 3 / 12 : specialty === "creamery" ? 6 / 12 : 1
    scored.push({ specialty, margin: top * months })
  }
  scored.sort((a, b) => b.margin - a.margin || order.indexOf(a.specialty) - order.indexOf(b.specialty))
  return scored.map((item) => item.specialty)
}

/**
 * Profitable specialties this month, best monthly margin first. Empty when every
 * batch loses money. An occupied workshop keeps the specialty it already has.
 */
export function workshopOpening(
  town: TownTrade,
  farms: Farms,
  structures: readonly Structure[],
  holdings: Holdings,
  people: People | null,
  low: number,
  terrain: Uint8Array,
  feature: Uint8Array,
  lows: readonly number[],
  seed: string,
  year: number,
  urbanTile = 0,
): ShopSpecialty[] {
  if (!people) return []
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const ownedIds = new Set(owned.keys())
  const yearLows = lows.length > 0 ? lows : [low]
  const plan = planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town, urbanTile)
  const fee = cheapFee(holdings, structures) ?? 0
  bindRoutes(structures, ownedIds)
  const posts = structures.filter((structure) => structure.kind === "trading-post" && !structure.pending && !structure.removing && owned.has(structure.id)).length
  const targets = stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices, plan)
  const pool = totalStock(farms, town)
  const measure = (marks?: Record<Good, number>) =>
    monthlyUse(structures, people, low, ownedIds, terrain, feature, {
      farms,
      prices: town.prices,
      fee,
      stock: town.stock,
      stockOwner: town.stockOwner,
      stockAsk: town.stockAsk ?? {},
      targets,
      wealth: people.wealth,
      proteinOrders: plan.orders,
      headOf: plan.headOf,
      rank: plan.rank,
      marks,
    })
  const marks = quotedPrices(pool, town.prices, fee, posts, measure)
  return rankedSpecialties(marks, pool, fee)
}

function optionsFor(specialty: ShopSpecialty, month: number, producing: boolean): Batch[] {
  if (specialty === "sawmill") return [SAWMILL_BATCH]
  if (specialty === "blacksmith") {
    if (producing && month !== 0 && month !== 4 && month !== 8) return []
    return [PARTS_BATCH, TOOLS_BATCH]
  }
  if (specialty === "creamery") {
    if (producing && !CHEESE_MONTHS.has(month)) return []
    return [CHEESE_WOOD, CHEESE_COAL]
  }
  if (specialty === "cooper") return [BARREL_BATCH]
  return [FISH_BATCH, MEAT_BATCH]
}

function shopOutputs(specialty: ShopSpecialty): Good[] {
  if (specialty === "sawmill") return ["lumber"]
  if (specialty === "blacksmith") return ["steel-parts", "steel-tools"]
  if (specialty === "creamery") return ["cheese"]
  if (specialty === "cooper") return ["barrels"]
  return ["cured-fish", "cured-meat"]
}

/** January. A wooded farm turns 50 tons of spare wood into 10 tons of coal, once. */
function makeCoal(
  farms: Farms,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  targets: Map<number, Record<Good, number>>,
  feature: Uint8Array,
  month: number,
) {
  if (month !== 0) return
  const woodIn = 50 * TON
  for (const structure of [...structures].sort((a, b) => a.id - b.id)) {
    if (structure.kind !== "farmstead" || structure.pending || structure.removing || structure.tiles.length === 0) continue
    const holding = owned.get(structure.id)
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!holding || !row) continue
    let woods = 0
    for (const tile of structure.tiles) {
      const kind = feature[tile]
      if (kind === Feature.Forest || kind === Feature.Woodland) woods += 1
    }
    if (woods / structure.tiles.length < 0.25) continue
    if ((row.store.wood ?? 0) < woodIn) continue
    if (barnHeld(farms, row.owner, "wood") - woodIn < (targets.get(row.owner)?.wood ?? 0)) continue
    row.store.wood -= woodIn
    row.store.coal += 10 * TON
  }
}

/** January. Each workshop rolls a tenth of a ton of tools, at 5%. */
function feedShops(
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  year: number,
  seed: string,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (const structure of structures) {
    if (structure.kind !== "workshop" || structure.pending || structure.removing) continue
    const row = owned.get(structure.id)
    if (!row) continue
    const rng = mulberry32(hashSeed(`${seed}:shop-supply:${structure.id}:${year}`))
    if (rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee, "retail")
    const specialty = farms.rows.find((item) => item.structureId === structure.id)?.specialty
    if (specialty === "creamery" && rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "textiles", 10, prices, targets, marketIds, fee, "retail")
    if (specialty === "cooper") buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "fiber", 20, prices, targets, marketIds, fee, "workshop")
  }
}

function runShops(
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  posts: Holding[],
  month: number,
  marks?: Record<Good, number>,
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  const shops = structures.filter((structure) => structure.kind === "workshop" && !structure.pending && !structure.removing).sort((a, b) => a.id - b.id)
  for (const structure of shops) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row?.specialty || !owned.has(structure.id)) continue
    const batch = chooseBatch(optionsFor(row.specialty, month, true), row, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, false, marks)
    if (batch && applyInputs(batch.inputs, row.owner, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee)) {
      row.store[batch.output] = (row.store[batch.output] ?? 0) + batch.out
    }
    for (const good of shopOutputs(row.specialty)) sellLocal(row, good, farms, wealth, prices, marketIds, fee, targets)
  }
}

function chooseBatch(
  options: Batch[],
  row: { owner: number; store: Record<Good, number> },
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  fee: number,
  allowImport = false,
  marks?: Record<Good, number>,
): Batch | null {
  let best: { batch: Batch; margin: number } | null = null
  const unit = (good: Good) => marks?.[good] ?? offerPrice(good, prices, fee)
  for (const batch of options) {
    if ((row.store[batch.output] ?? 0) + batch.out > batch.cap) continue
    const priced = priceInputs(batch.inputs, row.owner, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, allowImport)
    if (!priced) continue
    const revenue = Math.round((unit(batch.output) * batch.out) / TON)
    const cost = marks
      ? batch.inputs.reduce((sum, input) => sum + Math.round((unit(input.good) * input.hundredths) / TON), 0)
      : priced.economic
    if (cost > revenue) continue
    const margin = revenue - cost
    if (!best || margin > best.margin) best = { batch, margin }
  }
  return best?.batch ?? null
}

function addShopUse(use: Record<Good, number>, structures: readonly Structure[], ownedIds: Set<number>, context: UseContext) {
  const marketIds = structures.filter((structure) => structure.kind === "market" && ownedIds.has(structure.id)).map((structure) => structure.id).sort((a, b) => a - b)
  for (const structure of structures) {
    if (structure.kind !== "workshop" || !ownedIds.has(structure.id)) continue
    const row = context.farms.rows.find((item) => item.structureId === structure.id)
    if (!row?.specialty) continue
    use["steel-tools"] += 0.005 / 12
    if (row.specialty === "creamery") use.textiles += 0.005 / 12
    if (row.specialty === "cooper") use.fiber += 0.2 / 12
    const batch = chooseBatch(
      optionsFor(row.specialty, 0, false),
      row,
      context.farms,
      context.stock,
      context.stockOwner,
      context.stockAsk,
      context.wealth,
      context.prices,
      context.targets,
      marketIds,
      context.fee,
      true,
      context.marks,
    )
    if (!batch) continue
    const scale = row.specialty === "blacksmith" ? 3 / 12 : row.specialty === "creamery" ? 6 / 12 : 1
    for (const input of batch.inputs) use[input.good] += (input.hundredths / TON) * scale
  }
}

type SupplyLot = { price: number; hundredths: number; structureId: number | null; owner: number; min: number }

function ownedHeld(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  owner: number,
  good: Good,
): number {
  let held = barnHeld(farms, owner, good)
  if (stockOwner[good] === owner) held += stock[good] ?? 0
  return held
}

function purchaseLots(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  buyer: number,
  good: Good,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  _marketIds: number[],
  fee: number,
): SupplyLot[] {
  const unit = offerPrice(good, prices, fee)
  const budget = new Map<number, number>()
  const lots: SupplyLot[] = []
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer || !sellProtein(row.structureId, good)) continue
    const market = routes.marketIds.includes(row.structureId)
    const farm = routes.farmIds.has(row.structureId)
    if (!market && !farm) continue
    const raw = spareAt(farms, row, good, targets, budget)
    const min = market ? RETAIL_MIN : WHOLESALE_MIN
    const room = wholeLots(raw, min)
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
    if (room < min) continue
    lots.push({
      price: market ? sellPrice(row.cost?.[good] ?? unit) : unit,
      hundredths: room,
      structureId: row.structureId,
      owner: row.owner,
      min,
    })
  }
  if (good === "wood") {
    for (const row of farms.rows) {
      if (!idleWoodOffices.has(row.structureId)) continue
      const room = wholeLots(row.store.wood ?? 0, RETAIL_MIN)
      if (room < RETAIL_MIN) continue
      lots.push({ price: unit, hundredths: room, structureId: row.structureId, owner: row.owner, min: RETAIL_MIN })
    }
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
  if (pool) lots.push({ price: pool.price, hundredths: wholeLots(pool.room, WHOLESALE_MIN), structureId: null, owner: pool.owner, min: WHOLESALE_MIN })
  lots.sort((a, b) => a.price - b.price || (a.structureId ?? 1e9) - (b.structureId ?? 1e9))
  return lots
}

function priceInputs(
  inputs: RecipeInput[],
  buyer: number,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  fee: number,
  allowImport = false,
): { economic: number } | null {
  if (!allowImport && wealth.length <= buyer) return null
  let economic = 0
  let cash = 0
  for (const input of inputs) {
    let left = input.hundredths
    const own = Math.min(ownedHeld(farms, stock, stockOwner, buyer, input.good), left)
    if (own > 0) {
      economic += Math.round((offerPrice(input.good, prices, fee) * own) / TON)
      left -= own
    }
    if (left > 0) {
      for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee)) {
        const take = wholeLots(Math.min(lot.hundredths, left), lot.min)
        if (take < lot.min) continue
        const dollars = Math.round((lot.price * take) / TON)
        economic += dollars
        cash += dollars
        left -= take
      }
    }
    if (left > 0 && allowImport) {
      const foreign = WEST_EUROPE[input.good]
      if (foreign && foreign.import !== false) {
        economic += Math.round(((foreign.price + Math.max(fee, 0)) * left) / TON)
        left = 0
      }
    }
    if (left > 0) return null
  }
  if (!allowImport && cash > (wealth[buyer] ?? 0)) return null
  return { economic }
}

function applyInputs(
  inputs: RecipeInput[],
  buyer: number,
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  fee: number,
): boolean {
  const saved = {
    stores: farms.rows.map((row) => GOODS.map((good) => row.store[good] ?? 0)),
    stock: GOODS.map((good) => stock[good] ?? 0),
    wealth: new Int32Array(wealth),
    income: books ? new Int32Array(books.income) : null,
    log: books ? new Int32Array(books.log) : null,
    till: stateTill,
  }
  const undo = () => {
    farms.rows.forEach((row, index) => {
      GOODS.forEach((good, g) => {
        row.store[good] = saved.stores[index][g]
      })
    })
    GOODS.forEach((good, g) => {
      stock[good] = saved.stock[g]
    })
    wealth.set(saved.wealth)
    stateTill = saved.till
    if (books && saved.income && saved.log) {
      books.income.set(saved.income)
      books.log.set(saved.log)
    }
  }
  for (const input of inputs) {
    let left = input.hundredths - takeOwned(farms, stock, stockOwner, buyer, input.good, input.hundredths)
    for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee)) {
      if (left < lot.min || wealth.length <= buyer) continue
      const take = wholeLots(Math.min(lot.hundredths, left, affordable(wealth[buyer], lot.price, lot.hundredths)), lot.min)
      if (take < lot.min) continue
      const dollars = Math.round((lot.price * take) / TON)
      credit(wealth, buyer, -dollars)
      credit(wealth, lot.owner, dollars)
      if (lot.structureId === null) stock[input.good] -= take
      else {
        const source = farms.rows.find((item) => item.structureId === lot.structureId)
        if (source) source.store[input.good] = (source.store[input.good] ?? 0) - take
      }
      left -= take
    }
    if (left > 0) {
      undo()
      return false
    }
  }
  return true
}

/** A workshop sells surplus output, a ton or more, to a market at the town price. A market buys only goods on its shelf. */
function sellLocal(
  row: { owner: number; structureId: number; store: Record<Good, number> },
  good: Good,
  farms: Farms,
  wealth: Int32Array,
  prices: Record<Good, number>,
  marketIds: number[],
  fee: number,
  targets: Map<number, Record<Good, number>>,
) {
  if (!SHELF_TARGET[good]) return
  const budget = new Map<number, number>()
  let left = wholeLots(spareAt(farms, row, good, targets, budget), WHOLESALE_MIN)
  if (left < WHOLESALE_MIN) return
  const domestic = offerPrice(good, prices, fee)
  for (const id of marketIds) {
    if (left < WHOLESALE_MIN) break
    const shop = farms.rows.find((item) => item.structureId === id)
    if (!shop || shop.owner === row.owner || wealth.length <= shop.owner) continue
    const bought = buyLot(wealth, shop.owner, domestic, left, left, WHOLESALE_MIN)
    if (bought < WHOLESALE_MIN) continue
    payFor(wealth, shop.owner, row.owner, domestic, bought)
    row.store[good] -= bought
    rememberCost(shop, good, bought, domestic)
    shop.store[good] = (shop.store[good] ?? 0) + bought
    left -= bought
  }
}

function emptyGoods(): Record<Good, number> {
  const goods = {} as Record<Good, number>
  for (const good of GOODS) goods[good] = 0
  return goods
}

function dollars(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 2
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function cheapFee(holdings: Holdings, structures: readonly Structure[]): number | null {
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  let best: number | null = null
  for (const structure of structures) {
    if (structure.kind !== "trading-post" || structure.pending || structure.removing) continue
    const row = owned.get(structure.id)
    if (!row) continue
    const fee = postFee(row)
    if (best === null || fee < best) best = fee
  }
  return best
}
