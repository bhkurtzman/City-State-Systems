import { DEFAULT_WAGES } from "@/lib/construction"
import { monthlyCapital, type Holding, type Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { copyIncomeLog, grantBirthdaySeeds, householdHomes, householdRanks, noteOperatingIncome, sectorIncomes, type People, type SocialClass } from "@/lib/people"
import { familyPortions, FARM_STORE_CAP, GOOD_LABEL, GOODS, SHELF_TARGET, type FarmRecord, type Farms, type Good, type ShopSpecialty } from "@/lib/produce"
import type { PropertyLine } from "@/lib/land"
import { isWater, type Structure } from "@/lib/buildings"
import { emptyRoads, pantryOrders, type RoadBook } from "@/lib/roads"
import { Feature, Terrain } from "@/lib/types"
import { assignShopSpecialties, RETAIL_NAME, RETAIL_ORDER, shopLineTarget, type RetailSpecialty } from "@/lib/shop"

/** Hundredths of a ton. */
const TON = 100
const TARGET_MONTHS = 3
/** Cover below this is a shortage for a good made through the year. Exports of that good also stop here. */
const COVER_SHORT = 4
/** Cover above this is a surplus for a good made through the year. */
const COVER_LONG = 12
/**
 * Month a harvest good arrives. That month the reserve is 12 months of use,
 * then one month less each month until the next harvest.
 */
const SEASON_MONTH: Partial<Record<Good, number>> = {
  fish: 3,
  dairy: 4,
  vegetables: 6,
  fruit: 7,
  grain: 9,
  fiber: 9,
  meat: 10,
}
const PRICE_CEILING = 100_000
/** Years of expected use a household or business holds back, and tries to buy up to. */
const STOCK_YEARS = 2
/** A market sells at this markup over what it paid. */
const MARKUP = 0.2
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
/** An adult's base chance of wearing out clothing. Leather is half of this. A child adds half the clothing chance and no leather. The household adds those chances and rolls once; the total stops at 100%, so a hit uses 0.1 t. These are half the comfort roll, and the comfort price multiplies them back. */
const CLOTH_CHANCE: Record<SocialClass, number> = {
  poor: 0.01,
  working: 0.02,
  middle: 0.025,
  upper: 0.035,
  wealthy: 0.05,
}

/** One household roll for 0.1 t of spices. Poor and working households do not buy them. The comfort price doubles the roll. */
const SPICE_CHANCE: Partial<Record<SocialClass, number>> = {
  middle: 0.01,
  upper: 0.02,
  wealthy: 0.03,
}

/** Extra demand at or below half the walk-away price. A missing good stays at one roll. The boosted roll is still capped at 100%. */
const DEMAND_ELASTICITY: Partial<Record<Good, number>> = {
  clothing: 2,
  leather: 1.5,
  spices: 2,
  beer: 1.5,
  "steel-tools": 1.5,
}

function demandElasticity(good: Good): number {
  return DEMAND_ELASTICITY[good] ?? 1
}

/** The base roll, and the same roll multiplied at the comfort price. Each is capped at 1. */
function elasticRoll(base: number, elasticity: number): { base: number; comfort: number } {
  const plain = Math.min(1, Math.max(0, base))
  return { base: plain, comfort: Math.min(1, plain * elasticity) }
}

/** Chances added across one household, each capped at 1. A hit then uses 0.1 t. */
function wearChances(ages: readonly number[], clothing: number): { cloth: number; leather: number } {
  let cloth = 0
  let leather = 0
  for (const age of ages) {
    if (age >= 13) {
      cloth += clothing
      leather += clothing / 2
    } else cloth += clothing / 2
  }
  return { cloth: Math.min(1, cloth), leather: Math.min(1, leather) }
}

/** Hundredths of clothing and of leather kept in the pantry. Upper and wealthy hold more. */
function closetFloor(rank: SocialClass): number {
  if (rank === "wealthy") return 30
  if (rank === "upper") return 20
  return 10
}

/** Tons of wood one heated house burns in a year. A month under 4°C burns 4 t, and every other month burns 2 t. */
function yearOfWood(lows: readonly number[]): number {
  return lows.reduce((sum, value) => sum + (value < 4 ? 4 : 2), 0)
}

type Closet = { clothing: number; leather: number; spices: number }

/** Personal clothing and leather withheld from sale. Operating reserves stay in `stockTargets`. */
let personalHold = new Map<number, Closet>()
let censusHead: Int32Array | null = null

function installCloset(people: People, headOf: Int32Array, rank: Map<number, SocialClass>) {
  personalHold = new Map()
  censusHead = headOf
  for (let id = 0; id < people.alive.length; id++) {
    if (people.alive[id] === 0 || homeHead(headOf, id) !== id) continue
    const floor = closetFloor(rank.get(id) ?? "poor")
    const spices = SPICE_CHANCE[rank.get(id) ?? "poor"] ? 10 : 0
    personalHold.set(id, { clothing: floor, leather: floor, spices })
  }
}

function clearCloset() {
  personalHold = new Map()
  censusHead = null
}

function heldBack(targets: Map<number, Record<Good, number>>, owner: number, good: Good): number {
  const reserve = targets.get(owner)?.[good] ?? 0
  if (good !== "clothing" && good !== "leather" && good !== "spices") return reserve
  const head = censusHead ? homeHead(censusHead, owner) : owner
  const pile = personalHold.get(head)
  if (!pile) return reserve
  return reserve + pile[good]
}

type Deal = "retail" | "workshop" | "market"

type Routes = {
  farmIds: Set<number>
  workshopIds: Set<number>
  marketIds: number[]
  shopIds: number[]
  kindOf: Map<number, Structure["kind"]>
}

function bindRoutes(structures: readonly Structure[], ownedIds: ReadonlySet<number>) {
  const ids = (kind: Structure["kind"]) =>
    structures
      .filter((structure) => structure.kind === kind && !structure.pending && !structure.removing && ownedIds.has(structure.id))
      .map((structure) => structure.id)
  routes.farmIds = new Set(ids("farmstead"))
  routes.workshopIds = new Set([...ids("workshop"), ...ids("sawpit")])
  routes.marketIds = ids("market").sort((a, b) => a - b)
  routes.shopIds = ids("shop").sort((a, b) => a - b)
  routes.kindOf = new Map(structures.map((structure) => [structure.id, structure.kind]))
}

let routes: Routes = {
  farmIds: new Set(),
  workshopIds: new Set(),
  marketIds: [],
  shopIds: [],
  kindOf: new Map(),
}

type HaulState = {
  size: number
  kind: Map<number, Structure["kind"]>
  tiles: Map<number, readonly number[]>
  owner: Map<number, number>
  reach: Map<number, number>
}

function emptyHaul(): HaulState {
  return { size: 0, kind: new Map(), tiles: new Map(), owner: new Map(), reach: new Map() }
}

let haul = emptyHaul()
/** Which post or caravan house imported the wholesale pile. Empty outside tradeMonth. */
let stockPost: Partial<Record<Good, number>> = {}

type ImportSlot = { structureId: number; owner: number; fee: number }
type FreshImport = { structureId: number; owner: number; price: number; room: number; fee: number }

/** Traders who can bring a ton in this month, and the hundredths they have left. Empty outside tradeMonth. */
let importSlots: ImportSlot[] = []
let inboundRoom = new Map<number, number>()
/** Hundredths still reserved for a good that lost the immediate delivery and is bought later. */
let importAllowance = new Map<Good, number>()
let exportedGoods = new Set<Good>()
let monthShipments: Shipment[] = []

function haulNeighbors(index: number, size: number): number[] {
  const x = index % size
  const y = (index - x) / size
  const out: number[] = []
  if (x > 0) out.push(index - 1)
  if (x + 1 < size) out.push(index + 1)
  if (y > 0) out.push(index - size)
  if (y + 1 < size) out.push(index + size)
  return out
}

/** Finished paths, and which building owns each barn. A workshop and a caravan house need a link. */
function bindHaul(structures: readonly Structure[], farms: Farms, book: RoadBook, size: number) {
  const finished = new Set(book.tiles.filter((tile) => tile.spent >= tile.hours).map((tile) => tile.index))
  const reach = new Map<number, number>()
  let mark = 1
  for (const start of finished) {
    if (reach.has(start) || size <= 0) continue
    const queue = [start]
    reach.set(start, mark)
    for (let index = 0; index < queue.length; index++) {
      for (const next of haulNeighbors(queue[index], size)) {
        if (!finished.has(next) || reach.has(next)) continue
        reach.set(next, mark)
        queue.push(next)
      }
    }
    mark += 1
  }
  const kind = new Map<number, Structure["kind"]>()
  const tiles = new Map<number, readonly number[]>()
  for (const structure of structures) {
    kind.set(structure.id, structure.kind)
    tiles.set(structure.id, structure.tiles)
  }
  const owner = new Map<number, number>()
  for (const row of farms.rows) owner.set(row.structureId, row.owner)
  haul = { size, kind, tiles, owner, reach }
}

function shareSide(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0 || b.length === 0 || haul.size <= 0) return false
  const footprint = new Set(a)
  for (const tile of b) for (const next of haulNeighbors(tile, haul.size)) if (footprint.has(next)) return true
  return false
}

function pathMarks(id: number): Set<number> {
  const marks = new Set<number>()
  if (haul.size <= 0) return marks
  for (const tile of haul.tiles.get(id) ?? []) {
    for (const next of haulNeighbors(tile, haul.size)) {
      const mark = haul.reach.get(next)
      if (mark !== undefined) marks.add(mark)
    }
  }
  return marks
}

function pairLinked(a: number, b: number): boolean {
  if (shareSide(haul.tiles.get(a) ?? [], haul.tiles.get(b) ?? [])) return true
  const left = pathMarks(a)
  for (const mark of pathMarks(b)) if (left.has(mark)) return true
  return false
}

function haulPair(a: number, b: number): boolean {
  const left = haul.kind.get(a)
  const right = haul.kind.get(b)
  if ((left === "caravan-house" && right === "workshop") || (left === "workshop" && right === "caravan-house")) return true
  const shop = left === "shop" ? right : right === "shop" ? left : undefined
  return shop === "workshop" || shop === "sawpit" || shop === "trading-post" || shop === "caravan-house"
}

function sellsRetail(id: number): boolean {
  return routes.marketIds.includes(id) || routes.shopIds.includes(id)
}

/** A sawpit is not a workshop. A shop needs a path to a workshop or a trader. Any other pair may trade. */
function haulAllowed(a: number, b: number): boolean {
  if (a < 0 || b < 0 || !haulPair(a, b)) return true
  return pairLinked(a, b)
}

function ownedOf(owner: number, kind: "workshop" | "caravan-house"): number[] {
  const ids: number[] = []
  for (const [id, held] of haul.kind) if (held === kind && haul.owner.get(id) === owner) ids.push(id)
  return ids
}

/** The buyer's caravan house must reach a workshop seller, and the buyer's workshop must reach a caravan seller. */
function buyerReaches(buyer: number, seller: number): boolean {
  const kind = haul.kind.get(seller)
  if (kind === "workshop") {
    const houses = ownedOf(buyer, "caravan-house")
    if (houses.length === 0) return true
    return houses.some((id) => pairLinked(id, seller))
  }
  if (kind === "caravan-house") {
    const shops = ownedOf(buyer, "workshop")
    if (shops.length === 0) return true
    return shops.some((id) => pairLinked(id, seller))
  }
  return true
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
  /** One walk of the population. Prices reuse it instead of scanning again. */
  census?: { portionSum: number; clothYear: number; leatherYear: number; spiceYear: number; beerYear: number; saltYear: number; protein: Partial<Record<Good, number>> }
  /** Workshops still under construction. They do not draw inputs or set a price. */
  closedShops?: ReadonlySet<number>
  /** Hundredths a construction site or office still wants. A site drawing the office pantry is not town demand. */
  buildNeeds?: readonly { good: Good; hundredths: number; structureId?: number }[]
  /** Teamsters on each caravan house that is shipping. A house left out counts as none. */
  caravanStaff?: ReadonlyMap<number, number>
}
const PRICE_FLOOR = 1

type IncomeBooks = { income: Int32Array; log: Int32Array; month: number }

/** Set for the month being settled. Cash from sales, fees, goods, and nothing else goes through credit. */
let books: IncomeBooks | null = null
/** Wood a finished construction office may sell. */
let idleWoodOffices = new Set<number>()
/** Dollars paid to the treasury for state goods, and dollars the treasury spends buying them. */
let stateTill = 0
let stateSpent = 0
/** Shelf goods a buyer could have found this month: stock on hand, or a delivery that arrived. */
let retailOffered = new Set<Good>()
/** Scored large refills this month, and bids turned away by an empty shelf that had been for sale. */
let retailRestock = new Map<Good, number>()
let retailReject = new Map<Good, number>()

let personalBooks = false

function withPersonalBooks<T>(run: () => T): T {
  personalBooks = true
  try {
    return run()
  } finally {
    personalBooks = false
  }
}

function credit(wealth: Int32Array, id: number, dollars: number) {
  if (!Number.isFinite(dollars) || dollars === 0) return
  if (id < 0) {
    if (dollars > 0) stateTill += dollars
    return
  }
  if (id >= wealth.length) return
  wealth[id] += dollars
  if (books && !(personalBooks && dollars < 0)) noteOperatingIncome(books.income, books.log, id, dollars, books.month)
}

type Quote = { price: number; export: boolean; import?: boolean }

/** What buyers in Western Europe pay per ton. Other regions use this list until they have their own. */
export const WEST_EUROPE: Record<Good, Quote | null> = {
  grain: { price: 180, export: true },
  fiber: { price: 350, export: true },
  fruit: null,
  "dried-fruit": { price: 225, export: true, import: false },
  vegetables: null,
  spices: { price: 500, export: true },
  dairy: null,
  cheese: { price: 350, export: true, import: false },
  beer: { price: 100, export: false, import: false },
  meat: null,
  livestock: { price: 300, export: false, import: false },
  hide: null,
  lime: { price: 40, export: false },
  wood: { price: 15, export: true },
  lumber: { price: 40, export: true },
  barrels: { price: 400, export: true },
  fish: null,
  "cured-fish": { price: 300, export: true },
  "cured-meat": { price: 600, export: true },
  leather: { price: 900, export: true },
  textiles: { price: 550, export: false },
  clothing: { price: 700, export: false },
  coal: { price: 90, export: true },
  salt: { price: 90, export: true },
  steel: { price: 1200, export: true },
  "steel-parts": { price: 1500, export: true },
  "steel-tools": { price: 850, export: true },
  "wagon-parts": { price: 300, export: false },
}

/** Post fee for the current trade month. Set at the start of tradeMonth. */
let standardPostFee = 1

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
  /** The post or caravan house that imported each wholesale pile. */
  stockPost?: Partial<Record<Good, number>>
  shipments: Shipment[]
  /** Calendar year the protein orders were chosen. */
  proteinYear?: number
  /** Household head to this year's protein order. The first good is the one they keep. */
  proteinPick?: Partial<Record<number, Good[]>>
  /** Town prices the yearly fee is built from. Replaced each January. */
  feePrices?: Record<Good, number>
  /** Urban tile rate locked with the fee. */
  feeTile?: number
  /** Yearly crew wage locked with the fee. */
  feeWage?: number
  /** Sum of town prices since the fee was last set. */
  priceSum?: Partial<Record<Good, number>>
  /** Months included in that sum. */
  priceMonths?: number
  /** Twelve months of scored shelf refills and empty-shelf bids, oldest first. */
  retail?: Partial<Record<Good, { restock: number; reject: number }[]>>
  /** Tons used last month. A new shop reads this when it chooses a specialty. */
  use?: Partial<Record<Good, number>>
  /** Twelve months of tons workshops and markets bought, and the dollars they paid, oldest first. Imports are included. Exports are not. A quiet month is zero. */
  bought?: Partial<Record<Good, { tons: number; dollars: number }[]>>
  /** Twelve months of tons farmsteads and workshops sold those buyers, and the dollars received, oldest first. Exports are included at the town price the seller was paid. A quiet month is zero. */
  sold?: Partial<Record<Good, { tons: number; dollars: number }[]>>
  /** Twelve months of local wholesale surplus, in months of use above the reserve, oldest first. */
  surplus?: Partial<Record<Good, number[]>>
  /** Months a workshop specialty had a finished firm, oldest first. Each figure is that month's average household profit. A year is the last twelve. */
  craftProfit?: Partial<Record<ShopSpecialty, number[]>>
  /** Months a shop specialty had a finished firm, oldest first. Each figure is that month's average household profit. A year is the last twelve. */
  retailProfit?: Partial<Record<RetailSpecialty, number[]>>
  /** Months farmers had an average household profit, oldest first. A year is the last twelve. */
  farmerProfit?: number[]
  /** Months traders had an average household profit, oldest first. A year is the last twelve. */
  traderProfit?: number[]
  /** Tons bid for import last month, including tons the wagon could not take. */
  importBids?: Partial<Record<Good, number>>
}

export function emptyTown(): TownTrade {
  const prices = {} as Record<Good, number>
  const stock = {} as Record<Good, number>
  for (const good of GOODS) {
    prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
    stock[good] = 0
  }
  return { prices, stock, stockOwner: {}, stockAsk: {}, stockPost: {}, shipments: [], feePrices: { ...prices }, feeTile: 0, feeWage: DEFAULT_WAGES.e1, priceSum: {}, priceMonths: 0 }
}

const POST_MARKUP = 1.1
const CARAVAN_MARKUP = 1.2
const POST_LAND = 4
const CARAVAN_LAND = 6

/** A post's year: 3 t of grain, a 5% chance of 0.1 t of leather and of tools, and a 15% chance of 1 t of livestock. A market ask is used when the shelf has the good. The yearly fee passes town prices ahead of the foreign list. */
export function operatingSupplies(prices: Record<Good, number>, asking: Partial<Record<Good, number>> = {}, scale = 1, townFirst = false): number {
  const quote = (good: Good) => asking[good] ?? (townFirst ? prices[good] : undefined) ?? WEST_EUROPE[good]?.price ?? prices[good] ?? PRICE_FLOOR
  const year = quote("grain") * 3 + quote("leather") * 0.005 + quote("steel-tools") * 0.005 + quote("livestock") * 0.15
  return year * scale
}

/** A caravan house's year: 5 t of grain plus 1 t for each teamster, a 10% chance of 0.1 t of leather and of tools, 0.1 t of wagon parts, a 5% chance of 1 t of barrels, and a 15% chance of 1 t of livestock. */
export function caravanSupplies(prices: Record<Good, number>, staff = 0, asking: Partial<Record<Good, number>> = {}, townFirst = false): number {
  const quote = (good: Good) => asking[good] ?? (townFirst ? prices[good] : undefined) ?? WEST_EUROPE[good]?.price ?? prices[good] ?? PRICE_FLOOR
  return quote("grain") * (5 + Math.max(0, staff)) + quote("leather") * 0.01 + quote("steel-tools") * 0.01 + quote("wagon-parts") * 0.1 + quote("barrels") * 0.05 + quote("livestock") * 0.15
}

const POST_BASE = 25
const CARAVAN_BASE = 15
const POST_OPENING_FEE = 65
const POST_OPENING_YEARS = 5
const FEE_CEILING = 200
/** Twelve months counted at two thirds, so a wagon that is not always full still covers the bill. */
const FEE_TONS = 8

/** Per ton. The yearly bill times the markup, spread over two thirds of a year of one-way capacity, plus a base, then capped. */
function pricedFee(yearly: number, capacity: number, markup: number, base: number): number {
  const tons = Math.max(1, capacity) * FEE_TONS
  const raw = Math.round((Math.max(0, yearly) * markup) / tons) + base
  return Math.min(FEE_CEILING, Math.max(base, raw))
}

/** Dollars per ton. $65 for the first five years after founding. After that, allowance, supplies, and four tiles, plus 10%, over eight tons, plus $25, and capped at $200. */
export function postFee(allowance: number, supplies: number, urbanTile: number, year = Number.POSITIVE_INFINITY, foundedYear = 0): number {
  if (year < foundedYear + POST_OPENING_YEARS) return POST_OPENING_FEE
  return pricedFee(allowance + supplies + urbanTile * POST_LAND, 1, POST_MARKUP, POST_BASE)
}

/** Dollars per ton. The caravan's own supplies, wages, and six tiles, plus 20%, over two thirds of a year of one-way tons, plus $15, and capped at $200. */
export function caravanFee(staff: number, eachWay: number, yearlyWage: number, allowance: number, supplies: number, urbanTile: number): number {
  const wages = Math.max(0, staff) * Math.max(0, yearlyWage)
  return pricedFee(allowance + supplies + wages + urbanTile * CARAVAN_LAND, eachWay, CARAVAN_MARKUP, CARAVAN_BASE)
}

export type TradingBill = { allowance: number; supplies: number; tile: number; wage: number }

/** The prices, tile rate, and wage the current yearly fee uses. */
export function tradingBill(town: TownTrade, lows: readonly number[], urbanTile: number, wage: number): TradingBill {
  const prices = town.feePrices ?? town.prices
  const tile = town.feeTile ?? urbanTile
  const lockedWage = town.feeWage ?? wage
  return {
    allowance: familyAllowance(prices, lows, tile),
    supplies: operatingSupplies(prices, {}, 1, true),
    tile,
    wage: lockedWage,
  }
}

function averagedFeePrices(town: TownTrade): Record<Good, number> {
  const months = town.priceMonths ?? 0
  const sum = town.priceSum
  const prices = {} as Record<Good, number>
  for (const good of GOODS) {
    if (months > 0 && sum?.[good] != null) prices[good] = (sum[good] as number) / months
    else prices[good] = town.feePrices?.[good] ?? town.prices[good] ?? WEST_EUROPE[good]?.price ?? PRICE_FLOOR
  }
  return prices
}

/** Each January, lock the fee to the average town price since the last lock. The foreign list fills a good that has no town price. */
export function rollTradingFee(town: TownTrade, month: number, urbanTile: number, wage: number): TownTrade {
  if (town.feePrices && month !== 0) return town
  return { ...town, feePrices: averagedFeePrices(town), feeTile: urbanTile, feeWage: wage, priceSum: {}, priceMonths: 0 }
}

/** Add this month's town prices to the average used next January. */
export function rememberFeePrices(town: TownTrade): TownTrade {
  const sum: Partial<Record<Good, number>> = { ...(town.priceSum ?? {}) }
  for (const good of GOODS) sum[good] = (sum[good] ?? 0) + (town.prices[good] ?? WEST_EUROPE[good]?.price ?? PRICE_FLOOR)
  return { ...town, priceSum: sum, priceMonths: (town.priceMonths ?? 0) + 1 }
}

export type ShipHouse = { structureId: number; out: number; in: number; fee: number; staff: number }

/** Fees for caravan houses shipping this month. Empty outside tradeMonth. */
let houseFees = new Map<number, number>()

function feeFor(row: Holding): number {
  return houseFees.get(row.structureId) ?? standardPostFee
}

function openInbound(posts: readonly Holding[], shipping: ReadonlyMap<number, ShipHouse>, exported: Set<Good>, shipments: Shipment[]) {
  importSlots = posts.map((post) => ({ structureId: post.structureId, owner: post.owner, fee: feeFor(post) }))
  inboundRoom = new Map(posts.map((post) => [post.structureId, (shipping.get(post.structureId)?.in ?? 1) * TON]))
  exportedGoods = exported
  monthShipments = shipments
  monthImportBids = new Map()
}

/** Tons offered to the inbound wagon this month, including tons that did not fit. */
let monthImportBids = new Map<Good, number>()

function closeInbound() {
  importSlots = []
  inboundRoom = new Map()
  importAllowance = new Map()
  exportedGoods = new Set()
  monthShipments = []
  monthImportBids = new Map()
}

function noteImportBid(good: Good, tons: number) {
  if (tons <= 0) return
  monthImportBids.set(good, (monthImportBids.get(good) ?? 0) + tons)
}

function importBidRecord(): Partial<Record<Good, number>> {
  const bids: Partial<Record<Good, number>> = {}
  for (const [good, tons] of monthImportBids) if (tons > 0) bids[good] = tons
  return bids
}

/** A trading post is open to every buyer. A caravan house uses the workshop link. */
function traderOpen(buyer: number, structureId: number): boolean {
  if (routes.kindOf.get(structureId) === "caravan-house") return buyerReaches(buyer, structureId)
  return true
}

/** Town rate on an import, and the spread the trader keeps. Null when the town price does not clear the foreign price by $20. */
function importAsk(good: Good, prices: Record<Good, number>): { price: number; fee: number } | null {
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false) return null
  const price = prices[good] ?? 0
  if (price < foreign.price + MIN_SPREAD) return null
  return { price, fee: price - foreign.price }
}

function freshImports(good: Good, buyer: number, prices: Record<Good, number>, roomOf?: (structureId: number) => number): FreshImport[] {
  if (exportedGoods.has(good)) return []
  const ask = importAsk(good, prices)
  if (!ask) return []
  const reserved = importAllowance.get(good) ?? 0
  if (reserved < WHOLESALE_MIN) return []
  const offers: FreshImport[] = []
  const roomAt = roomOf ?? ((id: number) => inboundRoom.get(id) ?? 0)
  for (const slot of importSlots) {
    const room = Math.min(wholeLots(roomAt(slot.structureId), WHOLESALE_MIN), wholeLots(reserved, WHOLESALE_MIN))
    if (room < WHOLESALE_MIN || !traderOpen(buyer, slot.structureId)) continue
    offers.push({ structureId: slot.structureId, owner: slot.owner, price: ask.price, room, fee: ask.fee })
  }
  offers.sort((a, b) => a.price - b.price || a.structureId - b.structureId)
  return offers
}

/** What this buyer actually parts with. A trader's own fee stays home. */
function netImport(offer: FreshImport, buyer: number): number {
  return buyer === offer.owner ? offer.price - offer.fee : offer.price
}

/** The buyer pays the town rate. The trader keeps the spread and the foreign price leaves in the same step. */
function payImport(wealth: Int32Array, buyer: number, offer: FreshImport, good: Good, qty: number): number {
  const foreignPaid = Math.round(((offer.price - offer.fee) * qty) / TON)
  let spent = 0
  if (buyer === offer.owner) {
    if (buyer < 0) stateSpent += foreignPaid
    else credit(wealth, buyer, -foreignPaid)
    spent = foreignPaid
  } else {
    spent = payFor(wealth, buyer, offer.owner, offer.price, qty)
    credit(wealth, offer.owner, -foreignPaid)
  }
  inboundRoom.set(offer.structureId, (inboundRoom.get(offer.structureId) ?? 0) - qty)
  if (importAllowance.has(good)) importAllowance.set(good, Math.max(0, (importAllowance.get(good) ?? 0) - qty))
  const tons = Math.max(1, Math.round(qty / TON))
  const billed = buyer === offer.owner ? offer.price - offer.fee : offer.price
  for (let n = 0; n < tons; n++) monthShipments.push({ postId: offer.structureId, good, way: "import", dollars: billed })
  return spent
}

type Draw = {
  price: number
  room: number
  min: number
  rank: number
  id: number
  /** A short need still takes one whole lot. */
  roundUp?: boolean
  /** A whole ton bought by a workshop or a market. Domestic producer sales count on both ledgers. Imports count only as bought. */
  book?: "both" | "bought"
  pull: (qty: number) => number
}

