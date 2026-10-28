import { monthlyCapital, type Holding, type Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { copyIncomeLog, householdHomes, householdRanks, noteOperatingIncome, Sex, type People, type SocialClass } from "@/lib/people"
import { familyPortions, GOOD_LABEL, GOODS, type Farms, type Good, type ShopSpecialty } from "@/lib/produce"
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
/**
 * Expected tons a farm uses per year for each 1,000 dry tiles.
 * Steel, leather, and textiles are each a 10% chance of 0.1 ton.
 */
const FARM_STEEL_PER_THOUSAND = 0.1 * 0.1
const FARM_LEATHER_PER_THOUSAND = 0.1 * 0.1
const FARM_TEXTILE_PER_THOUSAND = 0.1 * 0.1

type Portion = { owner: number; hundredths: number; structureId: number | null; shop: boolean; direct?: boolean }

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
}
const PRICE_FLOOR = 1

type IncomeBooks = { income: Int32Array; log: Int32Array; month: number }

/** Set for the month being settled. Cash from sales, fees, goods, and nothing else goes through credit. */
let books: IncomeBooks | null = null

function credit(wealth: Int32Array, id: number, dollars: number) {
  if (!Number.isFinite(dollars) || dollars === 0) return
  if (id < 0 || id >= wealth.length) return
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
  meat: null,
  hide: null,
  wood: { price: 15, export: true },
  lumber: { price: 40, export: true },
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
  /** Hundredths of a ton sitting in the market pool. */
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
): { label: string; value: string; note?: string; sub?: string }[] {
  const stock = totalStock(farms, town)
  const ownedIds = new Set(holdings.rows.filter((row) => row.owner >= 0).map((row) => row.structureId))
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : Array.from({ length: 12 }, () => low)
  const fee = cheapFee(holdings, structures) ?? 0
  const plan = people
    ? planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town)
    : null
  const targets = people ? stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices, plan ?? undefined) : new Map()
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
 * One adult's year at town prices. Grain, the average of fruit and vegetables,
 * and the average of a year of meat, a year of fish, and a year of dairy.
 * Dairy is twice the weight. Adult clothing and leather. Half of
 * one household's yearly fuel: wood, or coal when wood costs more than a quarter of coal.
 */
export function costOfLiving(prices: Record<Good, number>, lows: readonly number[]): number {
  const price = (good: Good) => prices[good] ?? PRICE_FLOOR
  const food =
    price("grain") * 0.1 +
    ((price("fruit") + price("vegetables")) / 2) * 0.3 +
    (price("meat") * 0.1 + price("fish") * 0.1 + price("dairy") * 0.2) / 3
  const supplies = price("clothing") * 0.01 + price("leather") * 0.005
  const woodYear = lows.reduce((sum, value) => sum + (value < 4 ? 4 : 2), 0)
  const wood = price("wood")
  const coal = price("coal")
  const fuel = wood * 4 <= coal ? woodYear * wood : (woodYear / 4) * coal
  return Math.round(food + supplies + fuel / 2)
}

