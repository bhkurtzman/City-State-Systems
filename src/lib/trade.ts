import { monthlyCapital, type Holding, type Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { Sex, type People } from "@/lib/people"
import { familyPortions, GOOD_LABEL, GOODS, type Farms, type Good, type ShopSpecialty } from "@/lib/produce"
import type { PropertyLine } from "@/lib/land"
import { isWater, type Structure } from "@/lib/buildings"
import { Feature } from "@/lib/types"

/** Hundredths of a ton. */
const TON = 100
const TARGET_MONTHS = 3
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
}
const PRICE_FLOOR = 1

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
): { label: string; value: string; note?: string }[] {
  const stock = totalStock(farms, town)
  const ownedIds = new Set(holdings.rows.filter((row) => row.owner >= 0).map((row) => row.structureId))
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : Array.from({ length: 12 }, () => low)
  const fee = cheapFee(holdings, structures) ?? 0
  const targets = people ? stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices) : new Map()
  const use = monthlyUse(structures, people, low, ownedIds, terrain, feature, {
    farms,
    prices: town.prices,
    fee,
    stock: town.stock,
    stockOwner: town.stockOwner,
    stockAsk: town.stockAsk ?? {},
    targets,
    wealth: people?.wealth ?? new Int32Array(),
  })
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
    return { label: GOOD_LABEL[good], value: dollars(town.prices[good]), note }
  })
}

/**
 * One adult's year at town prices. Grain, the average of fruit and vegetables,
 * and the average of fish, meat, and dairy. Adult clothing and leather. Half of
 * one household's yearly fuel: wood, or coal when wood costs more than a quarter of coal.
 */
export function costOfLiving(prices: Record<Good, number>, lows: readonly number[]): number {
  const price = (good: Good) => prices[good] ?? PRICE_FLOOR
  const food =
    price("grain") * 0.1 +
    ((price("fruit") + price("vegetables")) / 2) * 0.3 +
    ((price("fish") + price("meat") + price("dairy")) / 3) * 0.1
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
  const rows = farms.rows.map((row) => ({ ...row, store: { ...emptyGoods(), ...row.store } }))
  for (const row of rows) for (const good of GOODS) if (!Number.isFinite(row.store[good])) row.store[good] = 0
  const nextFarms: Farms = { rows }
  const stock = { ...town.stock }
  const stockOwner = { ...town.stockOwner }
  const stockAsk = { ...(town.stockAsk ?? {}) }
  for (const good of GOODS) if (stock[good] == null) stock[good] = 0
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const posts = structures
    .filter((structure) => structure.kind === "trading-post" && !structure.pending && !structure.removing && owned.has(structure.id))
    .map((structure) => owned.get(structure.id) as Holding)
    .sort((a, b) => postFee(a) - postFee(b) || a.structureId - b.structureId)

  const shipments: Shipment[] = []
  const exported = new Set<Good>()
  const ownedIds = new Set(owned.keys())
  const yearLows = lows.length > 0 ? lows : [low]
  const targets = stockTargets(people, structures, owned, yearLows, terrain, feature, nextFarms, town.prices)
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
      if (wealth.length > post.owner) wealth[post.owner] += fee
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
    wealth[post.owner] -= regional
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
  runShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, month)
  restock(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts)
  for (const good of GOODS) {
    if ((stock[good] ?? 0) > 0) continue
    stock[good] = 0
    delete stockOwner[good]
    delete stockAsk[good]
  }

  const prices = { ...town.prices }
  for (const good of GOODS) if (prices[good] == null) prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
  const after = totalStock(nextFarms, { ...town, stock })
  const use = monthlyUse(structures, people, low, ownedIds, terrain, feature, tradeContext())
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (const good of GOODS) prices[good] = stepPrice(prices[good], after[good], use[good], band(good, fee))

  return {
    people: { ...people, wealth },
    farms: nextFarms,
    town: { prices, stock, stockOwner, stockAsk, shipments },
  }
}

function band(good: Good, fee: number): { floor: number; ceiling: number } {
  const foreign = WEST_EUROPE[good]
  if (!foreign) return { floor: PRICE_FLOOR, ceiling: 0 }
  // No trading post: nothing ships, so the quote stays put.
  if (fee <= 0) return { floor: foreign.price, ceiling: foreign.price }
  const bid = foreign.export ? Math.max(0, foreign.price - fee) : 0
  const ask = foreign.price + fee
  return { floor: bid > 0 ? bid : PRICE_FLOOR, ceiling: ask }
}