/** A workshop runs and sells at this multiple of the Wholesale Bought input cost. */
const WORKSHOP_MARGIN = 1.2
/** An export needs at least this gap. An import costs the foreign price plus this amount. */
const MIN_SPREAD = 20
/** Logit temperature, as a fraction of the foreign price. A tenth of that price is a real edge. */
const LOGIT_TAU = 0.1

/** Wholesale Bought and Wholesale Sold for the current month. Retail tenths and shelf resales stay out. */
let boughtTons = new Map<Good, number>()
let boughtDollars = new Map<Good, number>()
let soldTons = new Map<Good, number>()
let soldDollars = new Map<Good, number>()

/** Posted fallback, replaced by the trailing Wholesale Bought price when a ton has been recorded. Set for the month. */
let batchQuote: Record<Good, number> | null = null
/** Trailing Wholesale Sold tons of beer per month. Zero when no month is on the books. */
let beerSoldRate = 0
let batchClosed: ReadonlySet<number> = new Set()
/** Dollars per ton each workshop posted. Empty outside the trade month. */
let firmAsks = new Map<number, Partial<Record<Good, number>>>()
/** Household score of each resident, for the month's walk-away checks. Empty outside the trade month. */
let walkScores = new Map<number, number>()

function clearWholesale() {
  boughtTons = new Map()
  boughtDollars = new Map()
  soldTons = new Map()
  soldDollars = new Map()
}

function noteLedger(good: Good, qty: number, spent: number, side: "both" | "bought" | "sold", short = false) {
  if (qty <= 0 || (!short && qty < WHOLESALE_MIN)) return
  const dollars = Math.max(0, spent)
  if (side !== "sold") {
    boughtTons.set(good, (boughtTons.get(good) ?? 0) + qty)
    boughtDollars.set(good, (boughtDollars.get(good) ?? 0) + dollars)
  }
  if (side !== "bought") {
    soldTons.set(good, (soldTons.get(good) ?? 0) + qty)
    soldDollars.set(good, (soldDollars.get(good) ?? 0) + dollars)
  }
}

/** Cheapest source first. An equal price takes the local ton. An import, or a lot marked to round up, covers a short need with one whole lot. */
function drawSources(wealth: Int32Array, buyer: number, draws: readonly Draw[], left: number, exact: boolean, roundImport: boolean, good: Good): { taken: number; spent: number } {
  const ordered = [...draws].sort((a, b) => a.price - b.price || a.rank - b.rank || a.id - b.id)
  let taken = 0
  let spent = 0
  let need = left
  for (const draw of ordered) {
    const rounding = need > 0 && (draw.roundUp === true || (draw.rank === 2 && roundImport))
    if (!rounding && need < draw.min) continue
    const asked = rounding ? coverLots(need, draw.min) : need
    const qty = buyLot(wealth, buyer, draw.price, draw.room, asked, draw.min, rounding || draw.rank === 2 ? true : exact)
    if (qty < draw.min) continue
    const paid = draw.pull(qty)
    if (draw.book) noteLedger(good, qty, paid, draw.book)
    spent += paid
    taken += qty
    need -= qty
    if (need <= 0) break
  }
  return { taken, spent }
}

/** Dollars to fill a recipe shortfall from these sources, in the same lots a purchase would take. */
function sourceFill(passes: readonly (readonly Draw[])[], need: number): number {
  let left = need
  let bill = 0
  for (const pass of passes) {
    if (left <= 0) break
    const ordered = [...pass].sort((a, b) => a.price - b.price || a.rank - b.rank || a.id - b.id)
    for (const draw of ordered) {
      const rounding = left > 0 && (draw.roundUp === true || draw.rank === 2)
      if (!rounding && left < draw.min) continue
      const asked = rounding ? coverLots(left, draw.min) : left
      const exact = rounding || draw.rank === 2
      const capped = exact ? wholeLots(asked, draw.min) : coverLots(asked, draw.min)
      const qty = Math.min(wholeLots(draw.room, draw.min), capped)
      if (qty < draw.min) continue
      bill += Math.round((draw.price * qty) / TON)
      left -= qty
      if (left <= 0) break
    }
  }
  return bill
}

/** Ton-weighted margin on this building's latest shipments. Exports keep the foreign price minus the price paid. Imports keep the buyer's price minus the foreign price. */
function averageSpread(shipped: readonly Shipment[], way: "export" | "import"): string {
  let total = 0
  let tons = 0
  for (const item of shipped) {
    if (item.way !== way) continue
    const foreign = WEST_EUROPE[item.good]?.price
    if (foreign === undefined) continue
    total += way === "export" ? foreign - item.dollars : item.dollars - foreign
    tons += 1
  }
  if (tons === 0) return "—"
  return `${dollars(Math.round(total / tons))} per ton`
}

export function tradeLines(structure: Structure, holdings: Holdings, town: TownTrade, quotedFee?: number, _allowance = 0, _supplies = 0, _urbanTile = 0, _year = Number.POSITIVE_INFINITY, _foundedYear = 0): PropertyLine[] {
  const trading = structure.kind === "trading-post" || (structure.kind === "caravan-house" && quotedFee !== undefined)
  if (!trading || structure.pending) return []
  const row = holdings.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) return []
  const bids = GOODS.filter((good) => {
    const foreign = WEST_EUROPE[good]
    return foreign?.export && foreign.price - (town.prices[good] ?? 0) >= MIN_SPREAD
  })
    .map((good) => `${GOOD_LABEL[good]} ${dollars(town.prices[good] ?? 0)}`)
    .join(", ")
  const asks = GOODS.filter((good) => WEST_EUROPE[good] && WEST_EUROPE[good].import !== false)
    .map((good) => `${GOOD_LABEL[good]} ${dollars((WEST_EUROPE[good] as Quote).price + MIN_SPREAD)}`)
    .join(", ")
  const shipped = town.shipments.filter((item) => item.postId === structure.id)
  const lines: PropertyLine[] = [
    { label: "Imports", value: averageSpread(shipped, "import") },
    { label: "Exports", value: averageSpread(shipped, "export") },
    { label: "Bids", value: bids },
    { label: "Asks", value: asks },
  ]
  if (shipped.length > 0) {
    lines.push({
      label: "Shipped",
      value: shippedText(shipped),
    })
  }
  return lines
}

export function marketLines(structure: Structure, farms: Farms): PropertyLine[] {
  if ((structure.kind !== "market" && structure.kind !== "shop") || structure.pending) return []
  const row = farms.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) return []
  const lines: PropertyLine[] = []
  if (structure.kind === "shop") lines.push({ label: "Specialty", value: row.retail ? RETAIL_NAME[row.retail] : "Unsettled" })
  lines.push({ label: "Sells", value: "$1 plus 20% a tenth" })
  for (const good of GOODS) {
    const unit = row.cost?.[good]
    if (!unit || (row.store[good] ?? 0) <= 0) continue
    lines.push({ label: `${GOOD_LABEL[good]} price`, value: `${dollars(sellPrice(unit))} per ton` })
  }
  return lines
}

function shippedText(shipped: readonly Shipment[]): string {
  const totals = new Map<string, number>()
  for (const item of shipped) {
    const key = `${item.way}:${item.good}`
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }
  return [...totals.entries()]
    .map(([key, tons]) => {
      const split = key.indexOf(":")
      const way = key.slice(0, split)
      const good = key.slice(split + 1) as Good
      return `${way === "export" ? "Out" : "In"} ${tons} t ${GOOD_LABEL[good].toLowerCase()}`
    })
    .join(", ")
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
  shipHouses: readonly ShipHouse[] = [],
  closedShops: ReadonlySet<number> = new Set(),
  buildNeeds: readonly { good: Good; hundredths: number }[] = [],
  foundedYear = year,
  month = 0,
): { label: string; value: string; note?: string; sub?: string }[] {
  const stock = totalStock(farms, town)
  const ownedIds = new Set(holdings.rows.filter((row) => row.owner >= 0).map((row) => row.structureId))
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : Array.from({ length: 12 }, () => low)
  const houseFeesNow = new Map(shipHouses.map((house) => [house.structureId, house.fee]))
  const bill = tradingBill(town, yearLows, urbanTile, town.feeWage ?? 0)
  const fee = cheapFee(holdings, structures, houseFeesNow, bill.allowance, bill.supplies, bill.tile, year, foundedYear) ?? 0
  const plan = people
    ? planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town, urbanTile)
    : null
  const targets = people ? stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices, plan ?? undefined, closedShops) : new Map()
  if (people && plan) installCloset(people, plan.headOf, plan.rank)
  bindRoutes(structures, ownedIds)
  const marketIds = retailShelves(structures, owned)
  const postCount = tradeSlots(structures, owned, shipHouses)
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
      closedShops,
      buildNeeds,
      caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
    })
  setBatchQuote(town, town.prices, closedShops)
  const quote = quotedPrices(forSaleStock(farms, town.stock, targets), town.prices, fee, postCount, measure, month)
  if (people && plan) {
    quote.beer = beerClearing(people, plan.headOf, farms, closedShops, boughtQuotes(town, town.prices), town.stock)
    const priorRelease = {} as Record<Good, number>
    const openingPool = marketStructures(structures, owned).length === 0
    for (const good of GOODS) priorRelease[good] = exportable(farms, town.stock, targets, good, openingPool) / TON
    applyProfitQuotes(quote, {
      people,
      headOf: plan.headOf,
      rank: plan.rank,
      farms,
      closedShops,
      stock: town.stock,
      targets,
      priorPrices: town.prices,
      priorRelease,
      outSlots: postCount,
      inSlots: tradeInbound(structures, owned, shipHouses),
      includePool: openingPool,
      use: measure(quote),
      structures,
      terrain,
      feature,
      month,
      importBids: town.importBids ?? {},
      caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
    })
  }
  const selling = marketSale(farms, marketIds)
  const use = measure(quote)
  const rows = GOODS.map((good) => {
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
  clearCloset()
  return rows
}

/** Food, working-class clothing and leather, a year of fuel, and two urban tiles. A good on a shop or market shelf uses the average of those prices. */
function livingParts(
  prices: Record<Good, number>,
  lows: readonly number[],
  urbanTile: number,
  asking: Partial<Record<Good, number>>,
): { board: number; fuel: number; tiles: number } {
  const price = (good: Good) => asking[good] ?? prices[good] ?? PRICE_FLOOR
  const board =
    price("grain") * 0.1 +
    ((price("fruit") + price("vegetables")) / 2) * 0.3 +
    price("meat") * 0.1 * 0.1 +
    price("fish") * 0.1 * 0.45 +
    price("dairy") * 0.4 * 0.45 +
    price("clothing") * 0.004 +
    price("leather") * 0.002
  const woodYear = yearOfWood(lows)
  const wood = price("wood")
  const coal = price("coal")
  const fuel = wood * 4 <= coal ? woodYear * wood : (woodYear / 4) * coal
  return { board, fuel, tiles: urbanTile * 2 }
}

/**
 * One household's year, and the smaller share for each extra person.
 * Food, working-class clothing and leather, a full year of fuel, and two
 * urban tiles. The extra share is food, clothing, and leather at three quarters.
 */
export function livingCosts(
  prices: Record<Good, number>,
  lows: readonly number[],
  urbanTile = 0,
  asking: Partial<Record<Good, number>> = {},
): { full: number; member: number } {
  const { board, fuel, tiles } = livingParts(prices, lows, urbanTile, asking)
  return { full: Math.round(board + fuel + tiles), member: Math.round(board * 0.75) }
}

/** One year of the cost of living, plus six years of that cost without fuel and without the two urban tiles. */
export function familyAllowance(
  prices: Record<Good, number>,
  lows: readonly number[],
  urbanTile = 0,
  asking: Partial<Record<Good, number>> = {},
): number {
  const { board, fuel, tiles } = livingParts(prices, lows, urbanTile, asking)
  return Math.round(board + fuel + tiles + board * 6)
}

/** The full household cost: food, working-class clothing and leather, fuel, and two urban tiles. */
export function costOfLiving(
  prices: Record<Good, number>,
  lows: readonly number[],
  urbanTile = 0,
  asking: Partial<Record<Good, number>> = {},
): number {
  return livingCosts(prices, lows, urbanTile, asking).full
}

/** Dollars a dowry leaves in the purse: this year's food and fuel, and the clothing and leather pantry. */
export function householdSupplyBill(
  people: People,
  payer: number,
  structures: readonly Structure[],
  holdings: Holdings,
  farms: Farms,
  prices: Record<Good, number>,
  lows: readonly number[],
  adultCost: number,
  memberCost: number,
): number {
  const homes = householdHomes(structures, holdings.rows)
  const { rank, headOf } = householdRanks(people, adultCost, memberCost, homes)
  const head = homeHead(headOf, payer)
  const family = familyPortions(people, head)
  const price = (good: Good) => prices[good] ?? PRICE_FLOOR
  const board =
    price("grain") * 0.1 +
    ((price("fruit") + price("vegetables")) / 2) * 0.3 +
    price("meat") * 0.01 +
    price("fish") * 0.045 +
    price("dairy") * 0.18
  let fires = 0
  for (const structure of structures) {
    const row = holdings.rows.find((item) => item.structureId === structure.id)
    if (!row || row.owner < 0 || homeHead(headOf, row.owner) !== head) continue
    if (heatsHouse(structure, farms)) fires += 1
  }
  const woodYear = yearOfWood(lows)
  const asking = marketSale(farms, fuelMarkets(structures, new Set(holdings.rows.filter((row) => row.owner >= 0).map((row) => row.structureId))))
  const burnsWood = preferWood(prices, asking)
  const fuelGood: Good = burnsWood ? "wood" : "coal"
  const fuelTons = fires * (burnsWood ? woodYear : woodYear / 4)
  const fuel = fuelTons * (asking[fuelGood] ?? price(fuelGood))
  const floor = closetFloor(rank.get(head) ?? "poor") / TON
  return Math.round(board * family.scale + fuel + floor * (price("clothing") + price("leather")))
}

/**
 * Each post ships one ton of whatever high-score good it rolls, so the same good can
 * leave more than once. A good that left is not imported in the same month. An import
 * is a buyer's bid through a trader that still has inbound room, not a ton bought ahead.
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
  shipHouses: readonly ShipHouse[] = [],
  familyNeeds: readonly { structureId: number; buyer: number; good: Good; hundredths: number }[] = [],
  closedShops: ReadonlySet<number> = new Set(),
  staffedOffices: ReadonlySet<number> = new Set(),
  roadBook: RoadBook = emptyRoads(),
  foundedYear = year,
  retailRanks: readonly RetailSpecialty[] = [],
): { people: People; farms: Farms; town: TownTrade; toTreasury: number; resourceSpent: number; resourceReceived: number; bought: { structureId: number; good: Good; taken: number }[] } {
  const wealth = new Int32Array(people.wealth)
  const starving = new Uint8Array(people.age.length)
  const starveDue = new Uint16Array(people.age.length)
  const starveRoll = new Uint8Array(people.age.length)
  if (people.starving) starving.set(people.starving.subarray(0, Math.min(people.age.length, people.starving.length)))
  if (people.starveDue) starveDue.set(people.starveDue.subarray(0, Math.min(people.age.length, people.starveDue.length)))
  if (people.starveRoll) starveRoll.set(people.starveRoll.subarray(0, Math.min(people.age.length, people.starveRoll.length)))
  const income = new Int32Array(people.income ?? people.age.length)
  const incomeLog = copyIncomeLog(people, people.age.length)
  books = { income, log: incomeLog, month }
  clearWholesale()
  setBatchQuote(town, town.prices, closedShops)
  retailOffered = new Set()
  retailRestock = new Map()
  retailReject = new Map()
  idleWoodOffices = new Set(idleWood)
  houseFees = new Map(shipHouses.map((house) => [house.structureId, house.fee]))
  stateTill = 0
  stateSpent = 0
  const rows = farms.rows.map((row) => ({
    ...row,
    store: { ...emptyGoods(), ...row.store },
    trade: row.trade ? { ...row.trade } : undefined,
    cost: row.cost ? { ...row.cost } : undefined,
    ask: row.ask ? { ...row.ask } : undefined,
    shelfEpisode: copyShelfEpisode(row.shelfEpisode),
    shelfReady: row.shelfReady ? { ...row.shelfReady } : undefined,
    surplus: row.surplus ? { ...row.surplus } : undefined,
  }))
  for (const row of rows) for (const good of GOODS) if (!Number.isFinite(row.store[good])) row.store[good] = 0
  const nextFarms: Farms = { rows }
  const stock = { ...town.stock }
  const stockOwner = { ...town.stockOwner }
  const stockAsk = { ...(town.stockAsk ?? {}) }
  stockPost = { ...(town.stockPost ?? {}) }
  for (const good of GOODS) if (stock[good] == null) stock[good] = 0
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const yearLows = lows.length > 0 ? lows : [low]
  const bill = tradingBill(town, yearLows, urbanTile, town.feeWage ?? 0)
  standardPostFee = postFee(bill.allowance, bill.supplies, bill.tile, year, foundedYear)
  const protein = planProtein(people, structures, owned, nextFarms, town.prices, yearLows, terrain, feature, seed, year, month, town, urbanTile)
  bindProteinSales(protein.sources, protein.farmsteads)
  const shipping = new Map(shipHouses.map((house) => [house.structureId, house]))
  const posts = structures
    .filter((structure) => {
      if (structure.pending || structure.removing || !owned.has(structure.id)) return false
      if (structure.kind === "trading-post") return true
      return structure.kind === "caravan-house" && shipping.has(structure.id)
    })
    .map((structure) => owned.get(structure.id) as Holding)
    .sort((a, b) => feeFor(a) - feeFor(b) || a.structureId - b.structureId)
  const slots = tradeSlots(structures, owned, shipHouses)

  const shipments: Shipment[] = []
  const exported = new Set<Good>()
  openInbound(posts, shipping, exported, shipments)
  const ownedIds = new Set(owned.keys())
  const targets = stockTargets(people, structures, owned, yearLows, terrain, feature, nextFarms, town.prices, protein, closedShops)
  const priorRelease = {} as Record<Good, number>
  const openingPool = marketStructures(structures, owned).length === 0
  for (const good of GOODS) priorRelease[good] = exportable(nextFarms, stock, targets, good, openingPool) / TON
  installCloset(people, protein.headOf, protein.rank)
  const census = buildCensus(people, protein.headOf, protein.rank, protein.orders)
  rememberWalkScores(people, protein.headOf)
  const farmHeads = new Set<number>()
  for (const structure of structures) {
    if (structure.pending || structure.removing || structure.kind !== "farmstead") continue
    const row = owned.get(structure.id)
    if (!row || row.owner < 0) continue
    farmHeads.add(homeHead(protein.headOf, row.owner))
  }
  const burnsWood = preferWood(town.prices, marketSale(nextFarms, fuelMarkets(structures, owned)))
  const woodYear = yearOfWood(yearLows)
  const woodKeep = new Map<number, number>()
  if (burnsWood) {
    const fires = new Map<number, number>()
    for (const structure of structures) {
      const row = owned.get(structure.id)
      if (!row || !heatsHouse(structure, nextFarms)) continue
      fires.set(row.owner, (fires.get(row.owner) ?? 0) + 1)
    }
    for (const [owner, count] of fires) woodKeep.set(owner, Math.round(count * woodYear * TON))
  }
  dryFruit(nextFarms, structures, owned, targets, high, precip)
  const coalOwners = makeCoal(nextFarms, structures, owned, feature, month, woodKeep, town.prices)
  makeSpices(nextFarms, structures, owned, month)
  const coalMakers = new Set<number>()
  for (const owner of coalOwners) coalMakers.add(homeHead(protein.headOf, owner))
  const marketIds = marketStructures(structures, owned)
  bindRoutes(structures, ownedIds)
  bindFirmAsks(nextFarms)
  bindHaul(structures, nextFarms, roadBook, Math.round(Math.sqrt(terrain.length)))
  for (const row of nextFarms.rows) foldBin(row)
  const fed = feedHouseholds(people, structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, terrain, feature, seed, year, month, protein.orders, census, burnsWood, woodYear, coalMakers, starving, starveDue, farmHeads, foundedYear)
  const tradeContext = (): UseContext => ({
    farms: nextFarms,
    prices: town.prices,
    fee: posts.length > 0 ? feeFor(posts[0]) : 0,
    stock,
    stockOwner,
    stockAsk,
    targets,
    wealth,
    proteinOrders: protein.orders,
    headOf: protein.headOf,
    rank: protein.rank,
    census,
    closedShops,
    buildNeeds: [...stateNeeds, ...familyNeeds],
    caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
  })
  const use = monthlyUse(structures, people, low, ownedIds, terrain, feature, tradeContext())
  loadImportWagons(nextFarms, wealth, town.prices, targets, posts, shipping, [...stateNeeds, ...familyNeeds], seed, year, month, stock, stockOwner, stockAsk)
  assignShopSpecialties(nextFarms, structures, retailRanks, town.prices, wealth, seed, month, year, closedShops)
  fillShelves(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, month)
  const foodNeeds = fed.needs.filter((need) => need.food)
  const shopNeeds = fed.needs.filter((need) => !need.food)
  const funders = new Map<number, number[]>()
  if (year >= foundedYear + 5) {
    for (const [head, members] of census.members) {
      if (starving[head] !== 1 || farmHeads.has(head)) continue
      funders.set(head, [head, ...members.filter((id) => id !== head).sort((a, b) => a - b)])
    }
  }
  const short = withPersonalBooks(() => settleHouseholdNeeds(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, foodNeeds, funders))
  if (year >= foundedYear + 5) markHunger(fed.attempted, short, farmHeads, census, starving, starveDue, starveRoll, year, month)
  const hungry = new Set<number>()
  for (let id = 0; id < starving.length; id++) if (starving[id] === 1 && homeHead(protein.headOf, id) === id) hungry.add(id)
  withPersonalBooks(() => settleHouseholdNeeds(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, shopNeeds.filter((need) => farmHeads.has(need.head) || !hungry.has(need.head))))
  withPersonalBooks(() => buyBirthdayBeer(people, nextFarms, wealth, town.prices, census, month, year, seed, closedShops))
  const living = livingCosts(town.prices, yearLows, urbanTile, marketSale(nextFarms, retailShelves(structures, owned)))
  grantBirthdaySeeds(wealth, { ...people, starving }, holdings.rows, month, living.full, living.member)
  if (month === 10) {
    for (const post of posts) {
      const staff = shipping.get(post.structureId)?.staff
      feedPostGrain(post, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, feeFor(post), staff == null ? 3 : 5 + staff)
    }
  }
  if (month === 0) {
    for (const post of posts) {
      const house = shipping.get(post.structureId)
      feedPost(post, nextFarms, stock, stockOwner, town.prices, year, seed, house ? 0.1 : 0.05, house != null)
    }
    feedFarms(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, terrain, feature, year, seed)
    feedShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, seed, closedShops)
  }
  for (const post of posts) {
    if (!shipping.has(post.structureId)) continue
    feedCaravanBarrels(post, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, feeFor(post), year, month, seed)
  }
  feedBrewerBarrels(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, year, month, seed, closedShops)
  feedTraderLivestock(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, { ...town.prices, livestock: livestockPrice(town.prices) }, targets, marketIds, posts, year, month, seed)
  const prices = { ...town.prices }
  for (const good of GOODS) if (prices[good] == null) prices[good] = WEST_EUROPE[good]?.price ?? PRICE_FLOOR
  const feeNow = posts.length > 0 ? feeFor(posts[0]) : 0
  const measure = (marks?: Record<Good, number>) =>
    monthlyUse(structures, people, low, ownedIds, terrain, feature, { ...tradeContext(), marks })
  const shopMarks = quotedPrices(forSaleStock(nextFarms, stock, targets), prices, feeNow, slots, measure, month)
  shopMarks.beer = beerClearing(people, census.headOf, nextFarms, closedShops, batchQuote ?? prices, stock)
  applyProfitQuotes(shopMarks, {
    people,
    headOf: census.headOf,
    rank: protein.rank,
    farms: nextFarms,
    closedShops,
    stock,
    targets,
    priorPrices: town.prices,
    priorRelease,
    outSlots: slots,
    inSlots: tradeInbound(structures, owned, shipHouses),
    includePool: marketIds.length === 0,
    use,
    structures,
    terrain,
    feature,
    month,
    importBids: importBidRecord(),
    caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
  })
  runShops(structures, owned, nextFarms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, posts, month, shopMarks, closedShops)
  restock(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, marketIds, posts, protein.orders, protein.headOf)
  const openNeeds = familyNeeds.map((need) => ({ ...need }))
  const bought: { structureId: number; good: Good; taken: number }[] = []
  const buySites = () => {
    for (const need of openNeeds) {
      if (need.hundredths <= 0 || need.buyer < 0) continue
      const fill = buyBuild(nextFarms, stock, stockOwner, stockAsk, wealth, need.buyer, need.good, need.hundredths, prices, targets, feeNow, false, need.structureId)
      if (fill.taken <= 0) continue
      need.hundredths = Math.max(0, need.hundredths - fill.taken)
      bought.push({ structureId: need.structureId, good: need.good, taken: fill.taken })
    }
  }
  buySites()
  for (const need of stateNeeds) {
    if (need.hundredths <= 0) continue
    const row = nextFarms.rows.find((item) => item.structureId === need.structureId)
    if (!row) continue
    takeState(nextFarms, stock, stockOwner, stockAsk, wealth, row, need.good, need.hundredths, prices, targets, feeNow)
  }
  for (const need of pantryOrders(nextFarms, structures, staffedOffices)) {
    const row = nextFarms.rows.find((item) => item.structureId === need.structureId)
    if (!row) continue
    takeState(nextFarms, stock, stockOwner, stockAsk, wealth, row, need.good, need.hundredths, prices, targets, feeNow)
  }
  buySites()
  for (const good of GOODS) {
    if ((stock[good] ?? 0) > 0) continue
    stock[good] = 0
    delete stockOwner[good]
    delete stockAsk[good]
    delete stockPost[good]
  }

  const imported = new Set(shipments.filter((item) => item.way === "import").map((item) => item.good))
  for (const post of posts) {
    const cap = shipping.get(post.structureId)?.out ?? 1
    const rng = mulberry32(hashSeed(`${seed}:export:${post.structureId}:${year}:${month}`))
    const includePool = marketIds.length === 0
    const missedTown = new Set<Good>()
    const missedShop = new Set<string>()
    let movedTons = 0
    while (movedTons < cap) {
      const offers = exportOffers(nextFarms, stock, targets, includePool, use, month, prices, post.structureId, imported, missedTown, missedShop)
      if (offers.length === 0) break
      const offer = logitOffers(offers, rng)
      const foreign = (WEST_EUROPE[offer.good] as Quote).price
      const spread = foreign - offer.price
      const sellers = exportSellers(nextFarms, targets, offer.good, post.structureId)
      const open = offer.workshopId === null ? sellers.filter((row) => !routes.workshopIds.has(row.structureId)) : sellers.filter((row) => row.structureId === offer.workshopId)
      const row = open.length === 0 ? undefined : open[Math.min(open.length - 1, Math.floor(rng() * open.length))]
      if (!row) {
        if (offer.workshopId === null) missedTown.add(offer.good)
        else missedShop.add(`${offer.workshopId}:${offer.good}`)
        continue
      }
      const before = movedTons
      while (spread >= MIN_SPREAD && movedTons < cap && exportRank(exportable(nextFarms, stock, targets, offer.good, includePool), use[offer.good] ?? 0, offer.good, month) !== null) {
        if (spareAt(nextFarms, row, offer.good, targets, new Map()) < TON) break
        row.store[offer.good] = (row.store[offer.good] ?? 0) - TON
        credit(wealth, row.owner, offer.price)
        credit(wealth, post.owner, spread)
        noteLedger(offer.good, TON, offer.price, "sold")
        exported.add(offer.good)
        shipments.push({ postId: post.structureId, good: offer.good, way: "export", dollars: offer.price })
        movedTons += 1
      }
      if (movedTons === before) {
        if (offer.workshopId === null) missedTown.add(offer.good)
        else missedShop.add(`${offer.workshopId}:${offer.good}`)
      }
    }
  }

  const dealt = rollWorkshopYear(town.bought, town.sold, town.surplus, use, nextFarms, targets, month)
  clearWholesale()
  const desired = quotedPrices(forSaleStock(nextFarms, stock, targets), prices, feeNow, slots, measure, month)
  desired.beer = beerClearing(people, census.headOf, nextFarms, closedShops, batchQuote ?? prices, stock)
  const firmContext: ProfitQuote = {
    people,
    headOf: census.headOf,
    rank: protein.rank,
    farms: nextFarms,
    closedShops,
    stock,
    targets,
    priorPrices: town.prices,
    priorRelease,
    outSlots: slots,
    inSlots: tradeInbound(structures, owned, shipHouses),
    includePool: marketIds.length === 0,
    use,
    structures,
    terrain,
    feature,
    month,
    importBids: importBidRecord(),
    caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
  }
  applyProfitQuotes(desired, firmContext)
  quoteFirmPrices(firmContext, month, year)
  for (const good of GOODS) prices[good] = glidePrice(prices[good], desired[good])
  prices.livestock = livestockPrice(prices)

  const resourceSpent = stateSpent
  const resourceReceived = stateTill
  const toTreasury = resourceReceived - resourceSpent
  books = null
  idleWoodOffices = new Set()
  houseFees = new Map()
  standardPostFee = 1
  stateTill = 0
  stateSpent = 0
  sellProtein = () => true
  clearCloset()
  clearWalkScores()
  clearFirmAsks()
  const bidRecord = importBidRecord()
  closeInbound()
  const posted = stockPost
  stockPost = {}
  haul = emptyHaul()
  const nextTown = rememberFeePrices({
    prices,
    stock,
    stockOwner,
    stockAsk,
    stockPost: posted,
    shipments,
    proteinYear: year,
    proteinPick: storeProteinPick(protein.orders, people, protein.headOf),
    feePrices: town.feePrices,
    feeTile: town.feeTile,
    feeWage: town.feeWage,
    priceSum: town.priceSum,
    priceMonths: town.priceMonths,
    retail: rollRetail(town.retail),
    use,
    bought: dealt.bought,
    sold: dealt.sold,
    surplus: dealt.surplus,
    ...rollSectorProfit(town, { ...people, income }, structures, holdings, nextFarms),
    importBids: bidRecord,
  })
  return {
    people: { ...people, wealth, income, incomeLog, starving, starveDue, starveRoll },
    farms: nextFarms,
    town: nextTown,
    toTreasury,
    resourceSpent,
    resourceReceived,
    bought,
  }
}

function tradeInbound(structures: readonly Structure[], owned: Map<number, Holding>, houses: readonly ShipHouse[]): number {
  const extra = new Map(houses.map((house) => [house.structureId, house.in]))
  let slots = 0
  for (const structure of structures) {
    if (structure.pending || structure.removing || !owned.has(structure.id)) continue
    if (structure.kind === "trading-post") slots += 1
    else if (structure.kind === "caravan-house") slots += extra.get(structure.id) ?? 0
  }
  return slots
}

function tradeSlots(structures: readonly Structure[], owned: Map<number, Holding>, houses: readonly ShipHouse[]): number {
  const extra = new Map(houses.map((house) => [house.structureId, house.out]))
  let slots = 0
  for (const structure of structures) {
    if (structure.pending || structure.removing || !owned.has(structure.id)) continue
    if (structure.kind === "trading-post") slots += 1
    else if (structure.kind === "caravan-house") slots += extra.get(structure.id) ?? 0
  }
  return slots
}

/** A tenth of the gap, rounded to the dollar. A step that would round to zero finishes the trip. */
function glidePrice(price: number, desired: number): number {
  const step = Math.round(0.1 * (desired - price))
  const next = step === 0 ? desired : price + step
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, next))
}