/**
 * The cheapest post sets the bid and the ask. Each post ships one ton of whatever
 * excess good it rolls, so the same good can leave more than once. A good that
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
): { people: People; farms: Farms; town: TownTrade } {
  const wealth = new Int32Array(people.wealth)
  const income = new Int32Array(people.income ?? people.age.length)
  const incomeLog = copyIncomeLog(people, people.age.length)
  books = { income, log: incomeLog, month }
  const rows = farms.rows.map((row) => ({ ...row, store: { ...emptyGoods(), ...row.store } }))
  for (const row of rows) for (const good of GOODS) if (!Number.isFinite(row.store[good])) row.store[good] = 0
  const nextFarms: Farms = { rows }
  const stock = { ...town.stock }
  const stockOwner = { ...town.stockOwner }
  const stockAsk = { ...(town.stockAsk ?? {}) }
  for (const good of GOODS) if (stock[good] == null) stock[good] = 0
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : [low]
  const protein = planProtein(people, structures, owned, nextFarms, town.prices, yearLows, terrain, feature, seed, year, month, town)
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
  const workshopIds = new Set(structures.filter((structure) => structure.kind === "workshop" && !structure.pending && !structure.removing).map((structure) => structure.id))
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
  })
  for (const post of posts) {
    const fee = postFee(post)
    const rng = mulberry32(hashSeed(`${seed}:export:${post.structureId}:${year}:${month}`))
    const good = bestExport(nextFarms, stock, targets, fee, marketIds.length === 0, rng)
    if (!good) break
    const bid = (WEST_EUROPE[good] as Quote).price - fee
    const direct = marketIds.length === 0 || good === "dried-fruit"
    const drawn = direct
      ? drawSpare(nextFarms, stock, stockOwner, targets, good, TON, workshopIds)
      : drawThroughMarket(nextFarms, targets, marketIds, good, TON, [], -1, workshopIds)
    if (drawn.taken < TON) {
      restore(nextFarms, stock, good, drawn.shares)
      continue
    }
    const fromWorkshop = drawn.shares.length > 0 && drawn.shares.every((share) => share.direct)
    if (direct || fromWorkshop) {
      payShares(wealth, drawn.shares, bid)
      credit(wealth, post.owner, fee)
    } else settleExport(wealth, drawn.shares, bid, fee, post.owner, owned.get(marketIds[0])?.owner ?? -1)
    exported.add(good)
    shipments.push({ postId: post.structureId, good, way: "export", dollars: bid })
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
  marketsBuyPool(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, marketIds)

  burnFuel(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, low)
  if (month === 0) {
    for (const post of posts) feedPost(post, nextFarms, stock, stockOwner, year, seed)
    feedFarms(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, terrain, feature, year, seed)
    feedShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, seed)
    wear(people, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, seed)
  }
  const prices = { ...town.prices }
  for (const good of GOODS) if (prices[good] == null) prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
  const feeNow = posts.length > 0 ? postFee(posts[0]) : 0
  const measure = (marks?: Record<Good, number>) =>
    monthlyUse(structures, people, low, ownedIds, terrain, feature, { ...tradeContext(), marks })
  const shopMarks = quotedPrices(totalStock(nextFarms, { ...town, stock }), prices, feeNow, posts.length, measure)
  runShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, posts, month, shopMarks)
  restock(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, protein.orders, protein.headOf)
  for (const good of GOODS) {
    if ((stock[good] ?? 0) > 0) continue
    stock[good] = 0
    delete stockOwner[good]
    delete stockAsk[good]
  }

  const after = totalStock(nextFarms, { ...town, stock })
  const desired = quotedPrices(after, prices, feeNow, posts.length, measure)
  for (const good of GOODS) prices[good] = glidePrice(prices[good], desired[good])

  books = null
  sellProtein = () => true
  return {
    people: { ...people, wealth, income, incomeLog },
    farms: nextFarms,
    town: { prices, stock, stockOwner, stockAsk, shipments, proteinYear: year, proteinPick: storeProteinPick(protein.orders, people, protein.headOf) },
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

function priceMarks(
  stock: Record<Good, number>,
  use: Record<Good, number>,
  posted: Record<Good, number>,
  fee: number,
  posts: number,
): Record<Good, number> {
  const priced = {} as Record<Good, number>
  for (const good of GOODS) priced[good] = priceStock(stock[good] ?? 0)
  const pressure = saturations(priced, use, fee, posts)
  const marks = {} as Record<Good, number>
  for (const good of GOODS) {
    marks[good] = desiredPrice(good, posted[good] ?? PRICE_FLOOR, stock[good] ?? 0, use[good] ?? 0, fee, pressure)
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

function bestExport(
  farms: Farms,
  stock: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  fee: number,
  includePool: boolean,
  rng: () => number,
): Good | null {
  const ranked: { good: Good; extra: number }[] = []
  for (const good of GOODS) {
    const foreign = WEST_EUROPE[good]
    if (!foreign?.export || foreign.price - fee < 1) continue
    const extra = exportable(farms, stock, targets, good, includePool)
    if (extra >= TON) ranked.push({ good, extra })
  }
  ranked.sort((a, b) => b.extra - a.extra || GOODS.indexOf(a.good) - GOODS.indexOf(b.good))
  if (ranked.length === 0) return null
  if (ranked.length === 1) return ranked[0].good
  const roll = rng()
  if (roll < 0.8) return ranked[0].good
  if (roll < 0.9 || ranked.length === 2) return ranked[1].good
  const rest = ranked.slice(2)
  return rest[Math.min(rest.length - 1, Math.floor(rng() * rest.length))].good
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
    if (left > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, row.owner, good, left, prices, targets, marketIds, fee)
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
    if (rng() < Math.min(1, 0.1 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee)
    if (rng() < Math.min(1, 0.1 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "leather", 10, prices, targets, marketIds, fee)
    if (rng() < Math.min(1, 0.1 * scale)) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "textiles", 10, prices, targets, marketIds, fee)
  }
}

function feedPost(post: Holding, farms: Farms, stock: Record<Good, number>, stockOwner: Partial<Record<Good, number>>, year: number, seed: string) {
  takeOwned(farms, stock, stockOwner, post.owner, "grain", TON)
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
) {
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const rng = mulberry32(hashSeed(`${seed}:wear:${year}:${id}`))
    const head = purseOf(people, id)
    const fee = posts.length > 0 ? postFee(posts[0]) : 0
    if (people.age[id] >= 13 && rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, head, "leather", 10, prices, targets, marketIds, fee)
    if (people.age[id] >= 13 && rng() < 0.1) buyNeed(farms, stock, stockOwner, stockAsk, wealth, head, "clothing", 10, prices, targets, marketIds, fee)
    if (people.age[id] <= 12 && rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, head, "clothing", 10, prices, targets, marketIds, fee)
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
) {
  const owned = takeOwned(farms, stock, stockOwner, head, good, hundredths)
  const rest = hundredths - owned
  if (rest > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, head, good, rest, prices, targets, marketIds, fee)
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
  return extra
}

function drawSpare(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  hundredths: number,
  workshopIds: ReadonlySet<number> = new Set(),
): { taken: number; shares: Portion[] } {
  let left = hundredths
  const shares: Portion[] = []
  const spare = new Map<number, number>()
  let short = false
  for (const row of farms.rows) {
    if (spare.has(row.owner)) continue
    const reserve = targets.get(row.owner)?.[good] ?? 0
    const held = barnHeld(farms, row.owner, good)
    spare.set(row.owner, Math.max(0, held - reserve))
    if (reserve > 0 && held < reserve) short = true
  }
  for (const [owner, need] of targets) {
    if ((need[good] ?? 0) > 0 && !spare.has(owner)) short = true
  }
  const order = [...farms.rows].sort((a, b) => (b.store[good] ?? 0) - (a.store[good] ?? 0) || a.structureId - b.structureId)
  for (const row of order) {
    if (left <= 0) break
    if (!sellProtein(row.structureId, good)) continue
    const room = spare.get(row.owner) ?? 0
    const taken = Math.min(row.store[good] ?? 0, left, room)
    if (taken <= 0) continue
    row.store[good] = (row.store[good] ?? 0) - taken
    spare.set(row.owner, room - taken)
    shares.push({ owner: row.owner, hundredths: taken, structureId: row.structureId, shop: false, direct: workshopIds.has(row.structureId) })
    left -= taken
  }
  if (!short && left > 0 && (stock[good] ?? 0) > 0) {
    const taken = Math.min(stock[good], left)
    stock[good] -= taken
    shares.push({ owner: stockOwner[good] ?? -1, hundredths: taken, structureId: null, shop: false })
    left -= taken
  }
  return { taken: hundredths - left, shares }
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

/** A year of protein is 0.1 t of meat, 0.1 t of fish, or 0.2 t of dairy. */
const PROTEINS: readonly Good[] = ["meat", "dairy", "fish"]