function stepPrice(price: number, stock: number, use: number, limits: { floor: number; ceiling: number }): number {
  if (use <= 0 && stock <= 0) return price
  const cover = use <= 0 ? 99 : Math.max(stock / TON / use, 0.05)
  const anchor = limits.floor
  const desired = anchor * Math.sqrt(TARGET_MONTHS / cover)
  let next = Math.round(price + 0.25 * (desired - price))
  if (limits.ceiling > 0) next = Math.min(next, limits.ceiling)
  return Math.max(next, limits.floor)
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
      tons.fish += (family.scale * 0.1) / 3
      tons.meat += (family.scale * 0.1) / 3
      tons.dairy += (family.scale * 0.1) / 3
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

/** Export goods are bought at the bid. Wood and local goods are bought at the town price. */
function offerPrice(good: Good, prices: Record<Good, number>, fee: number): number {
  const foreign = WEST_EUROPE[good]
  if (foreign?.export && fee > 0) {
    const bid = foreign.price - fee
    if (bid >= 1) return bid
  }
  return prices[good] ?? PRICE_FLOOR
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
    if (wealth.length > share.owner) wealth[share.owner] += dollars
  })
  const pass = Math.round((markup * farmHundredths) / TON)
  if (pass !== 0 && marketOwner >= 0 && wealth.length > marketOwner) wealth[marketOwner] += pass
  const marketed = farmHundredths + shopHundredths
  if (wealth.length > postOwner) wealth[postOwner] += fee - Math.round((markup * marketed) / TON)
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
      wealth[shop.owner] -= cost
      if (wealth.length > seller) wealth[seller] += cost
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
    wealth[buyer] -= cost
    spent += cost
    if (wealth.length > shop.owner) wealth[shop.owner] += cost
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
      wealth[buyer] -= paying
      spent += paying
      payShares(wealth, drawn.shares, farmPay)
      if (!ownsShop) {
        const shop = farms.rows.find((row) => row.structureId === marketIds[0])
        if (shop && wealth.length > shop.owner) wealth[shop.owner] += paying - farmPay
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
          wealth[buyer] -= cost
          spent += cost
          if (wealth.length > seller) wealth[seller] += cost
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
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  for (const good of GOODS) {
    const seekers = [...targets.entries()]
      .map(([owner, need]) => ({ owner, reserve: need[good] ?? 0, held: barnHeld(farms, owner, good) }))
      .filter((seeker) => seeker.reserve > 0 && seeker.held < seeker.reserve)
      .sort((a, b) => a.held / a.reserve - b.held / b.reserve || a.owner - b.owner)
    for (const seeker of seekers) {
      const barn = farms.rows.filter((row) => row.owner === seeker.owner && !marketIds.includes(row.structureId)).sort((a, b) => a.structureId - b.structureId)[0]
        ?? farms.rows.filter((row) => row.owner === seeker.owner).sort((a, b) => a.structureId - b.structureId)[0]
      if (!barn || wealth.length <= seeker.owner) continue
      const gap = seeker.reserve - barnHeld(farms, seeker.owner, good)
      const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, seeker.owner, good, gap, prices, targets, marketIds, fee)
      if (bought.taken <= 0) continue
      if (marketIds.includes(barn.structureId)) rememberCost(barn, good, bought.taken, (bought.spent * TON) / bought.taken)
      barn.store[good] = (barn.store[good] ?? 0) + bought.taken
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
    wealth[share.owner] += dollars
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
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    scale += people.age[id] <= 5 ? 0.5 : people.age[id] <= 12 ? 0.75 : 1
    if (people.age[id] >= 13) adults += 1
    else children += 1
  }
  use.grain += (scale * 0.1) / 12
  use.fruit += (scale * 0.15) / 12
  use.vegetables += (scale * 0.15) / 12
  use.fish += (scale * 0.1) / 36
  use.meat += (scale * 0.1) / 36
  use.dairy += (scale * 0.1) / 36
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
) {
  const fee = posts.length > 0 ? postFee(posts[0]) : 0
  const shops = structures.filter((structure) => structure.kind === "workshop" && !structure.pending && !structure.removing).sort((a, b) => a.id - b.id)
  for (const structure of shops) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!row?.specialty || !owned.has(structure.id)) continue
    const batch = chooseBatch(optionsFor(row.specialty, month, true), row, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee)
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
): Batch | null {
  let best: { batch: Batch; margin: number } | null = null
  for (const batch of options) {
    if ((row.store[batch.output] ?? 0) + batch.out > batch.cap) continue
    const priced = priceInputs(batch.inputs, row.owner, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, allowImport)
    if (!priced) continue
    const revenue = Math.round((offerPrice(batch.output, prices, fee) * batch.out) / TON)
    if (priced.economic > revenue) continue
    const margin = revenue - priced.economic
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
    if (sitting <= 0) continue
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
  }
  for (const input of inputs) {
    let left = input.hundredths - takeOwned(farms, stock, stockOwner, buyer, input.good, input.hundredths)
    for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee)) {
      if (left <= 0 || wealth.length <= buyer) break
      const take = Math.min(lot.hundredths, left, affordable(wealth[buyer], lot.price, lot.hundredths))
      if (take <= 0) continue
      const dollars = Math.round((lot.price * take) / TON)
      wealth[buyer] -= dollars
      if (lot.owner >= 0 && wealth.length > lot.owner) wealth[lot.owner] += dollars
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
    wealth[shop.owner] -= cost
    if (wealth.length > row.owner) wealth[row.owner] += cost
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