/** One ton of livestock is worth 0.8 t of meat, 0.1 t of hide, and 10 t of dairy, at those town prices. */
function livestockPrice(prices: Record<Good, number>): number {
  const meat = prices.meat ?? PRICE_FLOOR
  const hide = prices.hide ?? PRICE_FLOOR
  const dairy = prices.dairy ?? PRICE_FLOOR
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, Math.round(meat * 0.8 + hide * 0.1 + dairy * 10)))
}

/** Months of stock. Null when the good is neither used nor stored. */
function coverMonths(stock: number, use: number): number | null {
  if (use <= 0 && stock <= 0) return null
  if (use <= 0) return Number.POSITIVE_INFINITY
  return (stock / TON) / use
}

function tradeEnds(good: Good, fee: number): { list: number | null; bid: number | null; ask: number | null } {
  const foreign = WEST_EUROPE[good]
  if (!foreign) return { list: null, bid: null, ask: null }
  const charge = fee > 0 ? fee : 0
  const bid = foreign.export ? Math.max(PRICE_FLOOR, foreign.price - charge) : null
  const ask = foreign.import === false ? null : foreign.price + charge
  return { list: foreign.price, bid, ask }
}

/** Months of use a harvest good keeps. Twelve in its harvest month, then one less each month. */
function seasonReserve(good: Good, month: number): number | null {
  const harvest = SEASON_MONTH[good]
  if (harvest === undefined) return null
  const until = (harvest - month + 12) % 12
  return until === 0 ? 12 : until
}

/** The shortage floor and the surplus ceiling. A harvest good uses its reserve for both. */
function coverLimits(good: Good, month: number): { low: number; high: number } {
  const reserve = seasonReserve(good, month)
  if (reserve === null) return { low: COVER_SHORT, high: COVER_LONG }
  return { low: reserve, high: reserve }
}

function saturations(stock: Record<Good, number>, use: Record<Good, number>, fee: number, posts: number, month: number): { imports: number; exports: number } {
  const slots = posts * 12
  let exportPile = 0
  let importPile = 0
  for (const good of GOODS) {
    const cover = coverMonths(stock[good] ?? 0, use[good] ?? 0)
    if (cover === null) continue
    const ends = tradeEnds(good, fee)
    const band = coverLimits(good, month)
    const tons = (stock[good] ?? 0) / TON
    if (cover > band.high && ends.bid !== null) exportPile += Math.max(0, tons - band.high * (use[good] ?? 0))
    if (cover < band.low && ends.ask !== null) importPile += Math.max(0, band.low * (use[good] ?? 0) - tons)
  }
  const ratio = (pile: number) => (pile <= 0 ? 0 : slots <= 0 ? 1 : pile / (pile + slots))
  return { imports: ratio(importPile), exports: ratio(exportPile) }
}

/**
 * The price a good is heading toward. A good made through the year sits on the
 * foreign list from 4 to 12 months of cover. A harvest good sits on that list only
 * when cover equals the months left until its next harvest. A shortage can rise
 * above the import ask once the year's import slots are full. A surplus can fall
 * below the export bid once the export slots are full.
 */
function desiredPrice(
  good: Good,
  posted: number,
  stock: number,
  use: number,
  fee: number,
  pressure: { imports: number; exports: number },
  month: number,
): number {
  const ends = tradeEnds(good, fee)
  const sticker = Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, posted))
  const cover = coverMonths(stock, use)
  if (cover === null) return clampPrice(ends.list ?? sticker)
  const band = coverLimits(good, month)
  if (cover < band.low) {
    const safe = Math.max(cover, 0.05)
    if (ends.ask === null) return clampPrice(sticker * Math.sqrt(band.low / safe))
    const lifted = ends.ask * Math.sqrt(band.low / safe)
    return clampPrice(ends.ask + (lifted - ends.ask) * pressure.imports)
  }
  if (cover > band.high) {
    const finite = Math.min(cover, 1e6)
    if (ends.bid === null) return clampPrice(sticker * Math.sqrt(band.high / finite))
    const domestic = ends.bid * Math.sqrt(band.high / finite)
    return clampPrice(ends.bid + (domestic - ends.bid) * pressure.exports)
  }
  return clampPrice(ends.list ?? sticker)
}

/** A household's expected beer in a year, and one brewer's output over that year. */
const BEER_YEAR = 0.3
const BEER_YEAR_OUTPUT = 36

function beerRecipeCost(prices: Record<Good, number>): number {
  const grain = prices.grain ?? PRICE_FLOOR
  const wood = prices.wood ?? PRICE_FLOOR
  const coal = prices.coal ?? PRICE_FLOOR
  const batch = Math.min(grain + 2 * wood, grain + coal / 2)
  return clampPrice(Math.round(batch / 3))
}

function beerMakers(farms: Farms, closedShops: ReadonlySet<number>): number {
  let makers = 0
  for (const row of farms.rows) if (row.specialty === "brewer" && !closedShops.has(row.structureId)) makers += 1
  return Math.max(1, makers)
}

/** Personal income plus a thirtieth of wealth, one score per household, poorest first. */
function beerScores(people: People, headOf: Int32Array): number[] {
  const members = new Map<number, number[]>()
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = headOf[id]
    if (head < 0 || people.alive[head] === 0) continue
    const list = members.get(head)
    if (list) list.push(id)
    else members.set(head, [id])
  }
  const scores: number[] = []
  for (const list of members.values()) {
    let income = 0
    let wealth = 0
    for (const id of list) {
      income += people.income?.[id] ?? 0
      wealth += people.wealth[id] ?? 0
    }
    scores.push(income + wealth / 30)
  }
  scores.sort((a, b) => a - b)
  return scores
}

function beerOnOffer(farms: Farms, closedShops: ReadonlySet<number>): number {
  let tons = 0
  for (const row of farms.rows) {
    if (row.specialty !== "brewer" || closedShops.has(row.structureId)) continue
    tons += (Math.floor((row.store.beer ?? 0) / BEER_LOT) * BEER_LOT) / TON
  }
  return tons
}

/** A brewer over half full stops when releasable beer covers more than a year of Wholesale Sold. */
function beerOverCover(held: number, cap: number, farms: Farms, stock: Record<Good, number>): boolean {
  if (held <= cap / 2) return false
  const supply = beerOnOffer(farms, batchClosed) + wholeLots(stock.beer ?? 0, WHOLESALE_MIN) / TON
  if (beerSoldRate <= 0) return supply > 0
  return supply / beerSoldRate > COVER_LONG
}

/** Tons one household expects from a beer roll. The 50% roll is 0.3 t. */
function beerTons(chance: number): number {
  return (BEER_YEAR * chance) / 0.5
}

/**
 * One town price for every brewer. A household buys on a 50% roll at or under a sixth of its
 * score, and on a 75% roll at or under half that price. Brewers share that demand. Each can
 * sell a year of output plus his share of the releasable pile. The price is the household cap
 * where a brewer's profit is highest. Profit is the capped share times the price minus the
 * cheaper recipe at these input prices. A price below that cost is not used.
 */
function beerClearing(people: People, headOf: Int32Array, farms: Farms, closedShops: ReadonlySet<number>, prices: Record<Good, number>, stock: Record<Good, number>): number {
  const cost = beerRecipeCost(prices)
  const scores = beerScores(people, headOf)
  if (scores.length === 0) return cost
  const makers = beerMakers(farms, closedShops)
  const leftover = beerOnOffer(farms, closedShops) + wholeLots(stock.beer ?? 0, WHOLESALE_MIN) / TON
  const room = BEER_YEAR_OUTPUT + leftover / makers
  const roll = elasticRoll(0.5, demandElasticity("beer"))
  const candidates = new Set<number>()
  for (const score of scores) {
    const walk = score / 6
    if (walk >= cost) candidates.add(walk)
    if (walk / 2 >= cost) candidates.add(walk / 2)
  }
  let bestProfit = 0
  let best = cost
  for (const price of [...candidates].sort((a, b) => b - a)) {
    let tons = 0
    for (const score of scores) {
      const walk = score / 6
      if (price <= walk / 2) tons += beerTons(roll.comfort)
      else if (price <= walk) tons += beerTons(roll.base)
    }
    const sold = Math.min(tons / makers, room)
    const profit = sold * (price - cost)
    if (profit > bestProfit) {
      bestProfit = profit
      best = price
    }
  }
  return clampPrice(Math.round(best))
}

/** Highest wholesale price whose shelf price is still at or under the household cap. */
function wholesaleForShelf(cap: number): number {
  if (cap < 10) return 0
  let low = 1
  let high = cap
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (sellPrice(mid) <= cap) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Purchase-year share of the household score. The lot bought that year spends at most this
 * fraction. Retail buyers compare it with the shelf. Beer keeps its own tenth.
 */
const PURCHASE_SHARE: Partial<Record<Good, number>> = {
  spices: 0.05,
  leather: 0.5,
  clothing: 0.3,
  textiles: 0.1,
  salt: 0.05,
  "steel-tools": 0.3,
  "wagon-parts": 0.3,
  barrels: 0.4,
}

/** Workshop outputs and farm crafts priced by the profit search. Extracted goods stay on the cover quote. */
const PROFIT_GOODS: readonly Good[] = [
  "dried-fruit",
  "spices",
  "cheese",
  "lumber",
  "barrels",
  "cured-fish",
  "cured-meat",
  "leather",
  "textiles",
  "clothing",
  "steel-parts",
  "steel-tools",
  "steel",
  "wagon-parts",
]
/** Fungible raw materials whose quote follows last month's wagon list. */
const RAW_TRADE: readonly Good[] = ["grain", "fiber", "coal", "salt", "lime", "wood"]

/** Tons one maker can sell in a year before the releasable pile is added. */
const YEAR_OUTPUT: Partial<Record<Good, { specialty: ShopSpecialty; tons: number }>> = {
  lumber: { specialty: "sawmill", tons: 72 },
  "steel-parts": { specialty: "blacksmith", tons: 3 },
  "steel-tools": { specialty: "blacksmith", tons: 6 },
  "cured-fish": { specialty: "smokehouse", tons: 12 },
  "cured-meat": { specialty: "smokehouse", tons: 12 },
  cheese: { specialty: "creamery", tons: 6 },
  barrels: { specialty: "cooper", tons: 12 },
  leather: { specialty: "tanner", tons: 3 },
}

type ProfitQuote = {
  people: People
  headOf: Int32Array
  rank: ReadonlyMap<number, SocialClass>
  farms: Farms
  closedShops: ReadonlySet<number>
  stock: Record<Good, number>
  targets: Map<number, Record<Good, number>>
  priorPrices: Record<Good, number>
  priorRelease: Record<Good, number>
  outSlots: number
  inSlots: number
  includePool: boolean
  use: Record<Good, number>
  structures: readonly Structure[]
  terrain: Uint8Array
  feature: Uint8Array
  month: number
  importBids: Partial<Record<Good, number>>
  caravanStaff: ReadonlyMap<number, number>
}

type PayStep = { tons: number; ceiling: number }

function rememberWalkScores(people: People, headOf: Int32Array) {
  walkScores = new Map()
  const members = new Map<number, number[]>()
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = headOf[id]
    if (head < 0 || people.alive[head] === 0) continue
    const list = members.get(head)
    if (list) list.push(id)
    else members.set(head, [id])
  }
  for (const [head, list] of members) {
    let income = 0
    let wealth = 0
    for (const id of list) {
      income += people.income?.[id] ?? 0
      wealth += people.wealth[id] ?? 0
    }
    const score = income + wealth / 30
    for (const id of list) walkScores.set(id, score)
    walkScores.set(head, score)
  }
}

function clearWalkScores() {
  walkScores = new Map()
}

/** Wholesale construction goods stop at three times the foreign price. */
const WHOLESALE_MULTIPLE: Partial<Record<Good, number>> = {
  lumber: 3,
  barrels: 3,
  "steel-parts": 3,
}

/** The foreign price plus the trader's minimum margin. Null when the good cannot be imported. */
function importCeiling(good: Good): number | null {
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false) return null
  return foreign.price + MIN_SPREAD
}

/** Top of the search. Lumber, barrels, and steel parts stop at three times the foreign price. */
function searchCap(good: Good): number {
  const foreign = WEST_EUROPE[good]
  const multiple = WHOLESALE_MULTIPLE[good]
  if (multiple && foreign) return foreign.price * multiple
  if (foreign && foreign.import === false) return foreign.price
  return PRICE_CEILING
}

function inputUnit(good: Good, prices: Record<Good, number>): number {
  return batchQuote?.[good] ?? prices[good] ?? PRICE_FLOOR
}

/** Recipe cost per ton. Null when the good is not made here. */
function recipeCost(good: Good, prices: Record<Good, number>): number | null {
  const made = outputCostPerTon(good)
  if (made !== null) return made
  if (good === "spices") return 10 * inputUnit("vegetables", prices) + 0.02 * inputUnit("textiles", prices) + 4 * inputUnit("wood", prices)
  if (good === "dried-fruit") return 5 * inputUnit("fruit", prices)
  return null
}

function makerCount(good: Good, farms: Farms, closedShops: ReadonlySet<number>): number {
  const specialty = YEAR_OUTPUT[good]?.specialty
  if (specialty) {
    let makers = 0
    for (const row of farms.rows) if (row.specialty === specialty && !closedShops.has(row.structureId)) makers += 1
    return makers
  }
  const crop = good === "spices" ? "vegetables" : good === "dried-fruit" ? "fruit" : null
  if (!crop) return 0
  let makers = 0
  for (const row of farms.rows) if (row.uses.includes(crop)) makers += 1
  return makers
}

function yearTons(good: Good): number {
  return YEAR_OUTPUT[good]?.tons ?? (good === "spices" ? 0.5 : good === "dried-fruit" ? 1 : 0)
}

/**
 * Export tons this price would have won last month. Rivals keep last month's price and releasable pile.
 * A wider dollar spread loads first. A tie leaves the rival ahead, so this good must beat that spread by a dollar.
 * Slack slots give every qualifier its releasable tons. The logit is only used when a wagon actually loads.
 */
function exportTons(
  good: Good,
  price: number,
  priorPrices: Record<Good, number>,
  priorRelease: Record<Good, number>,
  outSlots: number,
  releasable: number,
): number {
  const foreign = WEST_EUROPE[good]
  if (!foreign?.export || foreign.price <= 0 || releasable <= 0 || foreign.price - price < MIN_SPREAD) return 0
  const ranked: { spread: number; tons: number; self: boolean }[] = [{ spread: foreign.price - price, tons: releasable, self: true }]
  for (const other of GOODS) {
    if (other === good) continue
    const quote = WEST_EUROPE[other]
    if (!quote?.export || quote.price <= 0) continue
    const spread = quote.price - (priorPrices[other] ?? 0)
    const tons = priorRelease[other] ?? 0
    if (spread < MIN_SPREAD || tons <= 0) continue
    ranked.push({ spread, tons, self: false })
  }
  ranked.sort((a, b) => b.spread - a.spread || Number(a.self) - Number(b.self))
  let slots = outSlots * 12
  let won = 0
  for (const row of ranked) {
    if (slots <= 0) break
    const take = Math.min(row.tons, slots)
    if (row.self) won = take
    slots -= take
  }
  return won
}

function payStep(tons: number, score: number, lot: number, share: number, retail: boolean, comfort = false): PayStep | null {
  if (tons <= 0 || lot <= 0 || score <= 0 || share <= 0) return null
  const budget = ((share * score) / lot) * (comfort ? 0.5 : 1)
  const ceiling = retail ? wholesaleForShelf(Math.floor(budget)) : Math.floor(budget)
  if (ceiling <= 0) return null
  return { tons, ceiling }
}

/** The roll at a wholesale quote. Comfort is half the shelf budget. Above the walk-away the roll is zero. */
function pricedChance(good: Good, base: number, wholesale: number, score: number, lot: number, share: number): number {
  const roll = elasticRoll(base, demandElasticity(good))
  if (roll.base <= 0 || score <= 0 || lot <= 0 || share <= 0) return 0
  const budget = (share * score) / lot
  const walk = wholesaleForShelf(Math.floor(budget))
  if (walk <= 0 || wholesale > walk) return 0
  const comfort = wholesaleForShelf(Math.floor(budget / 2))
  return wholesale <= comfort ? roll.comfort : roll.base
}

/** Beer compares the town price with a sixth of the score, and the comfort price is half of that. */
function beerDrinkChance(wholesale: number, score: number): number {
  const roll = elasticRoll(0.5, demandElasticity("beer"))
  const walk = score / 6
  if (walk <= 0 || wholesale > walk) return 0
  return wholesale <= walk / 2 ? roll.comfort : roll.base
}

/** Base tons at the walk-away, and the extra tons at half that price. A 1.0 good adds no second step. */
function pushElastic(steps: PayStep[], good: Good, chance: number, score: number, lot: number, share: number, retail: boolean, lotTons = 0.1) {
  const roll = elasticRoll(chance, demandElasticity(good))
  const base = payStep(roll.base * lotTons, score, lot, share, retail)
  if (base) steps.push(base)
  const extra = (roll.comfort - roll.base) * lotTons
  if (extra <= 0) return
  const comfort = payStep(extra, score, lot, share, retail, true)
  if (comfort) steps.push(comfort)
}

/** Households and tenth-ton buyers. The ceiling is the wholesale quote whose price is still inside the purchase-year budget. */
function paySteps(good: Good, context: ProfitQuote): PayStep[] {
  const share = PURCHASE_SHARE[good]
  if (share === undefined) return []
  const steps: PayStep[] = []
  const members = new Map<number, number[]>()
  for (let id = 0; id < context.people.age.length; id++) {
    if (context.people.alive[id] === 0) continue
    const head = context.headOf[id]
    if (head < 0 || context.people.alive[head] === 0) continue
    const list = members.get(head)
    if (list) list.push(id)
    else members.set(head, [id])
  }
  const scoreOf = new Map<number, number>()
  for (const [head, list] of members) {
    let income = 0
    let wealth = 0
    const ages: number[] = []
    for (const id of list) {
      income += context.people.income?.[id] ?? 0
      wealth += context.people.wealth[id] ?? 0
      ages.push(context.people.age[id] ?? 0)
    }
    const score = income + wealth / 30
    scoreOf.set(head, score)
    for (const id of list) scoreOf.set(id, score)
    const standing = context.rank.get(head) ?? "poor"
    const wear = wearChances(ages, CLOTH_CHANCE[standing])
    const lot = closetFloor(standing) / TON
    if (good === "clothing") pushElastic(steps, good, wear.cloth, score, lot, share, true)
    else if (good === "leather") pushElastic(steps, good, wear.leather, score, lot, share, true)
    else if (good === "spices") {
      const spice = SPICE_CHANCE[standing]
      if (spice) pushElastic(steps, good, spice, score, 0.1, share, true)
    }
  }
  for (const structure of context.structures) {
    if (structure.pending || structure.removing) continue
    const row = context.farms.rows.find((item) => item.structureId === structure.id)
    if (!row || row.owner < 0) continue
    const score = scoreOf.get(row.owner) ?? 0
    const scale = structure.kind === "farmstead" ? dryFarmScale(structure, context.terrain, context.feature) : 0
    if (structure.kind === "farmstead" && good === "leather") pushElastic(steps, good, Math.min(1, 0.05 * scale), score, 0.1, share, true)
    if (structure.kind === "farmstead" && good === "textiles") {
      const step = payStep(FARM_TEXTILE_PER_THOUSAND * scale, score, 0.1, share, true)
      if (step) steps.push(step)
    }
    if (structure.kind === "farmstead" && good === "steel-tools") pushElastic(steps, good, Math.min(1, 0.1 * scale), score, 0.1, share, true)
    if (good === "textiles" && row.specialty === "creamery" && !context.closedShops.has(structure.id)) {
      const step = payStep(0.005, score, 0.1, share, true)
      if (step) steps.push(step)
    }
    if (good === "barrels" && row.specialty === "brewer" && !context.closedShops.has(structure.id)) {
      const step = payStep(0.05, score, 1, share, false)
      if (step) steps.push(step)
    }
    if (structure.kind === "trading-post" && (good === "leather" || good === "steel-tools")) pushElastic(steps, good, 0.05, score, 0.1, share, true)
    if (structure.kind === "caravan-house" && context.caravanStaff?.has(structure.id)) {
      if (good === "leather" || good === "steel-tools") pushElastic(steps, good, 0.1, score, 0.1, share, true)
      else {
        const tons = good === "wagon-parts" ? 0.1 : good === "barrels" ? 0.05 : 0
        const lot = good === "barrels" ? 1 : 0.1
        const step = payStep(tons, score, lot, share, good !== "barrels")
        if (step) steps.push(step)
      }
    }
  }
  return steps
}

/** Dollars where the export rank or the import rank changes. The search scores these and the household caps. */
function addTradeBreaks(good: Good, context: ProfitQuote, floor: number, cap: number, candidates: Set<number>) {
  const foreign = WEST_EUROPE[good]
  if (foreign?.export) {
    const bid = foreign.price - MIN_SPREAD
    if (bid >= floor && bid <= cap) candidates.add(bid)
    for (const other of GOODS) {
      if (other === good) continue
      const quote = WEST_EUROPE[other]
      if (!quote?.export || (context.priorRelease[other] ?? 0) <= 0) continue
      const spread = quote.price - (context.priorPrices[other] ?? 0)
      if (spread < MIN_SPREAD) continue
      const ahead = foreign.price - (spread + 1)
      if (ahead >= floor && ahead <= cap) candidates.add(ahead)
    }
  }
  if (foreign && foreign.import !== false && context.inSlots > 0) {
    const ask = foreign.price + MIN_SPREAD
    if (ask >= floor && ask <= cap) candidates.add(ask)
    for (const other of GOODS) {
      if (other === good) continue
      const tons = context.importBids[other] ?? 0
      const quote = WEST_EUROPE[other]
      if (tons <= 0 || !quote || quote.import === false) continue
      const margin = (context.priorPrices[other] ?? 0) - quote.price
      if (margin < MIN_SPREAD) continue
      const ahead = foreign.price + margin + 1
      if (ahead >= floor && ahead <= cap) candidates.add(ahead)
    }
  }
}

/** Lowest quote in the search. The lower of 1.2 times the recipe and the import ask. A good that cannot be imported keeps the recipe floor. */
function quoteFloor(good: Good, cost: number): number {
  const markup = clampPrice(Math.round(cost * WORKSHOP_MARGIN))
  const ask = importCeiling(good)
  return ask === null ? markup : Math.min(markup, ask)
}

/**
 * Town quote for one processed good. Every dollar from the floor to the cap is in play.
 * Profit rises with the price while the tons stay put, so each plateau is scored at its top dollar:
 * a household walk-away, the dollar that still beats a rival's export spread, and the foreign price minus $20.
 * Export tons are a rank fill of last month's slots. Imports are last month's inbound slots at the price each one implies, repeated across the year.
 */