function proteinTons(good: Good): number {
  return good === "dairy" ? 0.2 : 0.1
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
): { orders: Map<number, Good[]>; headOf: Int32Array; sources: Map<number, Set<Good>>; farmsteads: Set<number> } {
  const homes = householdHomes(structures, [...owned.values()])
  const { rank, headOf } = householdRanks(people, costOfLiving(prices, lows), homes)
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
  return { orders, headOf, sources, farmsteads }
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
  stockOwner: Partial<Record<Good, number>>,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  buyer: number,
): boolean {
  const spare = new Map<number, number>()
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer || !sellProtein(row.structureId, good)) continue
    if (!spare.has(row.owner)) spare.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - (targets.get(row.owner)?.[good] ?? 0)))
    if ((spare.get(row.owner) ?? 0) > 0 && (row.store[good] ?? 0) > 0) return true
  }
  const seller = stockOwner[good]
  return (stock[good] ?? 0) > 0 && seller !== undefined && seller !== buyer
}

/** Two years of food, fuel, clothing, business supplies, and farm tools, in hundredths of a ton. */
function stockTargets(
  people: People,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  lows: readonly number[],
  terrain: Uint8Array,
  feature: Uint8Array,
  farms: Farms,
  prices: Record<Good, number>,
  protein?: { orders: Map<number, Good[]>; headOf: Int32Array },
): Map<number, Record<Good, number>> {
  const woodYear = lows.reduce((sum, value) => sum + (value < 4 ? 4 : 2), 0)
  const houses = new Map<number, number>()
  const fuelHomes = new Map<number, number>()
  const shops = new Map<number, number>()
  const farmTools = new Map<number, { steel: number; leather: number; textiles: number }>()
  const inputHold = new Map<number, Record<Good, number>>()
  for (const structure of structures) {
    const row = owned.get(structure.id)
    if (!row || structure.pending || structure.removing) continue
    if (isHouse(structure)) houses.set(row.owner, (houses.get(row.owner) ?? 0) + 1)
    if (heatsHouse(structure, farms)) fuelHomes.set(row.owner, (fuelHomes.get(row.owner) ?? 0) + 1)
    if (structure.kind === "market" || structure.kind === "workshop" || structure.kind === "trading-post") {
      shops.set(row.owner, (shops.get(row.owner) ?? 0) + 1)
    }
    if (structure.kind === "workshop") {
      const bag = farmTools.get(row.owner) ?? { steel: 0, leather: 0, textiles: 0 }
      bag.steel += 0.01
      bag.leather += 0.01
      farmTools.set(row.owner, bag)
      const extra = inputHold.get(row.owner) ?? emptyGoods()
      const store = farms.rows.find((item) => item.structureId === structure.id)?.store
      holdShopInputs(extra, farms.rows.find((item) => item.structureId === structure.id)?.specialty, store)
      inputHold.set(row.owner, extra)
    }
    const scale = dryFarmScale(structure, terrain, feature)
    if (scale <= 0) continue
    const bag = farmTools.get(row.owner) ?? { steel: 0, leather: 0, textiles: 0 }
    bag.steel += FARM_STEEL_PER_THOUSAND * scale
    bag.leather += FARM_LEATHER_PER_THOUSAND * scale
    bag.textiles += FARM_TEXTILE_PER_THOUSAND * scale
    farmTools.set(row.owner, bag)
  }
  const woodFirst = preferWood(prices)
  const targets = new Map<number, Record<Good, number>>()
  for (const owner of new Set([...houses.keys(), ...shops.keys(), ...farmTools.keys()])) {
    const tons = emptyGoods()
    const home = houses.get(owner) ?? 0
    const businesses = shops.get(owner) ?? 0
    if (home > 0) {
      const family = familyPortions(people, owner)
      tons.grain += family.scale * 0.1
      tons.fruit += family.scale * 0.15
      tons.vegetables += family.scale * 0.15
      const head = protein ? homeHead(protein.headOf, owner) : owner
      const pick = protein?.orders.get(head)?.[0]
      if (pick) tons[pick] += family.scale * proteinTons(pick)
      tons.clothing += family.adults * 0.01 + family.children * 0.005
      tons.leather += family.adults * 0.005
    }
    const fires = fuelHomes.get(owner) ?? 0
    if (woodFirst) tons.wood += fires * woodYear
    else tons.coal += fires * (woodYear / 4)
    tons.grain += businesses
    tons.leather += businesses * 0.05
    tons.textiles += businesses * 0.05
    tons["steel-tools"] += businesses * 0.025
    const tool = farmTools.get(owner)
    if (tool) {
      tons["steel-tools"] += tool.steel
      tons.leather += tool.leather
      tons.textiles += tool.textiles
    }
    const hundredths = emptyGoods()
    for (const good of GOODS) hundredths[good] = Math.ceil(tons[good] * STOCK_YEARS * TON - 1e-6)
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

function rememberCost(row: { cost?: Partial<Record<Good, number>>; store: Record<Good, number> }, good: Good, added: number, unit: number) {
  const next = { ...(row.cost ?? {}) }
  const held = row.store[good] ?? 0
  const previous = next[good] ?? unit
  next[good] = held + added <= 0 ? unit : (held * previous + added * unit) / (held + added)
  row.cost = next
}

function settleExport(
  wealth: Int32Array,
  shares: Portion[],
  bid: number,
  fee: number,
  postOwner: number,
  marketOwner: number,
) {
  const markup = sellPrice(bid) - bid
  const directSold = shares.filter((share) => share.direct)
  const farmsSold = shares.filter((share) => !share.shop && !share.direct)
  const shopsSold = shares.filter((share) => share.shop)
  const directHundredths = directSold.reduce((sum, share) => sum + share.hundredths, 0)
  const farmHundredths = farmsSold.reduce((sum, share) => sum + share.hundredths, 0)
  const shopHundredths = shopsSold.reduce((sum, item) => sum + item.hundredths, 0)
  if (directHundredths > 0) payShares(wealth, directSold, Math.round((bid * directHundredths) / TON))
  if (farmHundredths > 0) payShares(wealth, farmsSold, Math.round((bid * farmHundredths) / TON))
  let credited = 0
  const shopDollars = Math.round(((bid + markup) * shopHundredths) / TON)
  shopsSold.forEach((share, index) => {
    const dollars = index === shopsSold.length - 1 ? shopDollars - credited : Math.round(((bid + markup) * share.hundredths) / TON)
    credited += dollars
    if (wealth.length > share.owner) credit(wealth, share.owner, dollars)
  })
  const pass = Math.round((markup * farmHundredths) / TON)
  if (pass !== 0 && marketOwner >= 0) credit(wealth, marketOwner, pass)
  const marketed = farmHundredths + shopHundredths
  credit(wealth, postOwner, fee - Math.round((markup * marketed) / TON))
}

function drawThroughMarket(
  farms: Farms,
  targets: Map<number, Record<Good, number>>,
  marketIds: number[],
  good: Good,
  hundredths: number,
  skipIds: number[] = [],
  exceptOwner = -1,
  workshopIds: ReadonlySet<number> = new Set(),
): { taken: number; shares: Portion[] } {
  let left = hundredths
  const shares: Portion[] = []
  const spare = new Map<number, number>()
  const rows = farms.rows.filter((row) => !skipIds.includes(row.structureId) && row.owner !== exceptOwner)
  for (const row of rows) {
    if (spare.has(row.owner)) continue
    const reserve = targets.get(row.owner)?.[good] ?? 0
    spare.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - reserve))
  }
  const shops = rows.filter((row) => marketIds.includes(row.structureId)).sort((a, b) => a.structureId - b.structureId)
  const others = rows.filter((row) => !marketIds.includes(row.structureId)).sort((a, b) => (b.store[good] ?? 0) - (a.store[good] ?? 0) || a.structureId - b.structureId)
  for (const row of [...shops, ...others]) {
    if (left <= 0) break
    if (!sellProtein(row.structureId, good)) continue
    const room = spare.get(row.owner) ?? 0
    const taken = Math.min(row.store[good] ?? 0, left, room)
    if (taken <= 0) continue
    row.store[good] = (row.store[good] ?? 0) - taken
    spare.set(row.owner, room - taken)
    shares.push({
      owner: row.owner,
      hundredths: taken,
      structureId: row.structureId,
      shop: marketIds.includes(row.structureId),
      direct: workshopIds.has(row.structureId),
    })
    left -= taken
  }
  return { taken: hundredths - left, shares }
}