function profitClearing(good: Good, context: ProfitQuote): number {
  const cap = searchCap(good)
  const recipe = recipeCost(good, context.priorPrices)
  const cost = clampPrice(Math.round(recipe ?? importCeiling(good) ?? PRICE_FLOOR))
  const makers = makerCount(good, context.farms, context.closedShops)
  if (recipe === null || makers <= 0) return importCoverPrice(good, context.priorPrices[good] ?? PRICE_FLOOR, context)
  const floor = quoteFloor(good, cost)
  if (floor >= cap) return clampPrice(cap)
  const steps = paySteps(good, context)
  const stepped = steps.reduce((sum, step) => sum + step.tons, 0)
  const block = PURCHASE_SHARE[good] === undefined ? Math.max(0, (context.use[good] ?? 0) * 12 - stepped) : 0
  const leftover = exportable(context.farms, context.stock, context.targets, good, context.includePool) / TON
  const room = yearTons(good) + leftover / makers
  const supply = (context.priorRelease[good] ?? 0) + yearTons(good) * makers
  const candidates = new Set<number>([floor, cap])
  addTradeBreaks(good, context, floor, cap, candidates)
  for (const step of steps) if (step.ceiling >= floor && step.ceiling <= cap) candidates.add(step.ceiling)
  let bestProfit = 0
  let best = floor
  for (const price of candidates) {
    let elastic = 0
    for (const step of steps) if (price <= step.ceiling) elastic += step.tons
    const domestic = elastic + block
    const imports = Math.min(domestic, importSupply(good, price, context) * 12)
    const releasable = Math.max(0, supply - Math.max(0, domestic - imports))
    const exports = exportTons(good, price, context.priorPrices, context.priorRelease, context.outSlots, releasable)
    const profit = Math.min((Math.max(0, domestic - imports) + exports) / makers, room) * (price - cost)
    if (profit > bestProfit || (profit === bestProfit && profit > 0 && price > best)) {
      bestProfit = profit
      best = price
    }
  }
  return clampPrice(Math.round(best))
}

/** A workshop's yearly output plus the tons already in its barn. Beer keeps the brewer's year. */
function firmSupplyTons(good: Good, row: FarmRecord): number {
  const made = good === "beer" ? BEER_YEAR_OUTPUT : yearTons(good)
  return made + Math.max(0, (row.store[good] ?? 0) / TON)
}

/** Finished makers of this workshop good. A sawpit counts as a sawmill. */
function firmMakers(good: Good, context: ProfitQuote): FarmRecord[] {
  const specialty = good === "beer" ? "brewer" : YEAR_OUTPUT[good]?.specialty
  if (!specialty) return []
  return context.farms.rows.filter((row) => row.specialty === specialty && !context.closedShops.has(row.structureId))
}

/** Household steps for one firm chart. Beer is a 50% roll at a sixth of the score, and 75% at half that price. Other goods use the purchase steps. */
function firmSteps(good: Good, context: ProfitQuote): PayStep[] {
  if (good !== "beer") return paySteps(good, context)
  const steps: PayStep[] = []
  const roll = elasticRoll(0.5, demandElasticity("beer"))
  for (const score of beerScores(context.people, context.headOf)) {
    const walk = score / 6
    if (walk <= 0) continue
    steps.push({ tons: beerTons(roll.base), ceiling: walk })
    const extra = beerTons(roll.comfort) - beerTons(roll.base)
    if (extra > 0 && walk / 2 > 0) steps.push({ tons: extra, ceiling: walk / 2 })
  }
  return steps
}

/**
 * Yearly tons buyers and the wagon will take at this price.
 * The wagon is offered a year of output from every maker, plus the surplus pile once.
 * Domestic buyers are filled first, as in the town search.
 */
function firmDemand(good: Good, price: number, steps: readonly PayStep[], block: number, context: ProfitQuote): number {
  let elastic = 0
  for (const step of steps) if (price <= step.ceiling) elastic += step.tons
  const domestic = elastic + block
  const makers = Math.max(1, firmMakers(good, context).length)
  const made = good === "beer" ? BEER_YEAR_OUTPUT : yearTons(good)
  const supply = (context.priorRelease[good] ?? 0) + made * makers
  const imports = Math.min(domestic, importSupply(good, price, context) * 12)
  const releasable = Math.max(0, supply - Math.max(0, domestic - imports))
  const exports = exportTons(good, price, context.priorPrices, context.priorRelease, context.outSlots, releasable)
  return Math.max(0, domestic - imports) + exports
}

/**
 * Margin times the tons this firm keeps.
 * Supply posted below this price sells first. Imports are in that pile, one dollar above the slot they won.
 * What remains is split with makers posted at this price, in proportion to supply, and capped at this firm's supply.
 * No sale scores zero.
 */
function firmProfit(price: number, cost: number, own: number, demand: number, cheaper: number, same: number): number {
  const residual = Math.max(0, demand - cheaper)
  const share = own + same
  if (residual <= 0 || share <= 0) return 0
  const sales = Math.min(own, (residual * own) / share)
  if (sales <= 0) return 0
  return sales * (price - cost)
}

/** This maker's price. Rivals keep the prices they posted, and a maker with no price yet stands at last month's town quote. */
function firmPrice(
  good: Good,
  self: FarmRecord,
  context: ProfitQuote,
  steps: readonly PayStep[],
  block: number,
  priorAsk: ReadonlyMap<number, Partial<Record<Good, number>>>,
): number {
  const recipe = recipeCost(good, context.priorPrices)
  const cost = clampPrice(Math.round(recipe ?? importCeiling(good) ?? PRICE_FLOOR))
  const floor = quoteFloor(good, cost)
  const cap = good === "beer" ? PRICE_CEILING : searchCap(good)
  if (recipe === null || floor >= cap) return clampPrice(Math.min(floor, cap))
  const own = firmSupplyTons(good, self)
  if (own <= 0) return floor
  const town = Math.round(context.priorPrices[good] ?? floor)
  const rivals: { price: number; tons: number }[] = []
  for (const row of firmMakers(good, context)) {
    if (row.structureId === self.structureId) continue
    const tons = firmSupplyTons(good, row)
    if (tons <= 0) continue
    rivals.push({ price: clampPrice(Math.round(priorAsk.get(row.structureId)?.[good] ?? town)), tons })
  }
  const candidates = new Set<number>([floor, cap])
  addTradeBreaks(good, context, floor, cap, candidates)
  for (const step of steps) {
    const top = Math.floor(step.ceiling)
    if (top >= floor && top <= cap) candidates.add(top)
  }
  for (const rival of rivals) {
    if (rival.price >= floor && rival.price <= cap) candidates.add(rival.price)
    const under = rival.price - 1
    if (under >= floor && under <= cap) candidates.add(under)
  }
  let bestProfit = 0
  let best = floor
  for (const price of candidates) {
    if (price < floor || price > cap) continue
    let cheaper = 0
    let same = 0
    for (const rival of rivals) {
      if (rival.price < price) cheaper += rival.tons
      else if (rival.price === price) same += rival.tons
    }
    if (price > PRICE_FLOOR) cheaper += importSupply(good, price - 1, context) * 12
    const profit = firmProfit(price, cost, own, firmDemand(good, price, steps, block, context), cheaper, same)
    if (profit > bestProfit || (profit === bestProfit && profit > 0 && price > best)) {
      bestProfit = profit
      best = price
    }
  }
  return clampPrice(Math.round(best))
}

/**
 * Workshop outputs get a firm price once a year, in the month the workshop opened.
 * A workshop that already had a specialty takes a stable month from its structure id.
 * Every maker due the same month sees last year's posted prices.
 */
function quoteFirmPrices(context: ProfitQuote, month: number, year: number) {
  const due: FarmRecord[] = []
  for (const row of context.farms.rows) {
    if (!row.specialty || !SHOP_BATCHES[row.specialty]) continue
    if (row.openMonth === undefined) row.openMonth = row.structureId % 12
    if (context.closedShops.has(row.structureId)) continue
    if (row.openMonth !== month || row.askYear === year) continue
    due.push(row)
  }
  if (due.length === 0) return
  const priorAsk = new Map<number, Partial<Record<Good, number>>>()
  for (const row of context.farms.rows) if (row.ask) priorAsk.set(row.structureId, row.ask)
  const stepsOf = new Map<Good, PayStep[]>()
  const blockOf = new Map<Good, number>()
  const wanted = new Set<Good>()
  for (const row of due) for (const batch of SHOP_BATCHES[row.specialty as ShopSpecialty]) wanted.add(batch.output)
  for (const good of wanted) {
    const steps = firmSteps(good, context)
    stepsOf.set(good, steps)
    const stepped = steps.reduce((sum, step) => sum + step.tons, 0)
    const block = good === "beer" || PURCHASE_SHARE[good] !== undefined ? 0 : Math.max(0, (context.use[good] ?? 0) * 12 - stepped)
    blockOf.set(good, block)
  }
  for (const row of due) {
    const ask = { ...(row.ask ?? {}) }
    const outputs = new Set<Good>()
    for (const batch of SHOP_BATCHES[row.specialty as ShopSpecialty]) outputs.add(batch.output)
    for (const good of outputs) ask[good] = firmPrice(good, row, context, stepsOf.get(good) ?? [], blockOf.get(good) ?? 0, priorAsk)
    row.ask = ask
    row.askYear = year
  }
}

/** Highest wholesale salt quote whose shelf still fits 5% of some household's score on a tenth of a ton. */
function saltCeiling(people: People, headOf: Int32Array): number | null {
  const members = new Map<number, number[]>()
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = headOf[id]
    if (head < 0 || people.alive[head] === 0) continue
    const list = members.get(head)
    if (list) list.push(id)
    else members.set(head, [id])
  }
  let best = 0
  for (const list of members.values()) {
    let income = 0
    let wealth = 0
    for (const id of list) {
      income += people.income?.[id] ?? 0
      wealth += people.wealth[id] ?? 0
    }
    const cap = wholesaleForShelf(Math.floor(((income + wealth / 30) * (PURCHASE_SHARE.salt ?? 0)) / 0.1))
    if (cap > best) best = cap
  }
  return best > 0 ? best : null
}

/** Months of stock that count as the reserve. Harvest goods use the months left; coal, salt, and wood hold a year. */
function rawReserve(good: Good, month: number): { short: number; long: number } {
  if (good === "coal" || good === "salt" || good === "wood") return { short: 12, long: 12 }
  if (good === "lime") return { short: COVER_SHORT, long: COVER_LONG }
  const season = seasonReserve(good, month)
  return { short: season ?? COVER_SHORT, long: season ?? COVER_LONG }
}

/** Monthly tons of this good the inbound wagon would carry at this price. Other goods fill slots at last month's dollar margin. Empty room, and any slot this price outbids, is available once the price clears the foreign list by $20. */
function importSupply(good: Good, price: number, context: ProfitQuote): number {
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false || context.inSlots <= 0) return 0
  if (price < foreign.price + MIN_SPREAD) return 0
  return importBidTons(good, price, context.inSlots, context)
}

/** Tons of the inbound wagon this price wins against last month's real bids. A wider dollar margin loads first. */
function importBidTons(good: Good, price: number, offer: number, context: ProfitQuote): number {
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false || context.inSlots <= 0 || offer <= 0) return 0
  if (price < foreign.price + MIN_SPREAD) return 0
  const rows: { margin: number; tons: number; self: boolean }[] = [{ margin: price - foreign.price, tons: offer, self: true }]
  for (const other of GOODS) {
    if (other === good) continue
    const tons = context.importBids[other] ?? 0
    const quote = WEST_EUROPE[other]
    if (tons <= 0 || !quote || quote.import === false) continue
    const margin = (context.priorPrices[other] ?? 0) - quote.price
    if (margin < MIN_SPREAD) continue
    rows.push({ margin, tons, self: false })
  }
  rows.sort((a, b) => b.margin - a.margin || (a.self ? 1 : 0) - (b.self ? 1 : 0))
  let slots = context.inSlots
  let won = 0
  for (const row of rows) {
    if (slots <= 0) break
    const take = Math.min(row.tons, slots)
    if (row.self) won = take
    slots -= take
  }
  return won
}

/**
 * Lowest town price that wins the tons this good actually bid.
 * No bid, or a bid list that fits on the wagon, stays at the foreign price plus $20.
 */
function importCoverPrice(good: Good, posted: number, context: ProfitQuote): number {
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false) return posted
  const offer = context.importBids[good] ?? 0
  if (offer <= 0 || context.inSlots <= 0) return foreign.price + MIN_SPREAD
  let total = 0
  for (const item of GOODS) total += context.importBids[item] ?? 0
  if (total <= context.inSlots) return foreign.price + MIN_SPREAD
  const want = Math.min(offer, context.inSlots)
  const candidates = [foreign.price + MIN_SPREAD]
  for (const other of GOODS) {
    if (other === good) continue
    const tons = context.importBids[other] ?? 0
    const quote = WEST_EUROPE[other]
    if (tons <= 0 || !quote || quote.import === false) continue
    const margin = (context.priorPrices[other] ?? 0) - quote.price
    if (margin < MIN_SPREAD) continue
    candidates.push(foreign.price + margin + 1)
  }
  let qualified: number | null = null
  let most = 0
  let mostPrice = foreign.price + MIN_SPREAD
  for (const price of candidates) {
    if (price < PRICE_FLOOR || price > PRICE_CEILING) continue
    const won = importBidTons(good, price, want, context)
    if (won + 1e-9 >= want && (qualified === null || price < qualified)) qualified = price
    if (won > most + 1e-9 || (Math.abs(won - most) <= 1e-9 && price < mostPrice)) {
      most = won
      mostPrice = price
    }
  }
  if (qualified !== null) return Math.round(qualified)
  if (most > 0) return Math.round(mostPrice)
  return foreign.price + MIN_SPREAD
}

/** Tons of the monthly export wagon this price wins against last month's list. A wider dollar spread loads first. */
function exportCoverTons(good: Good, price: number, offer: number, context: ProfitQuote): number {
  const foreign = WEST_EUROPE[good]
  if (!foreign?.export || context.outSlots <= 0 || offer <= 0) return 0
  if (foreign.price - price < MIN_SPREAD) return 0
  const rows: { spread: number; tons: number; self: boolean }[] = [{ spread: foreign.price - price, tons: offer, self: true }]
  for (const other of GOODS) {
    if (other === good) continue
    const quote = WEST_EUROPE[other]
    const release = context.priorRelease[other] ?? 0
    if (!quote?.export || release <= 0) continue
    const spread = quote.price - (context.priorPrices[other] ?? 0)
    if (spread < MIN_SPREAD) continue
    rows.push({ spread, tons: release, self: false })
  }
  rows.sort((a, b) => b.spread - a.spread || (a.self ? 1 : 0) - (b.self ? 1 : 0))
  let slots = context.outSlots
  let won = 0
  for (const row of rows) {
    if (slots <= 0) break
    const take = Math.min(row.tons, slots)
    if (row.self) won = take
    slots -= take
  }
  return won
}

/** A spare pile with no wagon pulls the posted price toward $1 by spare / (reserve + spare). A small spare barely moves it. */
function surplusFloor(posted: number, reserveTons: number, spare: number): number {
  const reserve = Math.max(0, reserveTons)
  const extra = Math.max(0, spare)
  if (extra <= 0) return Math.max(PRICE_FLOOR, Math.round(posted))
  return Math.max(PRICE_FLOOR, Math.round((posted * reserve) / (reserve + extra)))
}

/**
 * Highest town price that still places this month's share of the surplus.
 * Open capacity stays at the foreign price minus $20. The quote steps down only while the tons are still short.
 * A pile that cannot win a ton at any price eases toward $1 with the size of the spare.
 */
function exportCoverPrice(good: Good, surplus: number, months: number, posted: number, reserveTons: number, context: ProfitQuote): number {
  const foreign = WEST_EUROPE[good]
  if (surplus <= 0 || months <= 0) return Math.max(PRICE_FLOOR, Math.round(posted))
  if (!foreign?.export || context.outSlots <= 0 || foreign.price - MIN_SPREAD < PRICE_FLOOR) return surplusFloor(posted, reserveTons, surplus)
  const want = Math.min(surplus / months, context.outSlots)
  if (want <= 0) return posted
  const candidates = [foreign.price - MIN_SPREAD, PRICE_FLOOR]
  for (const other of GOODS) {
    if (other === good) continue
    const quote = WEST_EUROPE[other]
    const release = context.priorRelease[other] ?? 0
    if (!quote?.export || release <= 0) continue
    const spread = quote.price - (context.priorPrices[other] ?? 0)
    if (spread < MIN_SPREAD) continue
    candidates.push(foreign.price - (spread + 1))
  }
  let qualified: number | null = null
  let most = 0
  let mostPrice = posted
  for (const price of candidates) {
    if (price < PRICE_FLOOR || price > PRICE_CEILING) continue
    const won = exportCoverTons(good, price, want, context)
    if (won + 1e-9 >= want && (qualified === null || price > qualified)) qualified = price
    if (won > most + 1e-9 || (Math.abs(won - most) <= 1e-9 && price > mostPrice)) {
      most = won
      mostPrice = price
    }
  }
  if (qualified !== null) return Math.round(qualified)
  if (most > 0) return Math.round(mostPrice)
  return surplusFloor(posted, reserveTons, surplus)
}

/** Above the reserve, export the surplus over the months it covers. Below it, the quote follows last month's import bids. On the reserve, the posted price holds. */
function rawTradePrice(good: Good, posted: number, stockTons: number, monthly: number, context: ProfitQuote): number {
  const fuel = good === "wood" || good === "coal"
  const use = monthly > 0 ? monthly : fuel ? 0 : ASSUMED_MONTHLY_USE
  const band = rawReserve(good, context.month)
  const reserveTons = band.long * use
  if (use > 0 && stockTons < band.short * use) return importCoverPrice(good, posted, context)
  if (stockTons > reserveTons) return exportCoverPrice(good, stockTons - reserveTons, band.long, posted, reserveTons, context)
  return posted
}

/** Processed goods use the profit search. Raw materials follow the wagon list, and salt still takes its household ceiling. */
function applyProfitQuotes(quote: Record<Good, number>, context: ProfitQuote) {
  for (const good of PROFIT_GOODS) quote[good] = profitClearing(good, context)
  const sale = forSaleStock(context.farms, context.stock, context.targets)
  for (const good of RAW_TRADE) {
    const posted = context.priorPrices[good] ?? quote[good] ?? PRICE_FLOOR
    quote[good] = rawTradePrice(good, posted, (sale[good] ?? 0) / TON, context.use[good] ?? 0, context)
  }
  const salt = saltCeiling(context.people, context.headOf)
  if (salt !== null) quote.salt = Math.min(quote.salt ?? PRICE_FLOOR, salt)
}

function clampPrice(value: number): number {
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, value))
}

/** Average shelf price across the shops and the market that currently have the good. Each retailer counts once. */
export function marketSale(farms: Farms, marketIds: readonly number[]): Partial<Record<Good, number>> {
  const sum: Partial<Record<Good, number>> = {}
  const count: Partial<Record<Good, number>> = {}
  for (const row of farms.rows) {
    if (!marketIds.includes(row.structureId)) continue
    for (const good of GOODS) {
      const cost = row.cost?.[good]
      if (!cost || (row.store[good] ?? 0) <= 0) continue
      sum[good] = (sum[good] ?? 0) + sellPrice(cost)
      count[good] = (count[good] ?? 0) + 1
    }
  }
  const ask: Partial<Record<Good, number>> = {}
  for (const good of GOODS) {
    const retailers = count[good]
    if (!retailers) continue
    ask[good] = Math.round((sum[good] ?? 0) / retailers)
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
  month: number,
): Record<Good, number> {
  const demand = assumedUse(use)
  const pressure = saturations(stock, demand, fee, posts, month)
  const marks = {} as Record<Good, number>
  for (const good of GOODS) {
    const quote = desiredPrice(good, posted[good] ?? PRICE_FLOOR, stock[good] ?? 0, demand[good] ?? 0, fee, pressure, month)
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
  month: number,
): Record<Good, number> {
  const draft = priceMarks(stock, measure(undefined), posted, fee, posts, month)
  return priceMarks(stock, measure(draft), posted, fee, posts, month)
}

/**
 * How far the spare sits above the amount the town keeps. Null when it does not.
 * A harvest good keeps the months left until its next harvest. Any other good keeps 4 months.
 * A good nobody uses is scored as if the town used one ton a year.
 */
function exportRank(spareHundredths: number, monthly: number, good: Good, month: number): number | null {
  const keep = seasonReserve(good, month) ?? COVER_SHORT
  const cover = (spareHundredths / TON) / (monthly > 0 ? monthly : 1 / 12)
  return cover > keep ? cover / keep : null
}

type ExportOffer = { good: Good; price: number; workshopId: number | null }

/**
 * One town-price offer for the farms, and one offer per workshop with a spare ton.
 * The good must clear the reserve. A workshop qualifies on its own ask. Farms qualify on the town price.
 */
function exportOffers(
  farms: Farms,
  stock: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  includePool: boolean,
  use: Record<Good, number>,
  month: number,
  prices: Record<Good, number>,
  postId: number,
  imported: ReadonlySet<Good>,
  missedTown: ReadonlySet<Good>,
  missedShop: ReadonlySet<string>,
): ExportOffer[] {
  const offers: ExportOffer[] = []
  for (const good of GOODS) {
    if (imported.has(good)) continue
    const foreign = WEST_EUROPE[good]
    if (!foreign?.export) continue
    if (exportRank(exportable(farms, stock, targets, good, includePool), use[good] ?? 0, good, month) === null) continue
    const town = prices[good] ?? 0
    const sellers = exportSellers(farms, targets, good, postId)
    const workshops = sellers.filter((row) => routes.workshopIds.has(row.structureId))
    const farmsSelling = sellers.some((row) => !routes.workshopIds.has(row.structureId))
    if (farmsSelling && !missedTown.has(good) && foreign.price - town >= MIN_SPREAD) offers.push({ good, price: town, workshopId: null })
    for (const row of workshops) {
      if (missedShop.has(`${row.structureId}:${good}`)) continue
      const ask = workshopAsk(row.structureId, good, town)
      if (foreign.price - ask < MIN_SPREAD) continue
      offers.push({ good, price: ask, workshopId: row.structureId })
    }
  }
  return offers
}

/** Share of the wagon. The margin is the dollar gap under the foreign price, and τ is a tenth. */
function logitOffers(offers: readonly ExportOffer[], rng: () => number): ExportOffer {
  if (offers.length === 1) return offers[0]
  const scores = offers.map((offer) => {
    const foreign = WEST_EUROPE[offer.good]?.price ?? 0
    if (foreign <= 0) return 0
    return foreign - offer.price
  })
  const peak = Math.max(...scores)
  const weights = scores.map((score) => Math.exp((score - peak) / LOGIT_TAU))
  let roll = rng() * weights.reduce((sum, weight) => sum + weight, 0)
  for (let index = 0; index < offers.length; index++) {
    roll -= weights[index]
    if (roll <= 0) return offers[index]
  }
  return offers[offers.length - 1]
}

/** Import share of the wagon. The margin is how far the town price sits above the foreign price. */
function logitImport(goods: readonly Good[], prices: Record<Good, number>, rng: () => number): Good {
  if (goods.length === 1) return goods[0]
  const scores = goods.map((good) => {
    const foreign = WEST_EUROPE[good]?.price ?? 0
    if (foreign <= 0) return 0
    return ((prices[good] ?? 0) - foreign) / foreign
  })
  const peak = Math.max(...scores)
  const weights = scores.map((score) => Math.exp((score - peak) / LOGIT_TAU))
  let roll = rng() * weights.reduce((sum, weight) => sum + weight, 0)
  for (let index = 0; index < goods.length; index++) {
    roll -= weights[index]
    if (roll <= 0) return goods[index]
  }
  return goods[goods.length - 1]
}

type ImportBid = { good: Good; buyer: number; structureId: number; hundredths: number; defer: boolean }

/** Hundredths a shop can buy, in whole tons, from a farm, a linked workshop, or the trader's pile. */
function localShelfHundredths(
  farms: Farms,
  shopId: number,
  buyer: number,
  good: Good,
  targets: Map<number, Record<Good, number>>,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  prices: Record<Good, number>,
): number {
  const budget = new Map<number, number>()
  let hundredths = 0
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer) continue
    const farm = routes.farmIds.has(row.structureId)
    const workshop = routes.workshopIds.has(row.structureId)
    if (!farm && !workshop) continue
    if (!sellProtein(row.structureId, good)) continue
    if (workshop && !shopLinked(shopId, row.structureId, good)) continue
    const room = wholeLots(spareAt(farms, row, good, targets, budget), TON)
    if (room < TON) continue
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
    hundredths += room
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
  if (pool && shopLinked(shopId, -1, good)) {
    const room = wholeLots(pool.room, TON)
    if (room >= TON) hundredths += room
  }
  return hundredths
}

function gatherImportBids(
  farms: Farms,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  buildNeeds: readonly { structureId?: number; buyer?: number; good: Good; hundredths: number }[],
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
): ImportBid[] {
  const bids: ImportBid[] = []
  const qualifies = (good: Good) => {
    const foreign = WEST_EUROPE[good]
    return !!foreign && foreign.import !== false && (prices[good] ?? 0) >= foreign.price + MIN_SPREAD
  }
  for (const id of routes.shopIds) {
    const shop = farms.rows.find((row) => row.structureId === id)
    if (!shop || shop.owner < 0) continue
    for (const good of GOODS) {
      if (!qualifies(good)) continue
      const target = shopLineTarget(shop.retail, good)
      if (!target) continue
      const pile = shelfPile(farms, shop, good, targets, target)
      if (pile.shelf * 2 > target) continue
      const gap = coverLots(pile.need, TON) - localShelfHundredths(farms, id, shop.owner, good, targets, stock, stockOwner, stockAsk, prices)
      if (gap < TON) continue
      bids.push({ good, buyer: shop.owner, structureId: id, hundredths: Math.floor(gap / TON) * TON, defer: false })
    }
  }
  for (const [owner, need] of targets) {
    if (owner < 0) continue
    const row = farms.rows.filter((item) => item.owner === owner).sort((a, b) => a.structureId - b.structureId)[0]
    if (!row) continue
    for (const good of GOODS) {
      if (!qualifies(good)) continue
      const short = (need[good] ?? 0) - barnHeld(farms, owner, good)
      if (short <= 0) continue
      const tons = inputNeeds.get(owner)?.has(good) ? Math.ceil(short / TON) : Math.floor(short / TON)
      if (tons < 1) continue
      bids.push({ good, buyer: owner, structureId: row.structureId, hundredths: tons * TON, defer: false })
    }
  }
  for (const need of buildNeeds) {
    if (!qualifies(need.good)) continue
    const tons = Math.floor(need.hundredths / TON)
    if (tons < 1) continue
    bids.push({ good: need.good, buyer: need.buyer ?? -1, structureId: need.structureId ?? -1, hundredths: tons * TON, defer: true })
  }
  return bids
}

function deliverImport(farms: Farms, wealth: Int32Array, bid: ImportBid, tons: number, post: Holding, prices: Record<Good, number>) {
  const qty = tons * TON
  if (bid.defer || !farms.rows.some((row) => row.structureId === bid.structureId)) {
    importAllowance.set(bid.good, (importAllowance.get(bid.good) ?? 0) + qty)
    return
  }
  const ask = importAsk(bid.good, prices)
  if (!ask) return
  const offer: FreshImport = {
    structureId: post.structureId,
    owner: post.owner,
    price: ask.price,
    room: qty,
    fee: ask.fee,
  }
  payImport(wealth, bid.buyer, offer, bid.good, qty)
  const row = farms.rows.find((item) => item.structureId === bid.structureId)
  if (row) row.store[bid.good] = (row.store[bid.good] ?? 0) + qty
}

/** Each trader draws a good, then one buyer who wants at least a ton, and fills that buyer or the wagon. */
function loadImportWagons(
  farms: Farms,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  posts: Holding[],
  shipping: ReadonlyMap<number, ShipHouse>,
  buildNeeds: readonly { structureId?: number; buyer?: number; good: Good; hundredths: number }[],
  seed: string,
  year: number,
  month: number,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
) {
  const bids = gatherImportBids(farms, prices, targets, buildNeeds, stock, stockOwner, stockAsk)
  for (const bid of bids) noteImportBid(bid.good, Math.floor(bid.hundredths / TON))
  for (const post of posts) {
    let room = shipping.get(post.structureId)?.in ?? 1
    const reachable = () => bids.filter((bid) => bid.hundredths >= TON && traderOpen(bid.buyer, post.structureId) && (!routes.shopIds.includes(bid.structureId) || pairLinked(bid.structureId, post.structureId)))
    const open = reachable()
    const wanted = open.reduce((sum, bid) => sum + Math.floor(bid.hundredths / TON), 0)
    const fill = (bid: ImportBid, tons: number) => {
      const take = Math.min(tons, Math.floor(bid.hundredths / TON), room)
      if (take < 1) return 0
      deliverImport(farms, wealth, bid, take, post, prices)
      bid.hundredths -= take * TON
      room -= take
      return take
    }
    if (wanted <= room) {
      for (const bid of open) fill(bid, Math.floor(bid.hundredths / TON))
      continue
    }
    const rng = mulberry32(hashSeed(`${seed}:import:${post.structureId}:${year}:${month}`))
    const missed = new Set<Good>()
    while (room >= 1) {
      const live = reachable().filter((bid) => !missed.has(bid.good))
      const goods = [...new Set(live.map((bid) => bid.good))]
      if (goods.length === 0) break
      const good = logitImport(goods, prices, rng)
      const buyers = live.filter((bid) => bid.good === good)
      const bid = buyers[Math.min(buyers.length - 1, Math.floor(rng() * buyers.length))]
      if (fill(bid, Math.floor(bid.hundredths / TON)) === 0) missed.add(good)
    }
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
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  for (const structure of structures) {
    const row = owned.get(structure.id)
    if (!row) continue
    const scale = dryFarmScale(structure, terrain, feature)
    if (scale <= 0) continue
    const rng = mulberry32(hashSeed(`${seed}:farm-supply:${structure.id}:${year}`))
    const score = walkScores.get(row.owner) ?? 0
    const tools = pricedChance("steel-tools", Math.min(1, 0.1 * scale), offerPrice("steel-tools", prices, fee), score, 0.1, PURCHASE_SHARE["steel-tools"] ?? 0)
    const leather = pricedChance("leather", Math.min(1, 0.05 * scale), offerPrice("leather", prices, fee), score, 0.1, PURCHASE_SHARE.leather ?? 0)
    if (rng() < tools) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee, "retail")
    if (rng() < leather) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "leather", 10, prices, targets, marketIds, fee, "retail")
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

type Census = {
  headOf: Int32Array
  rank: Map<number, SocialClass>
  /** Food portions of the head, spouse, and their unmarried children. */
  scale: Float64Array
  members: Map<number, number[]>
  birthHeads: number[][]
  portionSum: number
  clothYear: number
  leatherYear: number
  /** Tons of spices households expect at the base roll. Middle 1%, upper 2%, wealthy 3%, each of 0.1 t. */
  spiceYear: number
  /** Tons of salt households expect to use in a year. One roll of 2% per person, capped at one tenth of a ton. */
  saltYear: number
  /** Tons of beer households expect at the 50% roll. Half of them buy 0.6 t. The comfort price raises that roll to 75%. */
  beerYear: number
  protein: Partial<Record<Good, number>>
}

type DietBag = { produced: Set<Good>; fruit: boolean; veg: boolean; keep: Set<Good>; wood: boolean }

type HouseholdNeed = { head: number; good: Good; hundredths: number; store: boolean; food?: boolean; bare?: boolean }

/** One walk. Food portions follow the head's own children. Demand counts every resident. */
function buildCensus(people: People, headOf: Int32Array, rank: Map<number, SocialClass>, orders: Map<number, Good[]>): Census {
  const scale = new Float64Array(people.age.length)
  const members = new Map<number, number[]>()
  const birthHeads: number[][] = Array.from({ length: 12 }, () => [])
  let portionSum = 0
  let clothYear = 0
  let leatherYear = 0
  let spiceYear = 0
  let saltYear = 0
  let beerHeads = 0
  const protein: Partial<Record<Good, number>> = {}
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = homeHead(headOf, id)
    const list = members.get(head)
    if (list) list.push(id)
    else members.set(head, [id])
    const age = people.age[id] ?? 0
    const portion = age <= 5 ? 0.5 : age <= 12 ? 0.75 : 1
    portionSum += portion
    const pick = orders.get(head)?.[0]
    if (pick) protein[pick] = (protein[pick] ?? 0) + (portion * proteinTons(pick)) / 12
    if (id === head) {
      birthHeads[people.birthMonth[id] ?? 0].push(id)
      beerHeads += 1
      spiceYear += (SPICE_CHANCE[rank.get(head) ?? "poor"] ?? 0) * 0.1
    }
    const mate = people.spouse[head] ?? -1
    const mateAlive = mate >= 0 && mate < people.alive.length && people.alive[mate] !== 0
    const unmarried = (people.spouse[id] ?? -1) < 0
    const childOfHead =
      people.mother[id] === head ||
      people.father[id] === head ||
      (mateAlive && (people.mother[id] === mate || people.father[id] === mate))
    if (id === head || (mateAlive && id === mate) || (unmarried && childOfHead)) scale[head] += portion
    if (unmarried && id === head) {
      const homes = new Set<number>()
      for (const parent of [people.father[id] ?? -1, people.mother[id] ?? -1]) {
        if (parent < 0 || parent >= people.alive.length || people.alive[parent] === 0) continue
        const home = homeHead(headOf, parent)
        const homeMate = people.spouse[home] ?? -1
        const homeMateAlive = homeMate >= 0 && homeMate < people.alive.length && people.alive[homeMate] !== 0
        if (parent === home || (homeMateAlive && parent === homeMate)) homes.add(home)
      }
      for (const home of homes) if (home !== id) scale[home] += portion
    }
  }
  for (const list of birthHeads) list.sort((a, b) => a - b)
  for (const [head, list] of members) {
    const standing = rank.get(head) ?? "poor"
    const wear = wearChances(list.map((id) => people.age[id] ?? 0), CLOTH_CHANCE[standing])
    clothYear += elasticRoll(wear.cloth, demandElasticity("clothing")).comfort * 0.1
    leatherYear += elasticRoll(wear.leather, demandElasticity("leather")).comfort * 0.1
    saltYear += Math.min(1, 0.02 * list.length) * 0.1
  }
  return { headOf, rank, scale, members, birthHeads, portionSum, clothYear, leatherYear, spiceYear, saltYear, beerYear: beerHeads * 0.3, protein }
}

/**
 * Personal goods are taken from the pantry in the month they are due. Food and fuel
 * are a year at a time. Clothing and leather each get one roll on the head's birthday.
 * Shortfalls are bought from the market after the shelves are filled.
 * A farm eats a food it grows in that crop's harvest month, and burns wood in February
 * when the holding yields it. Coal is taken in January when the kiln has run.
 * Everyone else buys in the head's birth month. Fruit or vegetables is an even
 * chance, or three to one toward the crop the farm grows, unless one costs more than ten
 * times the other. Then the household takes the cheaper one. A pick the household does not
 * grow and cannot cover becomes the other crop. A protein it does not produce and cannot
 * cover becomes dairy, then fish. Leftover food is kept only when the household produces it
 * or a workshop uses it. Anything else is wasted.
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
  census: Census,
  burnsWood: boolean,
  woodYear: number,
  coalMakers: ReadonlySet<number>,
  starving: Uint8Array,
  starveDue: Uint16Array,
  farmHeads: ReadonlySet<number>,
  foundedYear: number,
): { needs: HouseholdNeed[]; attempted: Set<number> } {
  const headOf = census.headOf
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const needs: HouseholdNeed[] = []
  const attempted = new Set<number>()
  const starvationOn = year >= foundedYear + 5
  const purseOf = (head: number) => {
    if (!starvationOn || starving[head] !== 1 || farmHeads.has(head)) return Math.max(0, wealth[head] ?? 0)
    let sum = 0
    for (const id of census.members.get(head) ?? [head]) sum += Math.max(0, wealth[id] ?? 0)
    return sum
  }
  const coverGoods: Good[] = ["fruit", "vegetables", "meat", "fish", "dairy"]
  const rowOf = new Map<number, FarmRecord>()
  const homeBarns = new Map<number, FarmRecord[]>()
  const shopBarns = new Map<number, FarmRecord[]>()
  const pantry = new Map<number, Partial<Record<Good, number>>>()
  const ownerHeld = new Map<number, Partial<Record<Good, number>>>()
  for (const row of farms.rows) {
    rowOf.set(row.structureId, row)
    const head = homeHead(headOf, row.owner)
    const pile = pantry.get(head) ?? {}
    const ownedTons = ownerHeld.get(row.owner) ?? {}
    for (const good of coverGoods) {
      const qty = row.store[good] ?? 0
      if (qty === 0) continue
      pile[good] = (pile[good] ?? 0) + qty
      ownedTons[good] = (ownedTons[good] ?? 0) + qty
    }
    pantry.set(head, pile)
    ownerHeld.set(row.owner, ownedTons)
    const barns = sellsRetail(row.structureId) ? shopBarns : homeBarns
    const list = barns.get(head)
    if (list) list.push(row)
    else barns.set(head, [row])
  }
  const shelfTotal: Partial<Record<Good, number>> = {}
  const shelfOwn = new Map<number, Partial<Record<Good, number>>>()
  for (const row of farms.rows) {
    if (!sellsRetail(row.structureId)) continue
    const own = shelfOwn.get(row.owner) ?? {}
    const heldTons = ownerHeld.get(row.owner) ?? {}
    for (const good of coverGoods) {
      const reserve = heldBack(targets, row.owner, good)
      const qty = Math.max(0, Math.min(row.store[good] ?? 0, (heldTons[good] ?? 0) - reserve))
      if (qty === 0) continue
      shelfTotal[good] = (shelfTotal[good] ?? 0) + qty
      own[good] = (own[good] ?? 0) + qty
    }
    shelfOwn.set(row.owner, own)
  }
  const diets = new Map<number, DietBag>()
  const heated = new Map<number, number>()
  const diet = (head: number) => {
    let bag = diets.get(head)
    if (!bag) {
      bag = { produced: new Set(), fruit: false, veg: false, keep: new Set(), wood: false }
      diets.set(head, bag)
    }
    return bag
  }
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    const holding = owned.get(structure.id)
    if (!holding || holding.owner < 0) continue
    const head = homeHead(headOf, holding.owner)
    if (heatsHouse(structure, farms)) heated.set(head, (heated.get(head) ?? 0) + 1)
    const bag = diet(head)
    const record = rowOf.get(structure.id)
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
      if (uses.includes("livestock")) {
        bag.produced.add("dairy")
        bag.produced.add("meat")
      }
      let woods = 0
      for (const tile of structure.tiles) {
        const ground = terrain[tile]
        if (ground === Terrain.Sea || ground === Terrain.Fresh) bag.produced.add("fish")
        const cover = feature[tile]
        if (cover === Feature.Woodland || cover === Feature.Forest) woods += 1
        if (cover === Feature.Woodland) {
          bag.produced.add("fruit")
          bag.produced.add("meat")
        } else if (cover === Feature.Forest) {
          bag.produced.add("vegetables")
          bag.produced.add("meat")
        } else if (cover === Feature.Wetland) bag.produced.add("meat")
      }
      if (woods > 0 || record?.fruitAge === 34) bag.wood = true
    }
    if (structure.kind === "workshop" && record?.specialty === "creamery") bag.keep.add("dairy")
    if (structure.kind === "workshop" && record?.specialty === "smokehouse") {
      bag.keep.add("fish")
      bag.keep.add("meat")
    }
  }

  const held = (head: number, good: Good) => {
    let total = pantry.get(head)?.[good] ?? 0
    if (stockOwner[good] !== undefined && homeHead(headOf, stockOwner[good] ?? -1) === head) total += stock[good] ?? 0
    return total
  }
  const offered = (good: Good, buyer: number) => (shelfTotal[good] ?? 0) - (shelfOwn.get(buyer)?.[good] ?? 0)
  const canFeed = (head: number, good: Good, hundredths: number) => {
    const have = held(head, good)
    if (have >= hundredths) return true
    const short = hundredths - have
    if (offered(good, head) < short) return false
    const cost = Math.round((offerPrice(good, prices, fee) * short) / TON)
    return purseOf(head) >= cost
  }
  const eat = (head: number, good: Good, hundredths: number, food = false) => {
    if (hundredths <= 0) return
    if (food) attempted.add(head)
    let left = hundredths
    const own = (rows: FarmRecord[] | undefined) => {
      if (!rows) return
      for (const row of rows) {
        if (left <= 0) break
        const take = Math.min(row.store[good] ?? 0, left)
        row.store[good] -= take
        const spare = row.surplus?.[good] ?? 0
        if (spare > 0 && take > 0) {
          const refund = Math.min(take, spare)
          row.store[good] += refund
          const rest = spare - refund
          if (rest > 0) row.surplus = { ...(row.surplus ?? {}), [good]: rest }
          else if (row.surplus) {
            const leftOver = { ...row.surplus }
            delete leftOver[good]
            row.surplus = leftOver
          }
        }
        left -= take
      }
    }
    own(homeBarns.get(head))
    own(shopBarns.get(head))
    if (left > 0 && stockOwner[good] !== undefined && homeHead(headOf, stockOwner[good] ?? -1) === head) {
      const take = Math.min(stock[good] ?? 0, left)
      stock[good] -= take
      left -= take
    }
    if (left > 0) needs.push({ head, good, hundredths: left, store: false, food, bare: food && left === hundredths })
  }

  const dueHeads = new Set<number>(census.birthHeads[month] ?? [])
  for (const [head, bag] of diets) {
    for (const good of DIET) if (bag.produced.has(good) && HARVEST_MONTH[good] === month) dueHeads.add(head)
    if (burnsWood && bag.wood && month === 1) dueHeads.add(head)
    if (!burnsWood && coalMakers.has(head) && month === 0) dueHeads.add(head)
  }
  if (starvationOn) {
    for (let id = 0; id < starving.length; id++) {
      if (starving[id] === 0) continue
      if (people.alive[id] === 0 || homeHead(headOf, id) !== id) continue
      dueHeads.add(id)
    }
  }

  for (const head of [...dueHeads].sort((a, b) => a - b)) {
    if (people.alive[head] === 0 || homeHead(headOf, head) !== head) continue
    const birth = people.birthMonth[head] ?? 0
    const birthday = month === birth
    const closetSource = homeBarns.get(head)
    const closetList = [...(closetSource && closetSource.length > 0 ? closetSource : shopBarns.get(head) ?? [])].sort((a, b) => a.structureId - b.structureId)
    const closetHeld = (good: Good) => closetList.reduce((sum, row) => sum + (row.store[good] ?? 0), 0)
    const drawCloset = (good: Good, hundredths: number) => {
      let left = hundredths
      for (const row of closetList) {
        if (left <= 0) break
        const take = Math.min(row.store[good] ?? 0, left)
        row.store[good] -= take
        left -= take
      }
    }
    if (birthday) {
      const ages: number[] = []
      for (const id of census.members.get(head) ?? [head]) {
        if (people.alive[id] === 0) continue
        ages.push(people.age[id] ?? 0)
      }
      const standing = census.rank.get(head) ?? "poor"
      const wear = wearChances(ages, CLOTH_CHANCE[standing])
      const score = walkScores.get(head) ?? 0
      const lot = closetFloor(standing) / TON
      const rng = mulberry32(hashSeed(`${seed}:wear:${year}:${head}`))
      const clothChance = pricedChance("clothing", wear.cloth, offerPrice("clothing", prices, fee), score, lot, PURCHASE_SHARE.clothing ?? 0)
      const leatherChance = pricedChance("leather", wear.leather, offerPrice("leather", prices, fee), score, lot, PURCHASE_SHARE.leather ?? 0)
      if (rng() < clothChance) drawCloset("clothing", 10)
      if (rng() < leatherChance) drawCloset("leather", 10)
      const floor = closetFloor(standing)
      const clothHave = closetHeld("clothing")
      const leatherHave = closetHeld("leather")
      const leatherFloor = floor + (targets.get(head)?.leather ?? 0)
      if (clothHave < floor) needs.push({ head, good: "clothing", hundredths: Math.ceil((floor - clothHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
      if (leatherHave < leatherFloor) needs.push({ head, good: "leather", hundredths: Math.ceil((leatherFloor - leatherHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
      const spiceBase = SPICE_CHANCE[standing] ?? 0
      if (spiceBase > 0) {
        const spice = mulberry32(hashSeed(`${seed}:spice:${year}:${head}`))
        const spiceChance = pricedChance("spices", spiceBase, offerPrice("spices", prices, fee), score, 0.1, PURCHASE_SHARE.spices ?? 0)
        if (spice() < spiceChance) drawCloset("spices", 10)
        const spiceHave = closetHeld("spices")
        if (spiceHave < 10) needs.push({ head, good: "spices", hundredths: Math.ceil((10 - spiceHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
      }
      const atHome = (census.members.get(head) ?? [head]).filter((id) => people.alive[id] !== 0).length
      const salt = mulberry32(hashSeed(`${seed}:salt:${year}:${head}`))
      if (salt() < Math.min(1, 0.02 * atHome)) {
        if (closetHeld("salt") >= 10) drawCloset("salt", 10)
        else needs.push({ head, good: "salt", hundredths: 10, store: false })
      }
    }
    const fires = heated.get(head) ?? 0
    const bag = diet(head)
    if (fires > 0) {
      const takeWood = burnsWood && (bag.wood ? month === 1 : birthday)
      const takeCoal = !burnsWood && (coalMakers.has(head) ? month === 0 : birthday)
      if (takeWood || takeCoal) {
        const good: Good = takeWood ? "wood" : "coal"
        const tons = fires * (takeWood ? woodYear : woodYear / 4)
        eat(head, good, Math.round(tons * TON))
      }
    }
    const scale = census.scale[head] ?? 0
    if (scale <= 0) continue
    const grain = Math.round(scale * 10)
    const gardenNeed = Math.round(scale * 30)
    const fruitPrice = offerPrice("fruit", prices, fee)
    const vegPrice = offerPrice("vegetables", prices, fee)
    const fruitChance = bag.fruit && !bag.veg ? 0.75 : bag.veg && !bag.fruit ? 0.25 : 0.5
    const roll = mulberry32(hashSeed(`${seed}:garden:${head}:${year}`))()
    const garden: Good = fruitPrice > vegPrice * 10 ? "vegetables" : vegPrice > fruitPrice * 10 ? "fruit" : roll < fruitChance ? "fruit" : "vegetables"
    const other: Good = garden === "fruit" ? "vegetables" : "fruit"
    const retry = starvationOn && starving[head] === 1
    const due = (good: Good) => retry || month === (bag.produced.has(good) ? HARVEST_MONTH[good] : birth)
    if (due("grain")) eat(head, "grain", grain, true)
    if (due(garden)) {
      const choice = bag.produced.has(garden) || canFeed(head, garden, gardenNeed) ? garden : other
      eat(head, choice, gardenNeed, true)
    }
    const protein = orders.get(head) ?? []
    const first = protein[0]
    if (first && due(first)) {
      const tons = (good: Good) => Math.round(scale * proteinTons(good) * TON)
      const covered = (good: Good) => bag.produced.has(good) || canFeed(head, good, tons(good))
      let choice = first
      if (!covered(first)) {
        for (const good of ["dairy", "fish"] as const) {
          if (good === first) continue
          choice = good
          if (covered(good)) break
        }
      }
      eat(head, choice, tons(choice), true)
    }
  }

  for (const row of farms.rows) {
    if (sellsRetail(row.structureId)) continue
    const bag = diets.get(homeHead(headOf, row.owner))
    for (const good of DIET) {
      if (bag?.produced.has(good) || bag?.keep.has(good)) continue
      row.store[good] = 0
    }
  }
  return { needs, attempted }
}

/** November, the month after the grain harvest. `tons` is the whole year. */
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
  tons = 1,
) {
  const want = tons * TON
  const grain = want - takeOwned(farms, stock, stockOwner, post.owner, "grain", want)
  if (grain > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, post.owner, "grain", grain, prices, targets, marketIds, fee, buyerDeal(farms, post.owner))
}

const BEER_LOT = 60

/** After food, clothing, leather, and salt, on the head's birthday. A 50% roll buys 0.6 t from a brewer, or 75% when the town price is at or under half the household's beer cap. The household's own brewery is drunk on the same roll. A short pile, a short purse, or a price above a sixth of the score skips the drink. */
function buyBirthdayBeer(
  people: People,
  farms: Farms,
  wealth: Int32Array,
  prices: Record<Good, number>,
  census: Census,
  month: number,
  year: number,
  seed: string,
  closedShops: ReadonlySet<number>,
) {
  const sellers = farms.rows
    .filter((row) => row.specialty === "brewer" && !closedShops.has(row.structureId) && (row.store.beer ?? 0) >= BEER_LOT)
    .sort((a, b) => a.structureId - b.structureId)
  for (const head of census.birthHeads[month] ?? []) {
    if (people.alive[head] === 0 || homeHead(census.headOf, head) !== head) continue
    const price = offerPrice("beer", prices, 0)
    const list = census.members.get(head) ?? [head]
    let income = 0
    let purse = 0
    for (const id of list) {
      if (people.alive[id] === 0) continue
      income += people.income?.[id] ?? 0
      purse += people.wealth[id] ?? 0
    }
    const score = income + purse / 30
    if (mulberry32(hashSeed(`${seed}:beer:${year}:${head}`))() >= beerDrinkChance(price, score)) continue
    const own = sellers.find((row) => row.owner === head && (row.store.beer ?? 0) >= BEER_LOT)
    if (own) {
      own.store.beer = (own.store.beer ?? 0) - BEER_LOT
      continue
    }
    const cost = Math.round((price * BEER_LOT) / TON)
    if (cost > score * 0.1) continue
    if (head >= wealth.length || (wealth[head] ?? 0) < cost) continue
    const seller = sellers.find((row) => row.owner !== head && (row.store.beer ?? 0) >= BEER_LOT)
    if (!seller) continue
    seller.store.beer = (seller.store.beer ?? 0) - BEER_LOT
    payFor(wealth, head, seller.owner, price, BEER_LOT)
    noteLedger("beer", BEER_LOT, cost, "both", true)
  }
}

/** January uses 1 t of barrels on a 5% roll. Any month the pantry is empty, the brewer buys one whole ton and does not top up a partial pile. */
function feedBrewerBarrels(
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
  month: number,
  seed: string,
  closedShops: ReadonlySet<number>,
) {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  for (const structure of structures) {
    if (structure.kind !== "workshop" || structure.pending || structure.removing || closedShops.has(structure.id)) continue
    const row = farms.rows.find((item) => item.structureId === structure.id)
    const holding = owned.get(structure.id)
    if (!row || row.specialty !== "brewer" || !holding) continue
    if (month === 0 && mulberry32(hashSeed(`${seed}:brew-barrels:${structure.id}:${year}`))() < 0.05) {
      const held = row.store.barrels ?? 0
      const taken = Math.min(held, TON)
      row.store.barrels = held - taken
    }
    if ((row.store.barrels ?? 0) > 0) continue
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, holding.owner, "barrels", TON, prices, targets, marketIds, fee, buyerDeal(farms, holding.owner), "ton", true)
    if (bought.taken > 0) row.store.barrels = (row.store.barrels ?? 0) + bought.taken
  }
}

/** July uses 1 t of livestock on a 15% roll. Any month the pantry is under 3 t, the trader buys whole tons until it holds 3 t. */
function feedTraderLivestock(
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
  month: number,
  seed: string,
) {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const keep = 3 * TON
  for (const structure of structures) {
    if ((structure.kind !== "trading-post" && structure.kind !== "caravan-house") || structure.pending || structure.removing) continue
    const row = farms.rows.find((item) => item.structureId === structure.id)
    const holding = owned.get(structure.id)
    if (!row || !holding) continue
    if (month === 6 && mulberry32(hashSeed(`${seed}:herd:${structure.id}:${year}`))() < 0.15) {
      const held = row.store.livestock ?? 0
      row.store.livestock = held - Math.min(held, TON)
    }
    while ((row.store.livestock ?? 0) < keep) {
      const own = takeOwnHerd(farms, holding.owner, structure.id)
      if (own > 0) {
        row.store.livestock = (row.store.livestock ?? 0) + own
        continue
      }
      const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, holding.owner, "livestock", TON, prices, targets, marketIds, fee, buyerDeal(farms, holding.owner), "ton")
      if (bought.taken <= 0) break
      row.store.livestock = (row.store.livestock ?? 0) + bought.taken
    }
  }
}

/** One whole ton from the owner's own farm, leaving that farm its last ton. */
function takeOwnHerd(farms: Farms, owner: number, traderId: number): number {
  const rows = farms.rows.filter((row) => row.owner === owner && row.structureId !== traderId && routes.farmIds.has(row.structureId)).sort((a, b) => a.structureId - b.structureId)
  for (const row of rows) {
    if ((row.store.livestock ?? 0) < TON * 2) continue
    row.store.livestock = (row.store.livestock ?? 0) - TON
    return TON
  }
  return 0
}

/** January uses 1 t of barrels on a 5% roll. Any month the pantry is empty, the house buys one whole ton and does not top up a partial pile. */
function feedCaravanBarrels(
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
  year: number,
  month: number,
  seed: string,
) {
  const row = farms.rows.find((item) => item.structureId === post.structureId)
  if (!row) return
  if (month === 0 && mulberry32(hashSeed(`${seed}:barrels:${post.structureId}:${year}`))() < 0.05) {
    const held = row.store.barrels ?? 0
    const taken = Math.min(held, TON)
    row.store.barrels = held - taken
  }
  if ((row.store.barrels ?? 0) > 0) return
  const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, post.owner, "barrels", TON, prices, targets, marketIds, fee, buyerDeal(farms, post.owner), "ton")
  if (bought.taken > 0) row.store.barrels = (row.store.barrels ?? 0) + bought.taken
}