function marketsBuyPool(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  marketIds: number[],
) {
  for (const good of GOODS) {
    for (const id of marketIds) {
      if ((stock[good] ?? 0) <= 0) break
      const seller = stockOwner[good]
      const shop = farms.rows.find((row) => row.structureId === id)
      if (!shop || seller === undefined || seller === shop.owner || wealth.length <= shop.owner) continue
      const ask = stockAsk[good] ?? prices[good]
      const bought = affordable(wealth[shop.owner], ask, stock[good])
      if (bought <= 0) continue
      const cost = ask <= 0 ? 0 : Math.round((ask * bought) / TON)
      credit(wealth, shop.owner, -cost)
      credit(wealth, seller, cost)
      rememberCost(shop, good, bought, ask)
      shop.store[good] = (shop.store[good] ?? 0) + bought
      stock[good] -= bought
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
  marketIds: number[],
  fee: number,
): { taken: number; spent: number } {
  let left = hundredths
  let spent = 0
  const shops = farms.rows.filter((row) => marketIds.includes(row.structureId) && row.owner !== buyer).sort((a, b) => a.structureId - b.structureId)
  for (const shop of shops) {
    if (left <= 0 || wealth.length <= buyer) break
    const reserve = targets.get(shop.owner)?.[good] ?? 0
    const room = Math.max(0, barnHeld(farms, shop.owner, good) - reserve)
    const offer = Math.min(shop.store[good] ?? 0, room, left)
    if (offer <= 0) continue
    const price = sellPrice(shop.cost?.[good] ?? offerPrice(good, prices, fee))
    const bought = affordable(wealth[buyer], price, offer)
    if (bought <= 0) continue
    const cost = price <= 0 ? 0 : Math.round((price * bought) / TON)
    credit(wealth, buyer, -cost)
    spent += cost
    credit(wealth, shop.owner, cost)
    shop.store[good] = (shop.store[good] ?? 0) - bought
    left -= bought
  }
  if (left > 0 && marketIds.length > 0 && wealth.length > buyer) {
    const unit = offerPrice(good, prices, fee)
    const ownsShop = farms.rows.some((row) => marketIds.includes(row.structureId) && row.owner === buyer)
    const price = ownsShop ? unit : sellPrice(unit)
    const want = affordable(wealth[buyer], price, left)
    const drawn = drawThroughMarket(farms, targets, [], good, want, marketIds, buyer)
    const taken = drawn.shares.reduce((sum, share) => sum + share.hundredths, 0)
    if (taken > 0) {
      const paying = Math.round((price * taken) / TON)
      const farmPay = Math.round((unit * taken) / TON)
      credit(wealth, buyer, -paying)
      spent += paying
      payShares(wealth, drawn.shares, farmPay)
      if (!ownsShop) {
        const shop = farms.rows.find((row) => row.structureId === marketIds[0])
        if (shop) credit(wealth, shop.owner, paying - farmPay)
      }
      left -= taken
    }
  }
  if (left > 0 && wealth.length > buyer) {
    const seller = stockOwner[good]
    const available = Math.min(stock[good] ?? 0, left)
    if (available > 0 && seller !== undefined) {
      if (seller === buyer) {
        stock[good] -= available
        left -= available
      } else {
        const sticker = stockAsk[good] ?? prices[good] ?? PRICE_FLOOR
        const bought = affordable(wealth[buyer], sticker, available)
        if (bought > 0) {
          const cost = sticker <= 0 ? 0 : Math.round((sticker * bought) / TON)
          credit(wealth, buyer, -cost)
          spent += cost
          credit(wealth, seller, cost)
          stock[good] -= bought
          left -= bought
        }
      }
    }
  }
  return { taken: hundredths - left, spent }
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
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, owner, good, hundredths, prices, targets, marketIds, fee)
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
      if (proteinForSale(farms, stock, stockOwner, targets, first, owner)) continue
      const short = reserve - held
      for (const good of item.order.slice(1)) {
        if (!proteinForSale(farms, stock, stockOwner, targets, good, owner)) continue
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

function restore(farms: Farms, stock: Record<Good, number>, good: Good, shares: Portion[]) {
  for (const share of shares) {
    const row = share.structureId === null ? undefined : farms.rows.find((item) => item.structureId === share.structureId)
    if (row) row.store[good] = (row.store[good] ?? 0) + share.hundredths
    else stock[good] += share.hundredths
  }
}

function payShares(wealth: Int32Array, shares: { owner: number; hundredths: number }[], bid: number) {
  const taken = shares.reduce((sum, share) => sum + share.hundredths, 0)
  let paid = 0
  shares.forEach((share, index) => {
    if (share.owner < 0 || wealth.length <= share.owner) return
    const dollars = index === shares.length - 1 ? bid - paid : Math.round((bid * share.hundredths) / taken)
    paid += dollars
    credit(wealth, share.owner, dollars)
  })
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
  let adults = 0
  let children = 0
  const orders = context?.proteinOrders
  const headOf = context?.headOf
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const portion = people.age[id] <= 5 ? 0.5 : people.age[id] <= 12 ? 0.75 : 1
    scale += portion
    if (people.age[id] >= 13) adults += 1
    else children += 1
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
    use.dairy += (scale * 0.1) / 36
  }
  use.clothing += (adults * 0.1 * 0.1 + children * 0.05 * 0.1) / 12
  use.leather += (adults * 0.05 * 0.1) / 12
  return use
}

function totalStock(farms: Farms, town: TownTrade): Record<Good, number> {
  const stock = { ...town.stock }
  for (const row of farms.rows) {
    for (const good of GOODS) stock[good] += row.store[good] ?? 0
  }
  return stock
}

function isHouse(structure: Structure): boolean {
  return !structure.pending && !structure.removing && (structure.kind === "farmstead" || structure.kind === "market" || structure.kind === "trading-post" || structure.kind === "workshop")
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
}

function addInputs(extra: Record<Good, number>, batch: Batch) {
  for (const input of batch.inputs) extra[input.good] += input.hundredths
}

const SHOP_BATCHES: Record<ShopSpecialty, Batch[]> = {
  sawmill: [SAWMILL_BATCH],
  blacksmith: [PARTS_BATCH, TOOLS_BATCH],
  smokehouse: [FISH_BATCH, MEAT_BATCH],
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

/** Best batch of each specialty that still earns money, highest monthly margin first. A blacksmith runs three months a year. */
function rankedSpecialties(marks: Record<Good, number>, stock: Record<Good, number>, fee: number): ShopSpecialty[] {
  const order = ["sawmill", "blacksmith", "smokehouse"] as const
  const scored: { specialty: ShopSpecialty; margin: number }[] = []
  for (const specialty of order) {
    let top: number | null = null
    for (const batch of SHOP_BATCHES[specialty]) {
      const margin = batchQuote(batch, marks, stock, fee)
      if (margin === null || margin <= 0) continue
      if (top === null || margin > top) top = margin
    }
    if (top === null) continue
    const months = specialty === "blacksmith" ? 3 / 12 : 1
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
): ShopSpecialty[] {
  if (!people) return []
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const ownedIds = new Set(owned.keys())
  const yearLows = lows.length > 0 ? lows : [low]
  const plan = planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town)
  const fee = cheapFee(holdings, structures) ?? 0
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
  return [FISH_BATCH, MEAT_BATCH]
}

function shopOutputs(specialty: ShopSpecialty): Good[] {
  if (specialty === "sawmill") return ["lumber"]
  if (specialty === "blacksmith") return ["steel-parts", "steel-tools"]
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

/** January. Each workshop rolls a tenth of a ton of tools and of leather, at 10% each. */
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
    if (rng() < 0.1) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee)
    if (rng() < 0.1) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "leather", 10, prices, targets, marketIds, fee)
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
    for (const good of shopOutputs(row.specialty)) sellLocal(row, good, farms, wealth, prices, marketIds, fee)
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
    use["steel-tools"] += 0.01 / 12
    use.leather += 0.01 / 12
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
    const scale = row.specialty === "blacksmith" ? 0.25 : 1
    for (const input of batch.inputs) use[input.good] += (input.hundredths / TON) * scale
  }
}