/** January. A post has a 5% chance to use 0.1 t of leather and of tools. A caravan house has a 10% chance, and also uses 0.1 t of wagon parts. Leather and tools rise by their elasticity at or below half the walk-away price. */
function feedPost(post: Holding, farms: Farms, stock: Record<Good, number>, stockOwner: Partial<Record<Good, number>>, prices: Record<Good, number>, year: number, seed: string, chance: number, wagon: boolean) {
  const rng = mulberry32(hashSeed(`${seed}:supply:${post.structureId}:${year}`))
  const score = walkScores.get(post.owner) ?? 0
  const leather = pricedChance("leather", chance, offerPrice("leather", prices, 0), score, 0.1, PURCHASE_SHARE.leather ?? 0)
  const tools = pricedChance("steel-tools", chance, offerPrice("steel-tools", prices, 0), score, 0.1, PURCHASE_SHARE["steel-tools"] ?? 0)
  if (rng() < leather) takeOwned(farms, stock, stockOwner, post.owner, "leather", 10)
  if (rng() < tools) takeOwned(farms, stock, stockOwner, post.owner, "steel-tools", 10)
  if (wagon) takeOwned(farms, stock, stockOwner, post.owner, "wagon-parts", 10)
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
  prefer?: "input" | "supply",
  ledger = false,
) {
  const owned = takeOwned(farms, stock, stockOwner, head, good, hundredths)
  const rest = hundredths - owned
  if (rest > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, head, good, rest, prices, targets, marketIds, fee, deal, prefer, ledger)
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
    const reserve = heldBack(targets, row.owner, good)
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

/** Stock on this barn above the owner's reserve. The reserve is met from other barns first. */
function sellable(
  farms: Farms,
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  targets: Map<number, Record<Good, number>>,
): number {
  const reserve = heldBack(targets, row.owner, good)
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
    if (row.uses.includes("livestock")) {
      made.add("dairy")
      made.add("meat")
    }
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
  const shelfIds = retailShelves(structures, owned)
  const costs = livingCosts(prices, lows, urbanTile, marketSale(farms, shelfIds))
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

function proteinSellers(farms: Farms): { rows: Map<Good, FarmRecord[]>; held: Map<number, Partial<Record<Good, number>>>; byOwner: Map<number, FarmRecord[]> } {
  const rows = new Map<Good, FarmRecord[]>()
  for (const good of PROTEINS) rows.set(good, [])
  const held = new Map<number, Partial<Record<Good, number>>>()
  const byOwner = new Map<number, FarmRecord[]>()
  for (const row of farms.rows) {
    if (row.owner < 0) continue
    const barns = byOwner.get(row.owner)
    if (barns) barns.push(row)
    else byOwner.set(row.owner, [row])
    const bag = held.get(row.owner) ?? {}
    for (const good of PROTEINS) {
      const qty = row.store[good] ?? 0
      if (qty <= 0) continue
      bag[good] = (bag[good] ?? 0) + qty
      if (sellProtein(row.structureId, good)) rows.get(good)?.push(row)
    }
    held.set(row.owner, bag)
  }
  return { rows, held, byOwner }
}

function proteinForSale(
  sellers: { rows: Map<Good, FarmRecord[]>; byOwner: Map<number, FarmRecord[]> },
  stock: Record<Good, number>,
  _stockOwner: Partial<Record<Good, number>>,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  buyer: number,
  deal: Deal,
  prices: Record<Good, number>,
): boolean {
  const spare = new Map<number, number>()
  for (const row of sellers.rows.get(good) ?? []) {
    if (row.owner === buyer) continue
    const min = lotMin(deal, row.structureId)
    if (min === 0) continue
    if (!spare.has(row.owner)) {
      let total = 0
      for (const barn of sellers.byOwner.get(row.owner) ?? []) total += barn.store[good] ?? 0
      spare.set(row.owner, Math.max(0, total - heldBack(targets, row.owner, good)))
    }
    const room = Math.min(row.store[good] ?? 0, spare.get(row.owner) ?? 0)
    if (room >= min) return true
  }
  if (deal !== "retail") {
    const seller = _stockOwner[good]
    if ((stock[good] ?? 0) >= WHOLESALE_MIN && seller !== undefined && seller !== buyer) return true
    if (freshImports(good, buyer, prices).length > 0) return true
  }
  return false
}

/** Two years of operating supplies, plus 0.1 t of the tools and fiber each farm or workshop keeps. Household fuel, food, and clothing are not stocked here. */
/** Recipe inputs a producer is keeping one batch of. Set by stockTargets. */
let inputNeeds = new Map<number, Set<Good>>()
const SUPPLY_GOODS = new Set<Good>(["steel-tools", "fiber", "leather", "textiles", "salt", "wagon-parts"])

function produces(farms: Farms, buyer: number): boolean {
  return farms.rows.some((row) => row.owner === buyer && (routes.farmIds.has(row.structureId) || routes.workshopIds.has(row.structureId)))
}

function stockTargets(
  _people: People,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  _lows: readonly number[],
  _terrain: Uint8Array,
  _feature: Uint8Array,
  farms: Farms,
  _prices: Record<Good, number>,
  _protein?: { orders: Map<number, Good[]>; headOf: Int32Array; rank: Map<number, SocialClass> },
  closedShops: ReadonlySet<number> = new Set(),
): Map<number, Record<Good, number>> {
  inputNeeds = new Map()
  const shops = new Map<number, number>()
  const markets = new Map<number, number>()
  const posts = new Map<number, number>()
  const caravans = new Map<number, number>()
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
    if (structure.kind === "market" || structure.kind === "trading-post") shops.set(row.owner, (shops.get(row.owner) ?? 0) + 1)
    if (structure.kind === "market") markets.set(row.owner, (markets.get(row.owner) ?? 0) + 1)
    if (structure.kind === "trading-post") posts.set(row.owner, (posts.get(row.owner) ?? 0) + 1)
    if (structure.kind === "caravan-house") caravans.set(row.owner, (caravans.get(row.owner) ?? 0) + 1)
    if ((structure.kind === "workshop" || structure.kind === "sawpit") && !closedShops.has(structure.id)) {
      const bag = hold(row.owner)
      bag.tools += 1
      const specialty = craftOf(structure, farms.rows.find((item) => item.structureId === structure.id)?.specialty)
      if (specialty === "creamery") {
        bag.textiles += 1
        bag.salt += 1
      }
      shops.set(row.owner, (shops.get(row.owner) ?? 0) + 1)
      const extra = inputHold.get(row.owner) ?? emptyGoods()
      const store = farms.rows.find((item) => item.structureId === structure.id)?.store
      holdShopInputs(extra, specialty, store)
      inputHold.set(row.owner, extra)
    }
    if (structure.kind === "farmstead") {
      const bag = hold(row.owner)
      bag.tools += 1
      bag.leather += 1
      bag.textiles += 1
    }
  }
  const targets = new Map<number, Record<Good, number>>()
  for (const owner of new Set([...shops.keys(), ...kept.keys(), ...caravans.keys()])) {
    const tons = emptyGoods()
    const marketCount = markets.get(owner) ?? 0
    const postCount = posts.get(owner) ?? 0
    const caravanCount = caravans.get(owner) ?? 0
    tons.leather += marketCount * 0.05 + postCount * 0.005 + caravanCount * 0.01
    tons.textiles += marketCount * 0.05
    tons["steel-tools"] += marketCount * 0.025 + postCount * 0.005 + caravanCount * 0.01
    tons["wagon-parts"] += caravanCount * 0.1
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
      const inputs = new Set<Good>()
      for (const good of GOODS) {
        if (extra[good] <= 0) continue
        hundredths[good] += extra[good]
        inputs.add(good)
      }
      if (inputs.size > 0) inputNeeds.set(owner, inputs)
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

/** Owned markets and shops. The shelf price of a good is the average across whichever of these have it. */
function retailShelves(structures: readonly Structure[], owned: Map<number, Holding>): number[] {
  return structures
    .filter((structure) => (structure.kind === "market" || structure.kind === "shop") && !structure.pending && !structure.removing && owned.has(structure.id))
    .map((structure) => structure.id)
    .sort((a, b) => a - b)
}

/** A tenth costs $1 plus 20% of the wholesale tenth, rounded to the nearest dollar. The ton price is ten of those. */
function sellPrice(unit: number): number {
  const tenth = Math.round(1 + (unit * (1 + MARKUP)) / 10)
  return Math.max(1, tenth) * 10
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
  row: { owner: number; store: Record<Good, number>; structureId?: number },
  good: Good,
  targets: Map<number, Record<Good, number>>,
  budget: Map<number, number>,
): number {
  if (!budget.has(row.owner)) budget.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - heldBack(targets, row.owner, good)))
  let pile = row.store[good] ?? 0
  if (good === "livestock" && row.structureId !== undefined && routes.farmIds.has(row.structureId)) pile = Math.max(0, pile - TON)
  return Math.max(0, Math.min(pile, budget.get(row.owner) ?? 0))
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
function buyLot(wealth: Int32Array, buyer: number, price: number, room: number, need: number, step: number, exact = false): number {
  const capped = exact ? wholeLots(need, step) : coverLots(need, step)
  const qty = Math.min(wholeLots(room, step), capped)
  if (qty < step) return 0
  if (buyer < 0) return qty
  if (wealth.length <= buyer) return 0
  return wholeLots(affordable(wealth[buyer], price, qty), step)
}

/** The state pays at most three times the foreign list. A good with no foreign price has no cap. */
function statePrice(good: Good, price: number): boolean {
  const foreign = WEST_EUROPE[good]
  if (!foreign) return true
  return price <= foreign.price * 3
}

/**
 * A construction buyer takes what is available. Lumber and wood move by the ton.
 * Other goods move by the tenth from a market, workshop, or farm. The office pantry
 * can fill a site, and it is not a public sale. Spare wood at an idle office sells
 * by the ton at the town price. A building that burns or crafts with wood keeps its pile.
 */
function buyBuild(
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
  roundImport: boolean,
  buyerSite = -1,
): { taken: number; spent: number } {
  const left = hundredths
  if (left <= 0) return { taken: 0, spent: 0 }
  const local = good === "lumber" || good === "wood" ? WHOLESALE_MIN : RETAIL_MIN
  const unit = offerPrice(good, prices, fee)
  const budget = new Map<number, number>()
  const sellers = farms.rows
    .filter((row) => {
      const kind = routes.kindOf.get(row.structureId)
      if (buyer < 0 && kind === "construction-office") return false
      if (row.owner === buyer && buyer >= 0 && kind === "market") return false
      return kind === "market" || kind === "workshop" || kind === "sawpit" || kind === "farmstead" || kind === "construction-office"
    })
    .sort((a, b) => a.structureId - b.structureId)
  const draws: Draw[] = []
  for (const row of sellers) {
    if (!haulAllowed(row.structureId, buyerSite)) continue
    if (!sellProtein(row.structureId, good)) continue
    if (good === "wood" && keepsWood(row.structureId, farms)) continue
    const kind = routes.kindOf.get(row.structureId)
    const office = kind === "construction-office"
    const price = kind === "market" || (office && good !== "wood") ? sellPrice(row.cost?.[good] ?? unit) : workshopAsk(row.structureId, good, unit)
    if (buyer < 0 && !statePrice(good, price)) continue
    const room = office ? (row.store[good] ?? 0) : spareAt(farms, row, good, targets, budget)
    if (room < local) continue
    if (!office) budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
    draws.push({
      price,
      room,
      min: local,
      rank: 0,
      id: row.structureId,
      pull: (qty) => {
        const paid = payFor(wealth, buyer, row.owner, price, qty)
        row.store[good] = (row.store[good] ?? 0) - qty
        return paid
      },
    })
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
  if (pool && (buyer >= 0 || statePrice(good, pool.price))) {
    const room = wholeLots(pool.room, WHOLESALE_MIN)
    if (room >= WHOLESALE_MIN) {
      draws.push({
        price: pool.price,
        room,
        min: WHOLESALE_MIN,
        rank: 1,
        id: -1,
        pull: (qty) => {
          const paid = payFor(wealth, buyer, pool.owner, pool.price, qty)
          stock[good] -= qty
          return paid
        },
      })
    }
  }
  for (const offer of freshImports(good, buyer, prices)) {
    if (buyer < 0 && !statePrice(good, offer.price)) continue
    draws.push({
      price: netImport(offer, buyer),
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 2,
      id: offer.structureId,
      pull: (qty) => payImport(wealth, buyer, offer, good, qty),
    })
  }
  return drawSources(wealth, buyer, draws, left, true, roundImport, good)
}

function takeState(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  row: { store: Record<Good, number>; cost?: Partial<Record<Good, number>> },
  good: Good,
  hundredths: number,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  fee: number,
): number {
  const bought = buyBuild(farms, stock, stockOwner, stockAsk, wealth, -1, good, hundredths, prices, targets, fee, true)
  if (bought.taken <= 0) return 0
  const unit = bought.spent > 0 ? (bought.spent * TON) / bought.taken : offerPrice(good, prices, fee)
  rememberCost(row, good, bought.taken, unit)
  row.store[good] = (row.store[good] ?? 0) + bought.taken
  return bought.taken
}

function payFor(wealth: Int32Array, buyer: number, seller: number, price: number, qty: number): number {
  const cost = price <= 0 ? 0 : Math.round((price * qty) / TON)
  if (buyer < 0) stateSpent += cost
  else credit(wealth, buyer, -cost)
  credit(wealth, seller, cost)
  return cost
}

/** Farms and workshops with a whole ton of this good that this post can haul. */
function exportSellers(
  farms: Farms,
  targets: Map<number, Record<Good, number>>,
  good: Good,
  postId: number,
): Farms["rows"] {
  const budget = new Map<number, number>()
  return farms.rows
    .filter((row) => {
      if (!routes.farmIds.has(row.structureId) && !routes.workshopIds.has(row.structureId)) return false
      if (!sellProtein(row.structureId, good)) return false
      if (!haulAllowed(row.structureId, postId)) return false
      return spareAt(farms, row, good, targets, budget) >= TON
    })
    .sort((a, b) => a.structureId - b.structureId)
}

function dealFor(structureId: number): Deal {
  const kind = routes.kindOf.get(structureId)
  if (kind === "farmstead" || kind === "shack" || kind === "shop") return "retail"
  if (kind === "market") return "market"
  return "workshop"
}

function buyerDeal(farms: Farms, owner: number): Deal {
  const own = farms.rows.filter((row) => row.owner === owner).sort((a, b) => a.structureId - b.structureId)
  const barn = own.find((row) => !sellsRetail(row.structureId)) ?? own[0]
  return barn ? dealFor(barn.structureId) : "retail"
}

/** 0 means this buyer does not deal with that barn. */
function lotMin(deal: Deal, structureId: number): number {
  if (sellsRetail(structureId)) return RETAIL_MIN
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
    if (good === "wood") continue
    const room = wholeLots(spareAt(farms, row, good, targets, budget), RETAIL_MIN)
    if (room < RETAIL_MIN) continue
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
    offers.push({ row, room })
  }
  if (good === "wood") {
    for (const row of rows) {
      if (keepsWood(row.structureId, farms)) continue
      const raw = spareAt(farms, row, good, targets, budget)
      const room = wholeLots(raw, WHOLESALE_MIN)
      if (room < WHOLESALE_MIN) continue
      budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
      offers.push({ row, room })
    }
    for (const row of farms.rows) {
      if (!idleWoodOffices.has(row.structureId)) continue
      const room = wholeLots(row.store.wood ?? 0, WHOLESALE_MIN)
      if (room < WHOLESALE_MIN) continue
      offers.push({ row, room })
    }
  }
  offers.sort((a, b) => b.room - a.room || a.row.structureId - b.row.structureId)
  return offers
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
  const postId = stockPost[good]
  if (owner === undefined || owner === buyer || room < WHOLESALE_MIN) return null
  if (postId !== undefined && !buyerReaches(buyer, postId)) return null
  return { owner, room, price: stockAsk[good] ?? prices[good] ?? PRICE_FLOOR }
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

function marketDraws(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  shop: { owner: number; store: Record<Good, number>; cost?: Partial<Record<Good, number>> },
  good: Good,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  unit: number,
  ledger = false,
): Draw[] {
  const draws: Draw[] = []
  for (const offer of producerOffers(farms, shop.owner, good, targets, true)) {
    const price = workshopAsk(offer.row.structureId, good, unit)
    draws.push({
      price,
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 0,
      id: offer.row.structureId,
      book: ledger ? "both" : undefined,
      pull: (qty) => {
        const paid = payFor(wealth, shop.owner, offer.row.owner, price, qty)
        offer.row.store[good] = (offer.row.store[good] ?? 0) - qty
        rememberCost(shop, good, qty, price)
        shop.store[good] = (shop.store[good] ?? 0) + qty
        return paid
      },
    })
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, shop.owner)
  if (pool) {
    const room = wholeLots(pool.room, WHOLESALE_MIN)
    if (room >= WHOLESALE_MIN) {
      draws.push({
        price: pool.price,
        room,
        min: WHOLESALE_MIN,
        rank: 1,
        id: -1,
        book: ledger ? "bought" : undefined,
        pull: (qty) => {
          const paid = payFor(wealth, shop.owner, pool.owner, pool.price, qty)
          stock[good] -= qty
          rememberCost(shop, good, qty, pool.price)
          shop.store[good] = (shop.store[good] ?? 0) + qty
          return paid
        },
      })
    }
  }
  for (const offer of freshImports(good, shop.owner, prices)) {
    const price = netImport(offer, shop.owner)
    draws.push({
      price,
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 2,
      id: offer.structureId,
      book: ledger ? "bought" : undefined,
      pull: (qty) => {
        const paid = payImport(wealth, shop.owner, offer, good, qty)
        rememberCost(shop, good, qty, price)
        shop.store[good] = (shop.store[good] ?? 0) + qty
        return paid
      },
    })
  }
  return draws
}

/** Shelf above the family's reserve, and the hundredths still wanted so the shelf reaches its target. */
function shelfPile(
  farms: Farms,
  row: { owner: number; store: Record<Good, number> },
  good: Good,
  targets: Map<number, Record<Good, number>>,
  target: number,
): { shelf: number; need: number } {
  const reserve = heldBack(targets, row.owner, good)
  const onRow = row.store[good] ?? 0
  const elsewhere = barnHeld(farms, row.owner, good) - onRow
  const reserveHere = Math.max(0, reserve - elsewhere)
  return { shelf: Math.max(0, onRow - reserveHere), need: Math.max(0, reserveHere + target - onRow) }
}

function copyShelfEpisode(
  episode: FarmRecord["shelfEpisode"],
): FarmRecord["shelfEpisode"] {
  if (!episode) return undefined
  const next: NonNullable<FarmRecord["shelfEpisode"]> = {}
  for (const good of GOODS) {
    const item = episode[good]
    if (item) next[good] = { ...item }
  }
  return next
}

/** Keep the last twelve months. A quiet month stays in the window as a zero. */
function rollRetail(previous: TownTrade["retail"]): TownTrade["retail"] {
  const next: NonNullable<TownTrade["retail"]> = {}
  for (const good of GOODS) {
    if (!SHELF_TARGET[good]) continue
    const prior = previous?.[good] ?? []
    next[good] = [...prior, { restock: retailRestock.get(good) ?? 0, reject: retailReject.get(good) ?? 0 }].slice(-12)
  }
  return next
}

/**
 * One refill, before sales. At half or below, buy the gap in whole tons.
 * A target of 2 t or more also tops up when it is a ton short and still above half.
 * That top-up does not score. A large refill scores once, when the tons received
 * reach half the target, and a delivery split across months is still one refill.
 * The first time the shelf is lifted above half does not score.
 */
function fillShelves(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  posts: Holding[],
  _month: number,
) {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const shelves: { id: number; targetOf: (good: Good) => number }[] = [
    ...routes.marketIds.map((id) => ({ id, targetOf: (good: Good) => SHELF_TARGET[good] ?? 0 })),
    ...routes.shopIds.map((id) => ({
      id,
      targetOf: (good: Good) => shopLineTarget(farms.rows.find((row) => row.structureId === id)?.retail, good),
    })),
  ]
  for (const shelf of shelves) {
    const shop = farms.rows.find((row) => row.structureId === shelf.id)
    if (!shop || wealth.length <= shop.owner) continue
    for (const good of GOODS) {
      const target = shelf.targetOf(good)
      if (!target) continue
      let pile = shelfPile(farms, shop, good, targets, target)
      if (pile.shelf * 2 > target) {
        shop.shelfReady = { ...(shop.shelfReady ?? {}), [good]: true }
        const open = shop.shelfEpisode
        if (open?.[good]) {
          const rest = { ...open }
          delete rest[good]
          shop.shelfEpisode = rest
        }
      }
      if (pile.need <= 0) continue
      const atHalf = pile.shelf * 2 <= target
      if (!atHalf && (target < 2 * TON || pile.need < TON)) continue
      const unit = offerPrice(good, prices, fee)
      const other = substituteQuote(good, prices, fee)
      if (other !== null && unit > other * 100) continue
      const before = shop.store[good] ?? 0
      const draws = marketDraws(farms, stock, stockOwner, stockAsk, wealth, shop, good, prices, targets, unit, routes.kindOf.get(shelf.id) === "market")
      drawSources(wealth, shop.owner, routes.kindOf.get(shelf.id) === "shop" ? draws.filter((draw) => shopLinked(shelf.id, draw.id, good)) : draws, coverLots(pile.need, TON), false, true, good)
      const taken = Math.max(0, (shop.store[good] ?? 0) - before)
      if (taken > 0) retailOffered.add(good)
      if (atHalf) {
        const prior = shop.shelfEpisode?.[good]
        const episode = {
          got: (prior?.got ?? 0) + taken,
          scored: prior?.scored ?? false,
          debut: prior?.debut ?? !shop.shelfReady?.[good],
        }
        if (!episode.debut && !episode.scored && episode.got * 2 >= target && episode.got > 0) {
          episode.scored = true
          retailRestock.set(good, (retailRestock.get(good) ?? 0) + 1)
        }
        shop.shelfEpisode = { ...(shop.shelfEpisode ?? {}), [good]: episode }
      }
      pile = shelfPile(farms, shop, good, targets, target)
      if (pile.shelf * 2 > target) {
        const episode = shop.shelfEpisode?.[good]
        if (episode?.debut) shop.shelfReady = { ...(shop.shelfReady ?? {}), [good]: true }
        if (episode) {
          const rest = { ...(shop.shelfEpisode ?? {}) }
          delete rest[good]
          shop.shelfEpisode = rest
        }
      }
    }
  }
  for (const shelf of shelves) {
    for (const good of GOODS) {
      if (!shelf.targetOf(good)) continue
      const shop = farms.rows.find((row) => row.structureId === shelf.id)
      if (shop && sellable(farms, shop, good, targets) > 0) retailOffered.add(good)
    }
  }
}

/** A shop buys grain from a farm with no road. A workshop or a trader has to be on a finished path. */
function shopLinked(shopId: number, sellerId: number, good: Good): boolean {
  if (sellerId < 0) {
    const post = stockPost[good]
    return post === undefined || pairLinked(shopId, post)
  }
  const kind = routes.kindOf.get(sellerId)
  if (kind === "workshop" || kind === "sawpit" || kind === "trading-post" || kind === "caravan-house") return pairLinked(shopId, sellerId)
  return true
}

/** Wood and coal, in whole tons, from farmsteads, at the town price. */
function buyFarmFuel(
  farms: Farms,
  wealth: Int32Array,
  buyer: number,
  good: Good,
  hundredths: number,
  unit: number,
  targets: Map<number, Record<Good, number>>,
): { taken: number; spent: number } {
  const budget = new Map<number, number>()
  const draws: Draw[] = []
  for (const row of farms.rows) {
    if (!routes.farmIds.has(row.structureId) || row.owner < 0 || row.owner === buyer) continue
    const raw = spareAt(farms, row, good, targets, budget)
    const room = wholeLots(raw, WHOLESALE_MIN)
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
    if (room < WHOLESALE_MIN) continue
    draws.push({
      price: unit,
      room,
      min: WHOLESALE_MIN,
      rank: 0,
      id: row.structureId,
      roundUp: true,
      pull: (qty) => {
        const paid = payFor(wealth, buyer, row.owner, unit, qty)
        row.store[good] = (row.store[good] ?? 0) - qty
        return paid
      },
    })
  }
  return drawSources(wealth, buyer, draws, hundredths, false, true, good)
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
  prefer?: "input" | "supply" | "ton",
  ledger = false,
): { taken: number; spent: number } {
  let left = hundredths
  let spent = 0
  if (left <= 0 || wealth.length <= buyer) return { taken: 0, spent: 0 }
  const unit = offerPrice(good, prices, fee)
  const share = PURCHASE_SHARE[good]
  if (share && deal === "retail" && walkScores.size > 0) {
    const bill = Math.round((sellPrice(unit) * left) / TON)
    if (bill > share * (walkScores.get(buyer) ?? 0)) return { taken: 0, spent: 0 }
  }
  if (deal === "retail" && (good === "wood" || good === "coal")) return buyFarmFuel(farms, wealth, buyer, good, left, unit, targets)
  if (prefer) {
    const retail: Draw[] = []
    for (const shop of farms.rows.filter((row) => sellsRetail(row.structureId) && row.owner !== buyer).sort((a, b) => a.structureId - b.structureId)) {
      const room = sellable(farms, shop, good, targets)
      const price = sellPrice(shop.cost?.[good] ?? unit)
      if (room < RETAIL_MIN) continue
      retail.push({
        price,
        room,
        min: RETAIL_MIN,
        rank: 0,
        id: shop.structureId,
        pull: (qty) => {
          const paid = payFor(wealth, buyer, shop.owner, price, qty)
          shop.store[good] = (shop.store[good] ?? 0) - qty
          return paid
        },
      })
    }
    const tons: Draw[] = []
    const tonBudget = new Map<number, number>()
    for (const row of farms.rows.filter((item) => item.owner >= 0 && item.owner !== buyer && (routes.farmIds.has(item.structureId) || routes.workshopIds.has(item.structureId))).sort((a, b) => a.structureId - b.structureId)) {
      if (!sellProtein(row.structureId, good) || !buyerReaches(buyer, row.structureId)) continue
      const raw = spareAt(farms, row, good, targets, tonBudget)
      const room = wholeLots(raw, WHOLESALE_MIN)
      tonBudget.set(row.owner, (tonBudget.get(row.owner) ?? 0) - raw)
      if (room < WHOLESALE_MIN) continue
      const price = workshopAsk(row.structureId, good, unit)
      tons.push({
        price,
        room,
        min: WHOLESALE_MIN,
        rank: 1,
        id: row.structureId,
        roundUp: true,
        book: ledger ? "both" : undefined,
        pull: (qty) => {
          const paid = payFor(wealth, buyer, row.owner, price, qty)
          row.store[good] = (row.store[good] ?? 0) - qty
          return paid
        },
      })
    }
    const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
    if (pool) {
      const room = wholeLots(pool.room, WHOLESALE_MIN)
      if (room >= WHOLESALE_MIN) {
        tons.push({
          price: pool.price,
          room,
          min: WHOLESALE_MIN,
          rank: 1,
          id: -1,
          roundUp: true,
          book: ledger ? "bought" : undefined,
          pull: (qty) => {
            const paid = payFor(wealth, buyer, pool.owner, pool.price, qty)
            stock[good] -= qty
            return paid
          },
        })
      }
    }
    for (const offer of freshImports(good, buyer, prices)) {
      tons.push({
        price: netImport(offer, buyer),
        room: offer.room,
        min: WHOLESALE_MIN,
        rank: 2,
        id: offer.structureId,
        roundUp: true,
        book: ledger ? "bought" : undefined,
        pull: (qty) => payImport(wealth, buyer, offer, good, qty),
      })
    }
    const passes = prefer === "ton" ? [tons] : prefer === "input" ? [tons, retail] : [retail, tons]
    if (prefer === "input" && sourceFill(passes, left) * 2 > (wealth[buyer] ?? 0)) return { taken: 0, spent: 0 }
    let taken = 0
    for (const pass of passes) {
      if (left <= 0) break
      const got = drawSources(wealth, buyer, pass, left, false, true, good)
      taken += got.taken
      spent += got.spent
      left -= got.taken
    }
    return { taken, spent }
  }
  const producerMin = deal === "market" ? RETAIL_MIN : WHOLESALE_MIN

  const shops = farms.rows.filter((row) => sellsRetail(row.structureId) && row.owner !== buyer).sort((a, b) => a.structureId - b.structureId)
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
  if (deal === "retail") {
    fromMarkets()
    return { taken, spent }
  }

  const budget = new Map<number, number>()
  const draws: Draw[] = []
  for (const shop of shops) {
    const room = sellable(farms, shop, good, targets)
    const price = sellPrice(shop.cost?.[good] ?? unit)
    if (room < RETAIL_MIN) continue
    draws.push({
      price,
      room,
      min: RETAIL_MIN,
      rank: 0,
      id: shop.structureId,
      pull: (qty) => {
        const paid = payFor(wealth, buyer, shop.owner, price, qty)
        shop.store[good] = (shop.store[good] ?? 0) - qty
        return paid
      },
    })
  }
  const sellers = farms.rows
    .filter((row) => {
      if (row.owner < 0 || row.owner === buyer) return false
      if (routes.farmIds.has(row.structureId)) return true
      return deal === "market" && routes.workshopIds.has(row.structureId)
    })
    .sort((a, b) => a.structureId - b.structureId)
  for (const row of sellers) {
    if (!sellProtein(row.structureId, good) || !buyerReaches(buyer, row.structureId)) continue
    const room = spareAt(farms, row, good, targets, budget)
    if (room < producerMin) continue
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
    const price = workshopAsk(row.structureId, good, unit)
    draws.push({
      price,
      room,
      min: producerMin,
      rank: 0,
      id: row.structureId,
      book: ledger ? "both" : undefined,
      pull: (qty) => {
        const paid = payFor(wealth, buyer, row.owner, price, qty)
        row.store[good] = (row.store[good] ?? 0) - qty
        return paid
      },
    })
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
  if (pool) {
    const room = wholeLots(pool.room, WHOLESALE_MIN)
    if (room >= WHOLESALE_MIN) {
      draws.push({
        price: pool.price,
        room,
        min: WHOLESALE_MIN,
        rank: 1,
        id: -1,
        book: ledger ? "bought" : undefined,
        pull: (qty) => {
          const paid = payFor(wealth, buyer, pool.owner, pool.price, qty)
          stock[good] -= qty
          return paid
        },
      })
    }
  }
  for (const offer of freshImports(good, buyer, prices)) {
    draws.push({
      price: netImport(offer, buyer),
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 2,
      id: offer.structureId,
      book: ledger ? "bought" : undefined,
      pull: (qty) => payImport(wealth, buyer, offer, good, qty),
    })
  }
  const got = drawSources(wealth, buyer, draws, left, false, true, good)
  taken += got.taken
  spent += got.spent
  return { taken, spent }
}

/** Move purses onto the head, head first, so one retail bid can spend them. */
function pullOnto(wealth: Int32Array, head: number, funders: readonly number[], need: number) {
  let have = Math.max(0, wealth[head] ?? 0)
  for (const id of funders) {
    if (id === head || have >= need) continue
    if (id < 0 || id >= wealth.length) continue
    const extra = Math.max(0, wealth[id] ?? 0)
    const take = Math.min(extra, need - have)
    wealth[id] -= take
    wealth[head] += take
    have += take
  }
}

/** Put unspent household money back. The head pays first. */
function restorePurse(wealth: Int32Array, funders: readonly number[], snapshot: readonly number[], spent: number) {
  let left = Math.max(0, spent)
  for (let i = 0; i < funders.length; i++) {
    const id = funders[i]
    if (id < 0 || id >= wealth.length) continue
    const had = Math.max(0, snapshot[i] ?? 0)
    const pay = Math.min(had, left)
    wealth[id] = had - pay
    left -= pay
  }
}

/**
 * A failed food bid marks the household and sets a death date six months out.
 * The household keeps bidding every month. A miss before that date leaves the
 * mark in place. A miss on the date rolls death and starts another six months.
 * A filled bid clears the mark. A farmstead household is cleared instead.
 */
function markHunger(
  attempted: ReadonlySet<number>,
  short: ReadonlySet<number>,
  farmHeads: ReadonlySet<number>,
  census: Census,
  starving: Uint8Array,
  starveDue: Uint16Array,
  starveRoll: Uint8Array,
  year: number,
  month: number,
) {
  const now = (year * 12 + month) & 0xffff
  const next = (year * 12 + month + 6) & 0xffff
  for (const head of attempted) {
    const members = census.members.get(head) ?? [head]
    if (farmHeads.has(head)) {
      for (const id of members) {
        if (id < 0 || id >= starving.length) continue
        starving[id] = 0
        starveDue[id] = 0
        starveRoll[id] = 0
      }
      continue
    }
    if (short.has(head)) {
      const already = starving[head] === 1
      const due = already && starveDue[head] === now
      for (const id of members) {
        if (id < 0 || id >= starving.length) continue
        starving[id] = 1
        if (id !== head) starveDue[id] = 0
        if (due) starveRoll[id] = 1
      }
      if (!already || due) starveDue[head] = next
    } else {
      for (const id of members) {
        if (id < 0 || id >= starving.length) continue
        starving[id] = 0
        starveDue[id] = 0
        starveRoll[id] = 0
      }
    }
  }
}

/** Personal shortfalls, bought from the market after its shelves are filled. A stored good is put in the pantry. */
function settleHouseholdNeeds(
  farms: Farms,
  stock: Record<Good, number>,
  stockOwner: Partial<Record<Good, number>>,
  stockAsk: Partial<Record<Good, number>>,
  wealth: Int32Array,
  prices: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
  posts: Holding[],
  needs: readonly HouseholdNeed[],
  funders: ReadonlyMap<number, readonly number[]> = new Map(),
): Set<number> {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const short = new Set<number>()
  const pantry = (owner: number) => {
    const rows = farms.rows.filter((row) => row.owner === owner).sort((a, b) => a.structureId - b.structureId)
    return rows.find((row) => !sellsRetail(row.structureId)) ?? rows[0]
  }
  for (const need of needs) {
    if (need.hundredths <= 0) continue
    if (need.store && !pantry(need.head)) continue
    let left = need.hundredths
    if (!need.store) {
      for (const row of farms.rows) {
        if (left <= 0) break
        if (!sellsRetail(row.structureId) || row.owner !== need.head) continue
        const take = Math.min(row.store[need.good] ?? 0, left)
        row.store[need.good] -= take
        left -= take
      }
    }
    if (left <= 0) continue
    const fromShelf = need.hundredths - left
    const ids = need.food ? funders.get(need.head) : undefined
    const snapshot = ids ? ids.map((id) => (id >= 0 && id < wealth.length ? wealth[id] : 0)) : null
    let budget = 0
    if (ids && snapshot) {
      for (const had of snapshot) budget += Math.max(0, had)
      pullOnto(wealth, need.head, ids, budget)
    }
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, need.head, need.good, left, prices, targets, [], fee, "retail")
    if (bought.taken <= 0 && left > 0 && retailOffered.has(need.good)) {
      let shelf = 0
      for (const row of farms.rows) {
        if (!sellsRetail(row.structureId)) continue
        shelf += sellable(farms, row, need.good, targets)
      }
      if (shelf <= 0) retailReject.set(need.good, (retailReject.get(need.good) ?? 0) + 1)
    }
    if (ids && snapshot) {
      let after = 0
      for (const id of ids) if (id >= 0 && id < wealth.length) after += Math.max(0, wealth[id])
      restorePurse(wealth, ids, snapshot, Math.max(0, budget - after))
    }
    if (need.food && need.bare && fromShelf + bought.taken <= 0) short.add(need.head)
    if (!need.store || bought.taken <= 0) continue
    const barn = pantry(need.head)
    if (barn) barn.store[need.good] = (barn.store[need.good] ?? 0) + bought.taken
  }
  return short
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
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const deliver = (owner: number, good: Good, hundredths: number): number => {
    const barn = farms.rows.filter((row) => row.owner === owner && !marketIds.includes(row.structureId)).sort((a, b) => a.structureId - b.structureId)[0]
      ?? farms.rows.filter((row) => row.owner === owner).sort((a, b) => a.structureId - b.structureId)[0]
    if (!barn || wealth.length <= owner || hundredths <= 0) return 0
    if (marketIds.includes(barn.structureId)) return 0
    const deal = dealFor(barn.structureId)
    const want = hundredths > 0 && hundredths < RETAIL_MIN ? RETAIL_MIN : hundredths
    const prefer = inputNeeds.get(owner)?.has(good) ? "input" : produces(farms, owner) && SUPPLY_GOODS.has(good) ? "supply" : undefined
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, owner, good, want, prices, targets, marketIds, fee, deal, prefer, routes.workshopIds.has(barn.structureId) || (inputNeeds.get(owner)?.has(good) ?? false))
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
  const sellers = proteinSellers(farms)
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
      const held = sellers.held.get(owner)?.[first] ?? 0
      if (reserve <= 0 || held >= reserve) continue
      if (proteinForSale(sellers, stock, stockOwner, targets, first, owner, buyerDeal(farms, owner), prices)) continue
      const short = reserve - held
      for (const good of ["dairy", "fish"] as const) {
        if (good === first) continue
        if (!proteinForSale(sellers, stock, stockOwner, targets, good, owner, buyerDeal(farms, owner), prices)) continue
        const cap = Math.ceil((reserve * proteinTons(good)) / proteinTons(first) - 1e-6)
        const want = Math.ceil((short * proteinTons(good)) / proteinTons(first) - 1e-6)
        const gap = Math.min(want, Math.max(0, cap - (sellers.held.get(owner)?.[good] ?? 0)))
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

/** Lumber, steel parts, tools, and leather in an office pantry. A site that draws these is not buying from the town. */
const OFFICE_RESERVE: readonly Good[] = ["lumber", "steel-parts", "steel-tools", "leather"]

function addBuildUse(use: Record<Good, number>, needs: readonly { good: Good; hundredths: number; structureId?: number }[], farms?: Farms) {
  const office = emptyGoods()
  if (farms) {
    for (const row of farms.rows) {
      if (routes.kindOf.get(row.structureId) !== "construction-office") continue
      for (const good of OFFICE_RESERVE) office[good] += row.store[good] ?? 0
    }
  }
  const site = emptyGoods()
  const town = emptyGoods()
  for (const need of needs) {
    if (need.hundredths <= 0) continue
    const fromOffice = need.structureId !== undefined && routes.kindOf.get(need.structureId) === "construction-office"
    const bucket = fromOffice ? town : site
    bucket[need.good] += need.hundredths
  }
  for (const good of GOODS) {
    const covered = Math.min(site[good], office[good])
    const hundredths = site[good] - covered + town[good]
    if (hundredths > 0) use[good] += hundredths / TON / TARGET_MONTHS
  }
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
  let caravanGrain = 0
  let caravanLeather = 0
  let caravanTools = 0
  let caravanWagons = 0
  let caravanBarrels = 0
  let traderHerds = 0
  let farmSteel = 0
  let farmLeather = 0
  let farmTextiles = 0
  for (const structure of structures) {
    if (!ownedIds.has(structure.id)) continue
    if (context ? heatsHouse(structure, context.farms) : isHouse(structure) && structure.kind !== "workshop" && structure.kind !== "sawpit") fuel += 1
    if (structure.kind === "trading-post") posts += 1
    if (!structure.pending && !structure.removing && (structure.kind === "trading-post" || structure.kind === "caravan-house")) traderHerds += 1
    if (structure.kind === "caravan-house" && context?.caravanStaff?.has(structure.id)) {
      const staff = context.caravanStaff.get(structure.id) ?? 0
      caravanGrain += 5 + staff
      caravanLeather += 0.01
      caravanTools += 0.01
      caravanWagons += 0.1
      caravanBarrels += 0.05
    }
    const scale = dryFarmScale(structure, terrain, feature)
    farmSteel += FARM_STEEL_PER_THOUSAND * scale
    farmLeather += FARM_LEATHER_PER_THOUSAND * scale
    farmTextiles += FARM_TEXTILE_PER_THOUSAND * scale
  }
  const woodMonth = low < 4 ? 4 : 2
  const asking = context ? marketSale(context.farms, fuelMarkets(structures)) : {}
  if (!context || preferWood(context.prices, asking)) use.wood += fuel * woodMonth
  else use.coal += fuel * (woodMonth / 4)
  use.grain += (posts * 3) / 12 + caravanGrain / 12
  use.leather += (posts * 0.005 + caravanLeather) / 12 + farmLeather / 12
  use.textiles += farmTextiles / 12
  use["steel-tools"] += (posts * 0.005 + caravanTools) / 12 + farmSteel / 12
  use["wagon-parts"] += caravanWagons / 12
  use.barrels += caravanBarrels / 12
  use.livestock += (traderHerds * 0.15) / 12
  if (context) addShopUse(use, structures, ownedIds, context)
  if (!people) return use
  if (context?.census) {
    const census = context.census
    use.grain += (census.portionSum * 0.1) / 12
    use.fruit += (census.portionSum * 0.15) / 12
    use.vegetables += (census.portionSum * 0.15) / 12
    for (const good of GOODS) use[good] += census.protein[good] ?? 0
    use.clothing += census.clothYear / 12
    use.leather += census.leatherYear / 12
    use.spices += census.spiceYear / 12
    use.salt += census.saltYear / 12
    use.beer += census.beerYear / 12
    addBuildUse(use, context.buildNeeds ?? [], context.farms)
    return use
  }
  let scale = 0
  let spiceYear = 0
  const saltHomes = new Map<number, number>()
  const wearAges = new Map<number, number[]>()
  const orders = context?.proteinOrders
  const headOf = context?.headOf
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const saltHead = headOf ? homeHead(headOf, id) : id
    saltHomes.set(saltHead, (saltHomes.get(saltHead) ?? 0) + 1)
    const ages = wearAges.get(saltHead)
    if (ages) ages.push(people.age[id] ?? 0)
    else wearAges.set(saltHead, [people.age[id] ?? 0])
    const portion = people.age[id] <= 5 ? 0.5 : people.age[id] <= 12 ? 0.75 : 1
    scale += portion
    if (headOf && homeHead(headOf, id) === id) {
      use.beer += 0.3 / 12
      spiceYear += (SPICE_CHANCE[context?.rank?.get(id) ?? "poor"] ?? 0) * 0.1
    }
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
  let clothYear = 0
  let leatherYear = 0
  for (const [head, ages] of wearAges) {
    const standing = context?.rank?.get(head) ?? "poor"
    const wear = wearChances(ages, CLOTH_CHANCE[standing])
    clothYear += elasticRoll(wear.cloth, demandElasticity("clothing")).comfort * 0.1
    leatherYear += elasticRoll(wear.leather, demandElasticity("leather")).comfort * 0.1
  }
  use.clothing += clothYear / 12
  use.leather += leatherYear / 12
  use.spices += spiceYear / 12
  let saltYear = 0
  for (const count of saltHomes.values()) saltYear += Math.min(1, 0.02 * count) * 0.1
  use.salt += saltYear / 12
  addBuildUse(use, context?.buildNeeds ?? [], context?.farms)
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

/** Wood kept for fuel or a recipe. A farm still sells wood. An idle office sells its spare wood. */
function keepsWood(structureId: number, farms: Farms): boolean {
  const kind = routes.kindOf.get(structureId)
  if (kind === "caravan-house") return true
  if (kind === "sawpit") return true
  if (kind !== "workshop") return false
  const specialty = farms.rows.find((row) => row.structureId === structureId)?.specialty
  return specialty === "sawmill" || specialty === "smokehouse" || specialty === "creamery" || specialty === "brewer" || specialty === "cooper"
}

/** The lot a buyer can take from this barn. Zero when the barn does not sell the good. */
function lotStep(structureId: number, good: Good, farms: Farms): number {
  const kind = routes.kindOf.get(structureId)
  if (good === "wood") {
    if (kind === "farmstead") return WHOLESALE_MIN
    if (kind === "construction-office" && idleWoodOffices.has(structureId)) return WHOLESALE_MIN
    if ((kind === "workshop" || kind === "sawpit") && !keepsWood(structureId, farms)) return WHOLESALE_MIN
    return 0
  }
  if (kind === "market" || kind === "shop") return RETAIL_MIN
  if (kind === "farmstead" || kind === "workshop" || kind === "sawpit") return WHOLESALE_MIN
  return 0
}

/**
 * Local tons a wholesale buyer can take. The import pile and retail shelves are left out.
 * `bindRoutes` must already have run.
 */
function localWholesale(farms: Farms, targets: Map<number, Record<Good, number>>): Record<Good, number> {
  const stock = emptyGoods()
  for (const good of GOODS) {
    const budget = new Map<number, number>()
    let sale = 0
    const rows = farms.rows.filter((row) => lotStep(row.structureId, good, farms) >= WHOLESALE_MIN).sort((a, b) => a.structureId - b.structureId)
    for (const row of rows) {
      const office = routes.kindOf.get(row.structureId) === "construction-office"
      const raw = office ? (row.store[good] ?? 0) : spareAt(farms, row, good, targets, budget)
      if (!office) budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
      sale += wholeLots(raw, WHOLESALE_MIN)
    }
    stock[good] = sale
  }
  return stock
}

/** Months of use sitting above the reserve. A ton left of a good nobody uses is a surplus. */
function surplusMonths(hundredths: number, monthlyUse: number, reserve: number): number {
  const tons = hundredths / TON
  if (monthlyUse <= 0) return tons > 0 ? Number.POSITIVE_INFINITY : 0
  const above = tons - reserve * monthlyUse
  return above > 0 ? above / monthlyUse : 0
}

/** Keep the last twelve months of bought and sold tons and of surplus left after exports. */
function rollWorkshopYear(
  previousBought: TownTrade["bought"],
  previousSold: TownTrade["sold"],
  previousSurplus: TownTrade["surplus"],
  use: Record<Good, number>,
  farms: Farms,
  targets: Map<number, Record<Good, number>>,
  month: number,
): { bought: NonNullable<TownTrade["bought"]>; sold: NonNullable<TownTrade["sold"]>; surplus: NonNullable<TownTrade["surplus"]> } {
  const held = localWholesale(farms, targets)
  const bought: NonNullable<TownTrade["bought"]> = {}
  const sold: NonNullable<TownTrade["sold"]> = {}
  const surplus: NonNullable<TownTrade["surplus"]> = {}
  for (const good of GOODS) {
    bought[good] = [...(previousBought?.[good] ?? []), { tons: boughtTons.get(good) ?? 0, dollars: boughtDollars.get(good) ?? 0 }].slice(-12)
    sold[good] = [...(previousSold?.[good] ?? []), { tons: soldTons.get(good) ?? 0, dollars: soldDollars.get(good) ?? 0 }].slice(-12)
    const reserve = seasonReserve(good, month) ?? COVER_LONG
    surplus[good] = [...(previousSurplus?.[good] ?? []), surplusMonths(held[good] ?? 0, use[good] ?? 0, reserve)].slice(-12)
  }
  return { bought, sold, surplus }
}

/**
 * Hundredths cover can see: whole tons from a farm, workshop, or sawpit, tenths from a market or shop,
 * and whole tons of spare wood from an idle construction office. The office pantry is reserved for
 * construction. A building that burns or crafts with wood keeps that wood. A farm keeps its last ton of
 * livestock. Reserves and any remainder too small to sell stay out. `bindRoutes` must already have run.
 */
function forSaleStock(
  farms: Farms,
  pool: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
): Record<Good, number> {
  const stock = emptyGoods()
  for (const good of GOODS) {
    const budget = new Map<number, number>()
    let sale = wholeLots(pool[good] ?? 0, WHOLESALE_MIN)
    const rows = farms.rows.filter((row) => lotStep(row.structureId, good, farms) > 0).sort((a, b) => a.structureId - b.structureId)
    for (const row of rows) {
      const step = lotStep(row.structureId, good, farms)
      const office = routes.kindOf.get(row.structureId) === "construction-office"
      const raw = office ? (row.store[good] ?? 0) : spareAt(farms, row, good, targets, budget)
      if (!office) budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
      sale += wholeLots(raw, step)
    }
    stock[good] = sale
  }
  return stock
}

function isHouse(structure: Structure): boolean {
  return !structure.pending && !structure.removing && (structure.kind === "farmstead" || structure.kind === "shack" || structure.kind === "market" || structure.kind === "trading-post" || structure.kind === "caravan-house" || structure.kind === "workshop" || structure.kind === "sawpit" || structure.kind === "shop")
}

/** Sawmills and blacksmiths heat with their own waste. Every other house burns fuel. */
function heatsHouse(structure: Structure, farms: Farms): boolean {
  if (!isHouse(structure)) return false
  if (structure.kind === "sawpit") return false
  if (structure.kind !== "workshop") return true
  const specialty = farms.rows.find((row) => row.structureId === structure.id)?.specialty
  return specialty === "smokehouse"
}

/** Wood is kept when its price is a quarter of coal or less. A market ask is used when that shelf has the good. */
function preferWood(prices: Record<Good, number>, asking: Partial<Record<Good, number>> = {}): boolean {
  const price = (good: Good) => asking[good] ?? prices[good] ?? PRICE_FLOOR
  return price("wood") * 4 <= price("coal")
}

function fuelMarkets(structures: readonly Structure[], owned?: ReadonlyMap<number, Holding> | ReadonlySet<number>): number[] {
  const held = owned instanceof Map || owned instanceof Set ? owned : null
  return structures
    .filter((structure) => structure.kind === "market" && !structure.pending && !structure.removing && (!held || held.has(structure.id)))
    .map((structure) => structure.id)
}

type RecipeInput = { good: Good; hundredths: number }
type Batch = { output: Good; out: number; inputs: RecipeInput[]; cap: number }

/** Storage ceiling, in hundredths. A batch is not started when the output would pass it. */
const PILE = 30 * TON
const SAW_PILE = 100 * TON
const SAWMILL_BATCH: Batch = { output: "lumber", out: 6 * TON, inputs: [{ good: "wood", hundredths: 9 * TON }], cap: SAW_PILE }
const PARTS_BATCH: Batch = {
  output: "steel-parts",
  out: TON,
  inputs: [
    { good: "coal", hundredths: 2 * TON },
    { good: "steel", hundredths: TON },
  ],
  cap: PILE,
}
const TOOLS_BATCH: Batch = {
  output: "steel-tools",
  out: 2 * TON,
  inputs: [
    { good: "steel-parts", hundredths: TON / 2 },
    { good: "lumber", hundredths: TON / 2 },
  ],
  cap: PILE,
}
const FISH_BATCH: Batch = {
  output: "cured-fish",
  out: TON,
  inputs: [
    { good: "fish", hundredths: 2 * TON },
    { good: "wood", hundredths: 2 * TON },
    { good: "salt", hundredths: 10 },
    { good: "barrels", hundredths: 20 },
  ],
  cap: PILE,
}
const MEAT_BATCH: Batch = {
  output: "cured-meat",
  out: TON,
  inputs: [
    { good: "meat", hundredths: 2 * TON },
    { good: "wood", hundredths: 2 * TON },
    { good: "salt", hundredths: 10 },
    { good: "barrels", hundredths: 20 },
  ],
  cap: PILE,
}
/** March, April, May, September, October, and November. */
const CHEESE_CAP = PILE
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
  cap: PILE,
}
/** January, May, and September. Three tons of hides and a tenth of lime make one ton of leather. */
const TANNER_BATCH: Batch = {
  output: "leather",
  out: TON,
  inputs: [
    { good: "hide", hundredths: 3 * TON },
    { good: "lime", hundredths: 10 },
  ],
  cap: PILE,
}
const TANNER_MONTHS = new Set([0, 4, 8])
const CHEESE_MONTHS = new Set([2, 3, 4, 8, 9, 10])
/** Every month. One ton of grain and two tons of wood, or half a ton of coal, make three tons of beer. */
const BEER_CAP = PILE
const BEER_WOOD: Batch = {
  output: "beer",
  out: 3 * TON,
  inputs: [
    { good: "grain", hundredths: TON },
    { good: "wood", hundredths: 2 * TON },
  ],
  cap: BEER_CAP,
}
const BEER_COAL: Batch = {
  output: "beer",
  out: 3 * TON,
  inputs: [
    { good: "grain", hundredths: TON },
    { good: "coal", hundredths: TON / 2 },
  ],
  cap: BEER_CAP,
}

function holdShopInputs(extra: Record<Good, number>, specialty: ShopSpecialty | undefined, store: Record<Good, number> | undefined) {
  const held = (good: Good) => store?.[good] ?? 0
  const open = (batch: Batch) => held(batch.output) + batch.out <= batch.cap
  const add = (good: Good, hundredths: number) => {
    const cap = inputCap(specialty, good)
    if (cap === null) {
      extra[good] += hundredths
      return
    }
    const have = held(good) + (extra[good] ?? 0)
    extra[good] += Math.min(hundredths, Math.max(0, cap - have))
  }
  const addBatch = (batch: Batch) => {
    if (!open(batch)) return
    for (const input of batch.inputs) add(input.good, input.hundredths)
  }
  if (specialty === "sawmill") addBatch(SAWMILL_BATCH)
  if (specialty === "blacksmith") {
    addBatch(PARTS_BATCH)
    addBatch(TOOLS_BATCH)
  }
  if (specialty === "smokehouse") {
    const fishOpen = open(FISH_BATCH)
    const meatOpen = open(MEAT_BATCH)
    if (fishOpen) add("fish", 2 * TON)
    if (meatOpen) add("meat", 2 * TON)
    if (fishOpen || meatOpen) {
      add("wood", 2 * TON)
      add("salt", 10)
      add("barrels", 20)
    }
  }
  if (specialty === "creamery") addBatch(CHEESE_WOOD)
  if (specialty === "brewer") addBatch(BEER_WOOD)
  if (specialty === "cooper") addBatch(BARREL_BATCH)
  if (specialty === "tanner") addBatch(TANNER_BATCH)
}

/** A sawmill holds 100 t of wood and lumber. Every other recipe pile holds 30 t. */
function inputCap(specialty: ShopSpecialty | undefined, good: Good): number | null {
  if (!specialty) return null
  if (specialty === "sawmill" && (good === "wood" || good === "lumber")) return SAW_PILE
  const batches = SHOP_BATCHES[specialty]
  const used = batches.some((batch) => batch.output === good || batch.inputs.some((input) => input.good === good))
  return used ? PILE : null
}

const SHOP_BATCHES: Record<ShopSpecialty, Batch[]> = {
  sawmill: [SAWMILL_BATCH],
  blacksmith: [PARTS_BATCH, TOOLS_BATCH],
  smokehouse: [FISH_BATCH, MEAT_BATCH],
  creamery: [CHEESE_WOOD, CHEESE_COAL],
  brewer: [BEER_WOOD, BEER_COAL],
  cooper: [BARREL_BATCH],
  tanner: [TANNER_BATCH],
}

/** Cheapest recipe cost per ton of a workshop output, at the month's Wholesale Bought quotes. */
function outputCostPerTon(good: Good): number | null {
  let best: number | null = null
  for (const batches of Object.values(SHOP_BATCHES)) {
    for (const batch of batches) {
      if (batch.output !== good) continue
      let cost = 0
      for (const input of batch.inputs) {
        const unit = batchQuote?.[input.good] ?? PRICE_FLOOR
        cost += (unit * input.hundredths) / TON
      }
      const perTon = cost / (batch.out / TON)
      if (best === null || perTon < best) best = perTon
    }
  }
  return best
}

/** Minimum domestic price and export bid for a workshop output. Null when the good is not made by a workshop. */
function workshopFloor(good: Good): number | null {
  const cost = outputCostPerTon(good)
  if (cost === null) return null
  return Math.round(cost * WORKSHOP_MARGIN)
}

function bindFirmAsks(farms: Farms) {
  firmAsks = new Map()
  for (const row of farms.rows) if (row.ask) firmAsks.set(row.structureId, row.ask)
}

function clearFirmAsks() {
  firmAsks = new Map()
}

/** A workshop or sawpit charges its posted price, and at least 1.2 times its Bought input cost. A workshop with no price yet charges the town price. Every other barn charges the town price. */
function workshopAsk(structureId: number, good: Good, townPrice: number): number {
  const kind = routes.kindOf.get(structureId)
  if (kind !== "workshop" && kind !== "sawpit") return townPrice
  const floor = workshopFloor(good)
  const posted = firmAsks.get(structureId)?.[good] ?? townPrice
  return floor === null ? posted : Math.max(posted, floor)
}

/** Dollars per ton across the recorded months. Null when the ledger holds less than a ton. */
/** Trailing Wholesale Sold beer. Tons are converted from the stored hundredths. */
export function beerSoldYear(town: TownTrade): { tons: number; months: number } {
  const months = town.sold?.beer ?? []
  let hundredths = 0
  for (const month of months) hundredths += month.tons
  return { tons: hundredths / TON, months: months.length }
}

function ledgerAverage(months: readonly { tons: number; dollars: number }[] | undefined): number | null {
  let tons = 0
  let dollars = 0
  for (const month of months ?? []) {
    tons += month.tons
    dollars += month.dollars
  }
  if (tons < WHOLESALE_MIN) return null
  return (dollars * TON) / tons
}

/** Wholesale Bought for every good. A good with less than a ton on the ledger keeps its posted price. */
function boughtQuotes(town: TownTrade, posted: Record<Good, number>): Record<Good, number> {
  const quote = {} as Record<Good, number>
  for (const good of GOODS) quote[good] = ledgerAverage(town.bought?.[good]) ?? posted[good] ?? PRICE_FLOOR
  return quote
}

function setBatchQuote(town: TownTrade, posted: Record<Good, number>, closed: ReadonlySet<number> = new Set()) {
  batchQuote = boughtQuotes(town, posted)
  batchClosed = closed
  const months = town.sold?.beer ?? []
  let hundredths = 0
  for (const month of months) hundredths += month.tons
  beerSoldRate = months.length === 0 ? 0 : hundredths / months.length / TON
}

const CRAFT_ORDER: ShopSpecialty[] = ["sawmill", "blacksmith", "smokehouse", "creamery", "brewer", "cooper", "tanner"]

/** Finished firms of each specialty, and the households that own them. A sawpit is a sawmill. */
function craftPresence(
  structures: readonly Structure[],
  holdings: Holdings,
  farms: Farms,
): Map<ShopSpecialty, { firms: number; owners: Set<number> }> {
  const found = new Map<ShopSpecialty, { firms: number; owners: Set<number> }>(CRAFT_ORDER.map((specialty) => [specialty, { firms: 0, owners: new Set() }]))
  const ownerOf = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row.owner]))
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    const owner = ownerOf.get(structure.id)
    if (owner === undefined) continue
    const specialty = structure.kind === "sawpit" ? "sawmill" : structure.kind === "workshop" ? farms.rows.find((row) => row.structureId === structure.id)?.specialty : undefined
    const bag = specialty ? found.get(specialty) : undefined
    if (!bag) continue
    bag.firms += 1
    bag.owners.add(owner)
  }
  return found
}

/** Finished shops of each specialty, and the households that own them. */
function retailPresence(
  structures: readonly Structure[],
  holdings: Holdings,
  farms: Farms,
): Map<RetailSpecialty, { firms: number; owners: Set<number> }> {
  const found = new Map<RetailSpecialty, { firms: number; owners: Set<number> }>(RETAIL_ORDER.map((specialty) => [specialty, { firms: 0, owners: new Set() }]))
  const ownerOf = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row.owner]))
  for (const structure of structures) {
    if (structure.kind !== "shop" || structure.pending || structure.removing) continue
    const owner = ownerOf.get(structure.id)
    if (owner === undefined) continue
    const specialty = farms.rows.find((row) => row.structureId === structure.id)?.retail
    const bag = specialty ? found.get(specialty) : undefined
    if (!bag) continue
    bag.firms += 1
    bag.owners.add(owner)
  }
  return found
}

/** Keep a missing month out of the series. A year is the last twelve readings. */
function rollProfitYear(history: readonly number[] | undefined, value: number | null | undefined): number[] | undefined {
  if (value === null || value === undefined) return history && history.length > 0 ? [...history] : undefined
  return [...(history ?? []), value].slice(-12)
}

/** A month with no firm, or no average, stays out of the series. A year is the last twelve readings. */
function rollSpecialtyProfit<T extends string>(
  order: readonly T[],
  presence: Map<T, { firms: number; owners: Set<number> }>,
  previous: Partial<Record<T, number[]>> | undefined,
  profitOf: (specialty: T) => number | null | undefined,
): Partial<Record<T, number[]>> {
  const next: Partial<Record<T, number[]>> = {}
  for (const specialty of order) {
    const history = previous?.[specialty] ?? []
    const bag = presence.get(specialty)
    const profit = profitOf(specialty)
    if (!bag || bag.firms === 0 || profit === null || profit === undefined) {
      if (history.length > 0) next[specialty] = history
      continue
    }
    next[specialty] = [...history, profit].slice(-12)
  }
  return next
}

/** Append this month's average profit for farmers, traders, and every workshop or shop specialty that has a firm. A missing average is not a month. */
function rollSectorProfit(
  town: TownTrade,
  people: People,
  structures: readonly Structure[],
  holdings: Holdings,
  farms: Farms,
): {
  craftProfit: Partial<Record<ShopSpecialty, number[]>>
  retailProfit: Partial<Record<RetailSpecialty, number[]>>
  farmerProfit?: number[]
  traderProfit?: number[]
} {
  const presence = craftPresence(structures, holdings, farms)
  const shops = retailPresence(structures, holdings, farms)
  const owners = new Map<string, ReadonlySet<number>>([
    ...CRAFT_ORDER.map((specialty) => [specialty, presence.get(specialty)?.owners ?? new Set<number>()] as const),
    ...RETAIL_ORDER.map((specialty) => [specialty, shops.get(specialty)?.owners ?? new Set<number>()] as const),
  ])
  const incomes = sectorIncomes(people, householdHomes(structures, holdings.rows), owners)
  const profitOf = (specialty: string) => incomes.craft.get(specialty)
  return {
    craftProfit: rollSpecialtyProfit(CRAFT_ORDER, presence, town.craftProfit, profitOf),
    retailProfit: rollSpecialtyProfit(RETAIL_ORDER, shops, town.retailProfit, profitOf),
    farmerProfit: rollProfitYear(town.farmerProfit, incomes.farmer),
    traderProfit: rollProfitYear(town.traderProfit, incomes.trader),
  }
}