type SupplyLot = { price: number; hundredths: number; structureId: number | null; owner: number }

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
  marketIds: number[],
  fee: number,
): SupplyLot[] {
  const ownsShop = farms.rows.some((row) => marketIds.includes(row.structureId) && row.owner === buyer)
  const unit = offerPrice(good, prices, fee)
  const farmPrice = marketIds.length > 0 && !ownsShop ? sellPrice(unit) : unit
  const ranked: SupplyLot[] = []
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer) continue
    const sitting = row.store[good] ?? 0
    if (sitting <= 0 || !sellProtein(row.structureId, good)) continue
    const isMarket = marketIds.includes(row.structureId)
    ranked.push({
      price: isMarket ? sellPrice(row.cost?.[good] ?? unit) : farmPrice,
      hundredths: sitting,
      structureId: row.structureId,
      owner: row.owner,
    })
  }
  if ((stock[good] ?? 0) > 0 && stockOwner[good] !== undefined && stockOwner[good] !== buyer) {
    ranked.push({
      price: stockAsk[good] ?? prices[good] ?? PRICE_FLOOR,
      hundredths: stock[good] ?? 0,
      structureId: null,
      owner: stockOwner[good] as number,
    })
  }
  ranked.sort((a, b) => a.price - b.price || (a.structureId ?? 1e9) - (b.structureId ?? 1e9))
  const spare = new Map<number, number>()
  const lots: SupplyLot[] = []
  for (const source of ranked) {
    if (!spare.has(source.owner)) {
      const reserve = targets.get(source.owner)?.[good] ?? 0
      let held = barnHeld(farms, source.owner, good)
      if (stockOwner[good] === source.owner) held += stock[good] ?? 0
      spare.set(source.owner, Math.max(0, held - reserve))
    }
    const room = spare.get(source.owner) ?? 0
    const offer = Math.min(source.hundredths, room)
    if (offer <= 0) continue
    spare.set(source.owner, room - offer)
    lots.push({ ...source, hundredths: offer })
  }
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
        if (left <= 0) break
        const take = Math.min(lot.hundredths, left)
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
    if (books && saved.income && saved.log) {
      books.income.set(saved.income)
      books.log.set(saved.log)
    }
  }
  for (const input of inputs) {
    let left = input.hundredths - takeOwned(farms, stock, stockOwner, buyer, input.good, input.hundredths)
    for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee)) {
      if (left <= 0 || wealth.length <= buyer) break
      const take = Math.min(lot.hundredths, left, affordable(wealth[buyer], lot.price, lot.hundredths))
      if (take <= 0) continue
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

/** Lumber cannot clear the export bid, so the workshop sells it to a market at the town price. */
function sellLocal(
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  farms: Farms,
  wealth: Int32Array,
  prices: Record<Good, number>,
  marketIds: number[],
  fee: number,
) {
  const foreign = WEST_EUROPE[good]
  const bid = foreign?.export && fee > 0 ? foreign.price - fee : 0
  if (bid >= 1) return
  let left = row.store[good] ?? 0
  if (left <= 0 || marketIds.length === 0) return
  const price = offerPrice(good, prices, fee)
  for (const id of marketIds) {
    if (left <= 0) break
    const shop = farms.rows.find((item) => item.structureId === id)
    if (!shop || shop.owner === row.owner || wealth.length <= shop.owner) continue
    const bought = affordable(wealth[shop.owner], price, left)
    if (bought <= 0) continue
    const cost = price <= 0 ? 0 : Math.round((price * bought) / TON)
    credit(wealth, shop.owner, -cost)
    credit(wealth, row.owner, cost)
    row.store[good] -= bought
    rememberCost(shop, good, bought, price)
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