/** Missing specialties first, shuffled. Once every specialty has a firm, highest twelve-month profit first. */
function rankOpenings<T extends string>(
  order: readonly T[],
  firmsOf: (specialty: T) => number,
  historyOf: (specialty: T) => readonly number[] | undefined,
  living: number,
  seedKey: string,
): T[] {
  const rng = mulberry32(hashSeed(seedKey))
  const missing = order.filter((specialty) => firmsOf(specialty) === 0)
  if (missing.length > 0) {
    const noise = new Map(missing.map((specialty) => [specialty, rng()]))
    return [...missing].sort((a, b) => (noise.get(a) ?? 0) - (noise.get(b) ?? 0))
  }
  const scored: { specialty: T; profit: number }[] = []
  for (const specialty of order) {
    const history = historyOf(specialty) ?? []
    if (history.length < 12) continue
    const profit = history.reduce((sum, value) => sum + value, 0) / history.length
    if (profit < living * 2) continue
    scored.push({ specialty, profit })
  }
  const noise = new Map(scored.map((item) => [item.specialty, rng()]))
  scored.sort((a, b) => b.profit - a.profit || (noise.get(a.specialty) ?? 0) - (noise.get(b.specialty) ?? 0))
  return scored.map((item) => item.specialty)
}

/** Missing specialties first, shuffled. Once every specialty has a firm, highest twelve-month profit first. */
function rankCrafts(
  town: TownTrade,
  presence: Map<ShopSpecialty, { firms: number; owners: Set<number> }>,
  living: number,
  seed: string,
  year: number,
  month: number,
): ShopSpecialty[] {
  return rankOpenings(
    CRAFT_ORDER,
    (specialty) => presence.get(specialty)?.firms ?? 0,
    (specialty) => town.craftProfit?.[specialty],
    living,
    `${seed}:craft:${year}:${month}`,
  )
}

/**
 * Specialties a new workshop may draw. Any specialty with no firm is drawn before the others.
 * Once one firm of each exists, a specialty waits for twelve months of household profit and
 * drops below twice the cost of living. An occupied workshop keeps the specialty it already has.
 */
export function workshopOpening(
  town: TownTrade,
  farms: Farms,
  structures: readonly Structure[],
  holdings: Holdings,
  people: People | null,
  low: number,
  _terrain: Uint8Array,
  _feature: Uint8Array,
  lows: readonly number[],
  seed: string,
  year: number,
  urbanTile = 0,
  _shipHouses: readonly ShipHouse[] = [],
  _closedShops: ReadonlySet<number> = new Set(),
  _buildNeeds: readonly { good: Good; hundredths: number }[] = [],
  _foundedYear = year,
  month = 0,
): ShopSpecialty[] {
  if (!people) return []
  const yearLows = lows.length > 0 ? lows : [low]
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const living = costOfLiving(town.prices, yearLows, urbanTile, marketSale(farms, retailShelves(structures, owned)))
  return rankCrafts(town, craftPresence(structures, holdings, farms), living, seed, year, month)
}

/**
 * Specialties a new shop may draw. Any specialty with no firm is drawn before the others.
 * Once one firm of each exists, a specialty waits for twelve months of household profit and
 * drops below twice the cost of living. An occupied shop keeps the specialty it already has.
 */
export function shopOpening(
  town: TownTrade,
  farms: Farms,
  structures: readonly Structure[],
  holdings: Holdings,
  people: People | null,
  low: number,
  lows: readonly number[],
  seed: string,
  year: number,
  urbanTile = 0,
  month = 0,
): RetailSpecialty[] {
  if (!people) return []
  const yearLows = lows.length > 0 ? lows : [low]
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const living = costOfLiving(town.prices, yearLows, urbanTile, marketSale(farms, retailShelves(structures, owned)))
  const presence = retailPresence(structures, holdings, farms)
  return rankOpenings(
    RETAIL_ORDER,
    (specialty) => presence.get(specialty)?.firms ?? 0,
    (specialty) => town.retailProfit?.[specialty],
    living,
    `${seed}:retail-rank:${year}:${month}`,
  )
}

/** A sawpit is always a sawmill. A workshop uses the specialty rolled for it. */
function craftOf(structure: Structure, specialty: ShopSpecialty | undefined): ShopSpecialty | undefined {
  if (structure.kind === "sawpit") return "sawmill"
  return structure.kind === "workshop" ? specialty : undefined
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
  if (specialty === "brewer") return [BEER_WOOD, BEER_COAL]
  if (specialty === "cooper") return [BARREL_BATCH]
  if (specialty === "tanner") {
    if (producing && !TANNER_MONTHS.has(month)) return []
    return [TANNER_BATCH]
  }
  return [FISH_BATCH, MEAT_BATCH]
}

/** January. A wooded farm turns 50 tons of spare wood into 10 tons of coal, once, when coal pays four times wood or the wood barn is full. Heating wood is left in the barn. */
function makeCoal(
  farms: Farms,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  feature: Uint8Array,
  month: number,
  woodKeep: Map<number, number>,
  prices: Record<Good, number>,
): Set<number> {
  const made = new Set<number>()
  if (month !== 0) return made
  const woodIn = 50 * TON
  const coalPays = (prices.coal ?? PRICE_FLOOR) >= (prices.wood ?? PRICE_FLOOR) * 4
  for (const structure of [...structures].sort((a, b) => a.id - b.id)) {
    if (structure.kind !== "farmstead" || structure.pending || structure.removing || structure.tiles.length === 0) continue
    const holding = owned.get(structure.id)
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!holding || !row) continue
    const woodFull = (row.store.wood ?? 0) >= (FARM_STORE_CAP.wood ?? Number.POSITIVE_INFINITY)
    if (!coalPays && !woodFull) continue
    let woods = 0
    for (const tile of structure.tiles) {
      const kind = feature[tile]
      if (kind === Feature.Forest || kind === Feature.Woodland) woods += 1
    }
    if (woods / structure.tiles.length < 0.25) continue
    if ((row.store.wood ?? 0) < woodIn) continue
    if (barnHeld(farms, row.owner, "wood") - woodIn < (woodKeep.get(row.owner) ?? 0)) continue
    const coalRoom = Math.max(0, (FARM_STORE_CAP.coal ?? 0) - (row.store.coal ?? 0))
    if (coalRoom < 10 * TON) continue
    row.store.wood -= woodIn
    row.store.coal += 10 * TON
    made.add(row.owner)
  }
  return made
}

/** June. A vegetable farm turns 5 t of vegetables, 0.01 t of textiles, and 2 t of wood into 0.5 t of spices. */
function makeSpices(farms: Farms, structures: readonly Structure[], owned: Map<number, Holding>, month: number) {
  if (month !== 5) return
  const vegetables = 5 * TON
  const textiles = 1
  const wood = 2 * TON
  for (const structure of [...structures].sort((a, b) => a.id - b.id)) {
    if (structure.kind !== "farmstead" || structure.pending || structure.removing) continue
    const holding = owned.get(structure.id)
    const row = farms.rows.find((item) => item.structureId === structure.id)
    if (!holding || !row || !row.uses.includes("vegetables")) continue
    if ((row.store.vegetables ?? 0) < vegetables || (row.store.textiles ?? 0) < textiles || (row.store.wood ?? 0) < wood) continue
    row.store.vegetables -= vegetables
    row.store.textiles -= textiles
    row.store.wood -= wood
    row.store.spices = (row.store.spices ?? 0) + 50
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
  closedShops: ReadonlySet<number> = new Set(),
) {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  for (const structure of structures) {
    if ((structure.kind !== "workshop" && structure.kind !== "sawpit") || structure.pending || structure.removing || closedShops.has(structure.id)) continue
    const row = owned.get(structure.id)
    if (!row) continue
    const rng = mulberry32(hashSeed(`${seed}:shop-supply:${structure.id}:${year}`))
    if (rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "steel-tools", 10, prices, targets, marketIds, fee, "retail", "supply")
    const specialty = craftOf(structure, farms.rows.find((item) => item.structureId === structure.id)?.specialty)
    if (specialty === "creamery" && rng() < 0.05) buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "textiles", 10, prices, targets, marketIds, fee, "retail", "supply")
    if (specialty === "cooper") buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "fiber", 20, prices, targets, marketIds, fee, "workshop", "supply", true)
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
  closedShops: ReadonlySet<number> = new Set(),
) {
  const fee = posts.length > 0 ? feeFor(posts[0]) : 0
  const shops = structures.filter((structure) => (structure.kind === "workshop" || structure.kind === "sawpit") && !structure.pending && !structure.removing && !closedShops.has(structure.id)).sort((a, b) => a.id - b.id)
  for (const structure of shops) {
    const row = farms.rows.find((item) => item.structureId === structure.id)
    const specialty = craftOf(structure, row?.specialty)
    if (!row || !specialty || !owned.has(structure.id)) continue
    const batch = chooseBatch(optionsFor(specialty, month, true), row, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, true, marks)
    if (batch && applyInputs(batch.inputs, row.owner, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee)) {
      row.store[batch.output] = (row.store[batch.output] ?? 0) + batch.out
    }
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
  _marks?: Record<Good, number>,
): Batch | null {
  let best: { batch: Batch; margin: number } | null = null
  const quote = (good: Good) => batchQuote?.[good] ?? offerPrice(good, prices, fee)
  for (const batch of options) {
    if ((row.store[batch.output] ?? 0) + batch.out > batch.cap) continue
    const priced = priceInputs(batch.inputs, row.owner, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, allowImport)
    if (!priced) continue
    if (batch.output === "beer" && beerOverCover(row.store.beer ?? 0, batch.cap, farms, stock)) continue
    let cost = 0
    for (const input of batch.inputs) cost += Math.round((quote(input.good) * input.hundredths) / TON)
    const hurdle = Math.round((Math.round((cost * TON) / batch.out) || 0) * WORKSHOP_MARGIN)
    const posted = offerPrice(batch.output, prices, fee)
    if (batch.output !== "beer" && posted < hurdle) continue
    const revenue = Math.round((posted * batch.out) / TON)
    const margin = revenue - cost
    if (!best || margin > best.margin) best = { batch, margin }
  }
  return best?.batch ?? null
}

function addShopUse(use: Record<Good, number>, structures: readonly Structure[], ownedIds: Set<number>, context: UseContext) {
  const marketIds = structures.filter((structure) => structure.kind === "market" && ownedIds.has(structure.id)).map((structure) => structure.id).sort((a, b) => a - b)
  for (const structure of structures) {
    if ((structure.kind !== "workshop" && structure.kind !== "sawpit") || !ownedIds.has(structure.id) || context.closedShops?.has(structure.id)) continue
    const row = context.farms.rows.find((item) => item.structureId === structure.id)
    const specialty = craftOf(structure, row?.specialty)
    if (!row || !specialty) continue
    use["steel-tools"] += 0.005 / 12
    if (specialty === "creamery") use.textiles += 0.005 / 12
    if (specialty === "brewer") use.barrels += 0.05 / 12
    if (specialty === "cooper") use.fiber += 0.2 / 12
    const batch = chooseBatch(
      optionsFor(specialty, 0, false),
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
    const scale = specialty === "blacksmith" || specialty === "tanner" ? 3 / 12 : specialty === "creamery" ? 6 / 12 : 1
    for (const input of batch.inputs) use[input.good] += (input.hundredths / TON) * scale
  }
}

type SupplyLot = { price: number; hundredths: number; structureId: number | null; owner: number; min: number; postId?: number }

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
  heldRoom?: Map<number, number>,
): SupplyLot[] {
  const unit = offerPrice(good, prices, fee)
  const budget = new Map<number, number>()
  const lots: SupplyLot[] = []
  for (const row of farms.rows) {
    if (row.owner < 0 || row.owner === buyer || !sellProtein(row.structureId, good)) continue
    const market = routes.marketIds.includes(row.structureId)
    const producer = routes.farmIds.has(row.structureId) || routes.workshopIds.has(row.structureId)
    if (!market && !producer) continue
    if (producer && !buyerReaches(buyer, row.structureId)) continue
    if (producer && good === "wood" && keepsWood(row.structureId, farms)) continue
    const raw = spareAt(farms, row, good, targets, budget)
    const min = good === "wood" || good === "lumber" ? WHOLESALE_MIN : market ? RETAIL_MIN : WHOLESALE_MIN
    const room = wholeLots(raw, min)
    budget.set(row.owner, (budget.get(row.owner) ?? 0) - raw)
    if (room < min) continue
    lots.push({
      price: market ? sellPrice(row.cost?.[good] ?? unit) : workshopAsk(row.structureId, good, unit),
      hundredths: room,
      structureId: row.structureId,
      owner: row.owner,
      min,
    })
  }
  if (good === "wood") {
    for (const row of farms.rows) {
      if (!idleWoodOffices.has(row.structureId)) continue
      const room = wholeLots(row.store.wood ?? 0, WHOLESALE_MIN)
      if (room < WHOLESALE_MIN) continue
      lots.push({ price: unit, hundredths: room, structureId: row.structureId, owner: row.owner, min: WHOLESALE_MIN })
    }
  }
  const pool = poolOffer(stock, stockOwner, stockAsk, prices, good, buyer)
  if (pool) lots.push({ price: pool.price, hundredths: wholeLots(pool.room, WHOLESALE_MIN), structureId: null, owner: pool.owner, min: WHOLESALE_MIN })
  for (const offer of freshImports(good, buyer, prices, heldRoom ? (id) => heldRoom.get(id) ?? 0 : undefined)) {
    lots.push({ price: netImport(offer, buyer), hundredths: offer.room, structureId: null, owner: offer.owner, min: WHOLESALE_MIN, postId: offer.structureId })
  }
  lots.sort((a, b) => Number(a.min < TON) - Number(b.min < TON) || a.price - b.price || Number(a.postId !== undefined) - Number(b.postId !== undefined) || (a.structureId ?? 1e9) - (b.structureId ?? 1e9))
  return lots
}

/** Inputs take a whole ton when the need is shorter than the lot. */
function lotTake(left: number, lot: SupplyLot): number {
  if (left <= 0 || lot.hundredths < lot.min) return 0
  if (lot.min >= TON && left < lot.min) return lot.min
  return wholeLots(Math.min(lot.hundredths, left), lot.min)
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
  const heldRoom = new Map(inboundRoom)
  for (const input of inputs) {
    let left = input.hundredths
    const own = Math.min(ownedHeld(farms, stock, stockOwner, buyer, input.good), left)
    if (own > 0) {
      economic += Math.round((offerPrice(input.good, prices, fee) * own) / TON)
      left -= own
    }
    if (left > 0) {
      for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee, heldRoom)) {
        const take = lotTake(left, lot)
        if (take < lot.min) continue
        const dollars = Math.round((lot.price * take) / TON)
        economic += dollars
        cash += dollars
        left -= Math.min(take, left)
        if (lot.postId !== undefined) heldRoom.set(lot.postId, Math.max(0, (heldRoom.get(lot.postId) ?? 0) - take))
      }
    }
    if (left > 0 && allowImport) {
      const ask = importAsk(input.good, prices)
      if (ask) {
        const bill = Math.round((ask.price * coverLots(left, TON)) / TON)
        economic += bill
        cash += bill
        left = 0
      }
    }
    if (left > 0) return null
  }
  if (wealth.length > buyer && cash * 2 > (wealth[buyer] ?? 0)) return null
  return { economic }
}

/** Bring a short recipe up to a whole ton at the town price. The unused part stays in the barn. Returns the hundredths imported. */
function importForBatch(
  farms: Farms,
  wealth: Int32Array,
  buyer: number,
  good: Good,
  left: number,
  prices: Record<Good, number>,
  budget: number,
): number {
  const ask = importAsk(good, prices)
  if (!ask || left <= 0) return 0
  const qty = coverLots(left, TON)
  const bill = Math.round((ask.price * qty) / TON)
  if (bill > budget) return 0
  const slot = importSlots.find((item) => (inboundRoom.get(item.structureId) ?? 0) >= qty && traderOpen(buyer, item.structureId))
  if (!slot) return 0
  payImport(wealth, buyer, { structureId: slot.structureId, owner: slot.owner, price: ask.price, room: qty, fee: ask.fee }, good, qty)
  noteImportBid(good, qty / TON)
  noteLedger(good, qty, bill, "bought")
  const keep = qty - left
  if (keep > 0) {
    const barn = farms.rows.find((item) => item.owner === buyer && routes.workshopIds.has(item.structureId)) ?? farms.rows.find((item) => item.owner === buyer)
    if (barn) {
      const cap = inputCap(barn.specialty, good)
      const room = cap === null ? keep : Math.max(0, cap - (barn.store[good] ?? 0))
      const stored = Math.min(keep, room)
      if (stored > 0) barn.store[good] = (barn.store[good] ?? 0) + stored
    }
  }
  return qty
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
  let budget = Math.floor((wealth[buyer] ?? 0) / 2)
  const saved = {
    stores: farms.rows.map((row) => GOODS.map((good) => row.store[good] ?? 0)),
    stock: GOODS.map((good) => stock[good] ?? 0),
    wealth: new Int32Array(wealth),
    income: books ? new Int32Array(books.income) : null,
    log: books ? new Int32Array(books.log) : null,
    till: stateTill,
    spent: stateSpent,
    inbound: new Map(inboundRoom),
    shipments: monthShipments.length,
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
    stateSpent = saved.spent
    inboundRoom = new Map(saved.inbound)
    monthShipments.length = saved.shipments
    if (books && saved.income && saved.log) {
      books.income.set(saved.income)
      books.log.set(saved.log)
    }
  }
  for (const input of inputs) {
    let left = input.hundredths - takeOwned(farms, stock, stockOwner, buyer, input.good, input.hundredths)
    for (const lot of purchaseLots(farms, stock, stockOwner, stockAsk, buyer, input.good, prices, targets, marketIds, fee)) {
      if (wealth.length <= buyer) continue
      const take = lotTake(left, lot)
      const dollars = Math.round((lot.price * take) / TON)
      if (take < lot.min || dollars > budget || wholeLots(affordable(budget, lot.price, take), lot.min) < take) continue
      let spent = dollars
      if (lot.postId !== undefined) {
        const ask = importAsk(input.good, prices)
        if (!ask) continue
        spent = payImport(wealth, buyer, { structureId: lot.postId, owner: lot.owner, price: ask.price, room: lot.hundredths, fee: ask.fee }, input.good, take)
        noteLedger(input.good, take, spent, "bought")
      } else {
        credit(wealth, buyer, -dollars)
        credit(wealth, lot.owner, dollars)
        if (lot.structureId === null) {
          stock[input.good] -= take
          noteLedger(input.good, take, dollars, "bought")
        } else {
          const source = farms.rows.find((item) => item.structureId === lot.structureId)
          if (source) source.store[input.good] = (source.store[input.good] ?? 0) - take
          const kind = routes.kindOf.get(lot.structureId)
          if (kind === "farmstead" || kind === "workshop" || kind === "sawpit") noteLedger(input.good, take, dollars, "both")
        }
      }
      budget -= spent
      const used = Math.min(take, left)
      const keep = take - used
      if (keep > 0) {
        const barn = farms.rows.find((item) => item.owner === buyer && routes.workshopIds.has(item.structureId)) ?? farms.rows.find((item) => item.owner === buyer)
        if (barn) {
          const cap = inputCap(barn.specialty, input.good)
          const room = cap === null ? keep : Math.max(0, cap - (barn.store[input.good] ?? 0))
          const stored = Math.min(keep, room)
          if (stored > 0) barn.store[input.good] = (barn.store[input.good] ?? 0) + stored
        }
      }
      left -= used
    }
    if (left > 0) {
      const brought = importForBatch(farms, wealth, buyer, input.good, left, prices, budget)
      if (brought <= 0) {
        undo()
        return false
      }
      budget -= Math.round((importAsk(input.good, prices)?.price ?? 0) * brought / TON)
    }
  }
  return true
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

export function cheapFee(holdings: Holdings, structures: readonly Structure[], houseFeesNow: ReadonlyMap<number, number> = new Map(), allowance = 0, supplies = 0, urbanTile = 0, year = Number.POSITIVE_INFINITY, foundedYear = 0): number | null {
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  let best: number | null = null
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    const row = owned.get(structure.id)
    if (!row) continue
    let fee: number | null = null
    if (structure.kind === "trading-post") fee = postFee(allowance, supplies, urbanTile, year, foundedYear)
    else if (structure.kind === "caravan-house" && houseFeesNow.has(structure.id)) fee = houseFeesNow.get(structure.id) ?? null
    if (fee === null) continue
    if (best === null || fee < best) best = fee
  }
  return best
}
