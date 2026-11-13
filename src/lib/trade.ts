import { DEFAULT_WAGES } from "@/lib/construction"
import { monthlyCapital, type Holding, type Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import { copyIncomeLog, grantBirthdaySeeds, householdHomes, householdRanks, noteOperatingIncome, type People, type SocialClass } from "@/lib/people"
import { familyPortions, FARM_STORE_CAP, GOOD_LABEL, GOODS, SHELF_TARGET, type FarmRecord, type Farms, type Good, type ShopSpecialty } from "@/lib/produce"
import type { PropertyLine } from "@/lib/land"
import { isWater, type Structure } from "@/lib/buildings"
import { emptyRoads, pantryOrders, type RoadBook } from "@/lib/roads"
import { Feature, Terrain } from "@/lib/types"
import { assignShops, RETAIL_NAME, shopLineTarget } from "@/lib/shop"

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
/** Chance a person of 13 or older wears out 0.1 ton of clothing on the head's birthday. Leather is half of this. Under 13, clothing is half and leather is never used. */
const CLOTH_CHANCE: Record<SocialClass, number> = {
  poor: 0.02,
  working: 0.04,
  middle: 0.05,
  upper: 0.07,
  wealthy: 0.1,
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
    const spices = rank.get(id) === "upper" || rank.get(id) === "wealthy" ? 10 : 0
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
  census?: { portionSum: number; clothYear: number; leatherYear: number; spiceYear: number; beerYear: number; protein: Partial<Record<Good, number>> }
  /** Workshops still under construction. They do not draw inputs or set a price. */
  closedShops?: ReadonlySet<number>
  /** Hundredths a construction site or office still wants. Spread across three months of use. */
  buildNeeds?: readonly { good: Good; hundredths: number }[]
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
}

function closeInbound() {
  importSlots = []
  inboundRoom = new Map()
  exportedGoods = new Set()
  monthShipments = []
}

/** A trading post is open to every buyer. A caravan house uses the workshop link. */
function traderOpen(buyer: number, structureId: number): boolean {
  if (routes.kindOf.get(structureId) === "caravan-house") return buyerReaches(buyer, structureId)
  return true
}

function freshImports(good: Good, buyer: number, roomOf?: (structureId: number) => number): FreshImport[] {
  if (exportedGoods.has(good)) return []
  const foreign = WEST_EUROPE[good]
  if (!foreign || foreign.import === false) return []
  const offers: FreshImport[] = []
  const roomAt = roomOf ?? ((id: number) => inboundRoom.get(id) ?? 0)
  for (const slot of importSlots) {
    const room = wholeLots(roomAt(slot.structureId), WHOLESALE_MIN)
    if (room < WHOLESALE_MIN || !traderOpen(buyer, slot.structureId)) continue
    offers.push({ structureId: slot.structureId, owner: slot.owner, price: foreign.price + slot.fee, room, fee: slot.fee })
  }
  offers.sort((a, b) => a.price - b.price || a.structureId - b.structureId)
  return offers
}

/** What this buyer actually parts with. A trader's own fee stays home. */
function netImport(offer: FreshImport, buyer: number): number {
  return buyer === offer.owner ? offer.price - offer.fee : offer.price
}

/** The buyer pays the ask. The trader keeps the fee and the foreign price leaves in the same step. */
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
  const tons = Math.max(1, Math.round(qty / TON))
  for (let n = 0; n < tons; n++) monthShipments.push({ postId: offer.structureId, good, way: "import", dollars: offer.price })
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
  pull: (qty: number) => number
}

/** Cheapest source first. An equal price takes the local ton. An import, or a lot marked to round up, covers a short need with one whole lot. */
function drawSources(wealth: Int32Array, buyer: number, draws: readonly Draw[], left: number, exact: boolean, roundImport: boolean): { taken: number; spent: number } {
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
    spent += draw.pull(qty)
    taken += qty
    need -= qty
    if (need <= 0) break
  }
  return { taken, spent }
}

export function tradeLines(structure: Structure, holdings: Holdings, town: TownTrade, quotedFee?: number, allowance = 0, supplies = 0, urbanTile = 0, year = Number.POSITIVE_INFINITY, foundedYear = 0): PropertyLine[] {
  const trading = structure.kind === "trading-post" || (structure.kind === "caravan-house" && quotedFee !== undefined)
  if (!trading || structure.pending) return []
  const row = holdings.rows.find((item) => item.structureId === structure.id)
  if (!row || row.owner < 0) return []
  const fee = structure.kind === "caravan-house" ? quotedFee ?? 0 : postFee(allowance, supplies, urbanTile, year, foundedYear)
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
  lines.push({ label: "Sells", value: "$1 plus 10% a tenth" })
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
  const quote = quotedPrices(forSaleStock(farms, town.stock, targets), town.prices, fee, postCount, measure)
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
  installCloset(people, protein.headOf, protein.rank)
  const census = buildCensus(people, protein.headOf, protein.rank, protein.orders)
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
  const coalOwners = makeCoal(nextFarms, structures, owned, feature, month, woodKeep)
  makeSpices(nextFarms, structures, owned, month)
  const coalMakers = new Set<number>()
  for (const owner of coalOwners) coalMakers.add(homeHead(protein.headOf, owner))
  const marketIds = marketStructures(structures, owned)
  bindRoutes(structures, ownedIds)
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
  assignShops(
    nextFarms,
    structures,
    {
      monthly: use,
      prices: town.prices,
      retail: town.retail,
      farms: nextFarms,
      structures,
      size: Math.round(Math.sqrt(terrain.length)),
      stock,
    },
    wealth,
    seed,
    month,
    year,
    closedShops,
  )
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
  const short = settleHouseholdNeeds(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, foodNeeds, funders)
  buyBirthdayBeer(people, nextFarms, wealth, town.prices, census, month, year, seed, closedShops)
  if (year >= foundedYear + 5) markHunger(fed.attempted, short, farmHeads, census, starving, starveDue, starveRoll, year, month)
  const hungry = new Set<number>()
  for (let id = 0; id < starving.length; id++) if (starving[id] === 1 && homeHead(protein.headOf, id) === id) hungry.add(id)
  settleHouseholdNeeds(nextFarms, stock, stockOwner, stockAsk, wealth, town.prices, targets, posts, shopNeeds.filter((need) => farmHeads.has(need.head) || !hungry.has(need.head)))
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
      feedPost(post, nextFarms, stock, stockOwner, year, seed, house ? 0.1 : 0.05, house != null)
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
  const shopMarks = quotedPrices(forSaleStock(nextFarms, stock, targets), prices, feeNow, slots, measure)
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
  const missedExports = new Set<Good>()
  for (const post of posts) {
    const fee = feeFor(post)
    const cap = shipping.get(post.structureId)?.out ?? 1
    const rng = mulberry32(hashSeed(`${seed}:export:${post.structureId}:${year}:${month}`))
    const includePool = marketIds.length === 0
    let movedTons = 0
    while (movedTons < cap) {
      const ranked = rankedExports(nextFarms, stock, targets, fee, includePool, use).filter((good) => !missedExports.has(good) && !imported.has(good))
      if (ranked.length === 0) break
      let good: Good | null = null
      for (let miss = 0; miss < 3 && !good; miss++) {
        const open = ranked.filter((item) => !missedExports.has(item))
        if (open.length === 0) break
        const rolled = pickExport(open, rng)
        if (exportSellers(nextFarms, targets, rolled, post.structureId).length > 0) good = rolled
        else missedExports.add(rolled)
      }
      if (!good) {
        for (const candidate of fullestStock(ranked.filter((item) => !missedExports.has(item)), nextFarms, stock)) {
          if (exportSellers(nextFarms, targets, candidate, post.structureId).length > 0) {
            good = candidate
            break
          }
          missedExports.add(candidate)
        }
      }
      if (!good) break
      const sellers = exportSellers(nextFarms, targets, good, post.structureId)
      const row = sellers[Math.min(sellers.length - 1, Math.floor(rng() * sellers.length))]
      const bid = (WEST_EUROPE[good] as Quote).price - fee
      while (movedTons < cap && exportScore(exportable(nextFarms, stock, targets, good, includePool), use[good] ?? 0) > 1.1) {
        if (spareAt(nextFarms, row, good, targets, new Map()) < TON) break
        row.store[good] = (row.store[good] ?? 0) - TON
        credit(wealth, row.owner, bid)
        credit(wealth, post.owner, fee)
        exported.add(good)
        shipments.push({ postId: post.structureId, good, way: "export", dollars: bid })
        movedTons += 1
      }
    }
  }

  const desired = quotedPrices(forSaleStock(nextFarms, stock, targets), prices, feeNow, slots, measure)
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

function glidePrice(price: number, desired: number): number {
  const next = Math.round(price + 0.1 * (desired - price))
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

/** Qualifying goods with the most on hand first. An equal pile keeps the higher export score. */
function fullestStock(ranked: readonly Good[], farms: Farms, stock: Record<Good, number>): Good[] {
  const held = (good: Good) => {
    let tons = stock[good] ?? 0
    for (const row of farms.rows) tons += row.store[good] ?? 0
    return tons
  }
  return ranked
    .map((good, index) => ({ good, tons: held(good), index }))
    .sort((a, b) => b.tons - a.tons || a.index - b.index)
    .map((item) => item.good)
}

/** 40% the best score, 20% the second, 10% the third, 30% any good still listed. A missing rank joins the 30%. */
function pickExport(ranked: readonly Good[], rng: () => number): Good {
  const roll = rng()
  if (roll < 0.4) return ranked[0]
  if (roll < 0.6 && ranked.length >= 2) return ranked[1]
  if (roll < 0.7 && ranked.length >= 3) return ranked[2]
  return ranked[Math.min(ranked.length - 1, Math.floor(rng() * ranked.length))]
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
  /** Tons of spices upper and wealthy households expect to use in a year. */
  spiceYear: number
  /** Tons of beer households expect to drink in a year. Half of them buy 0.6 t. */
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
    const clothing = CLOTH_CHANCE[rank.get(head) ?? "poor"]
    if (age >= 13) {
      clothYear += clothing * 0.1
      leatherYear += clothing * 0.05
    } else clothYear += clothing * 0.05
    const pick = orders.get(head)?.[0]
    if (pick) protein[pick] = (protein[pick] ?? 0) + (portion * proteinTons(pick)) / 12
    if (id === head) {
      birthHeads[people.birthMonth[id] ?? 0].push(id)
      beerHeads += 1
      const standing = rank.get(head) ?? "poor"
      if (standing === "upper" || standing === "wealthy") spiceYear += 0.003
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
  return { headOf, rank, scale, members, birthHeads, portionSum, clothYear, leatherYear, spiceYear, beerYear: beerHeads * 0.3, protein }
}

/**
 * Personal goods are taken from the pantry in the month they are due. Food and fuel
 * are a year at a time. Clothing and leather wear out on the head's birthday.
 * Shortfalls are bought from the market after the shelves are filled.
 * A farm eats a food it grows in that crop's harvest month, and burns wood in February
 * when the holding yields it. Coal is taken in January when the kiln has run.
 * Everyone else buys in the head's birth month. Fruit or vegetables is an even
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
    let total = 0
    for (const row of farms.rows) {
      if (homeHead(headOf, row.owner) !== head) continue
      total += row.store[good] ?? 0
    }
    if (stockOwner[good] !== undefined && homeHead(headOf, stockOwner[good] ?? -1) === head) total += stock[good] ?? 0
    return total
  }
  const offered = (good: Good, buyer: number) => {
    let shelf = 0
    for (const row of farms.rows) {
      if (!sellsRetail(row.structureId) || row.owner === buyer) continue
      shelf += sellable(farms, row, good, targets)
    }
    return shelf
  }
  const canFeed = (head: number, good: Good, hundredths: number) => {
    const have = held(head, good)
    if (have >= hundredths) return true
    const short = hundredths - have
    if (offered(good, head) < short) return false
    const cost = Math.round((offerPrice(good, prices, fee) * short) / TON)
    return purseOf(head) >= cost
  }
  const onHand = (head: number, good: Good) => held(head, good) + offered(good, head)
  const eat = (head: number, good: Good, hundredths: number, food = false) => {
    if (hundredths <= 0) return
    if (food) attempted.add(head)
    let left = hundredths
    const own = (market: boolean) => {
      for (const row of farms.rows) {
        if (left <= 0) break
        if (sellsRetail(row.structureId) !== market || homeHead(headOf, row.owner) !== head) continue
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
    own(false)
    own(true)
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
    const closetRows = () => {
      const rows = farms.rows.filter((row) => homeHead(headOf, row.owner) === head).sort((a, b) => a.structureId - b.structureId)
      const home = rows.filter((row) => !sellsRetail(row.structureId))
      return home.length > 0 ? home : rows
    }
    const closetHeld = (good: Good) => closetRows().reduce((sum, row) => sum + (row.store[good] ?? 0), 0)
    const drawCloset = (good: Good, hundredths: number) => {
      let left = hundredths
      for (const row of closetRows()) {
        if (left <= 0) break
        const take = Math.min(row.store[good] ?? 0, left)
        row.store[good] -= take
        left -= take
      }
    }
    if (birthday) {
      let cloth = 0
      let leather = 0
      for (const id of census.members.get(head) ?? [head]) {
        if (people.alive[id] === 0) continue
        const rng = mulberry32(hashSeed(`${seed}:wear:${year}:${id}`))
        const chance = CLOTH_CHANCE[census.rank.get(head) ?? "poor"]
        if (people.age[id] >= 13) {
          if (rng() < chance / 2) leather += 10
          if (rng() < chance) cloth += 10
        } else if (rng() < chance / 2) cloth += 10
      }
      if (cloth > 0) drawCloset("clothing", cloth)
      if (leather > 0) drawCloset("leather", leather)
      const floor = closetFloor(census.rank.get(head) ?? "poor")
      const clothHave = closetHeld("clothing")
      const leatherHave = closetHeld("leather")
      const leatherFloor = floor + (targets.get(head)?.leather ?? 0)
      if (clothHave < floor) needs.push({ head, good: "clothing", hundredths: Math.ceil((floor - clothHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
      if (leatherHave < leatherFloor) needs.push({ head, good: "leather", hundredths: Math.ceil((leatherFloor - leatherHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
      const standing = census.rank.get(head) ?? "poor"
      if (standing === "upper" || standing === "wealthy") {
        const spice = mulberry32(hashSeed(`${seed}:spice:${year}:${head}`))
        if (spice() < 0.03) drawCloset("spices", 10)
        const spiceHave = closetHeld("spices")
        if (spiceHave < 10) needs.push({ head, good: "spices", hundredths: Math.ceil((10 - spiceHave) / RETAIL_MIN) * RETAIL_MIN, store: true })
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
      let choice = garden
      if (!bag.produced.has(garden) && !canFeed(head, garden, gardenNeed)) {
        if (canFeed(head, other, gardenNeed) || onHand(head, other) > onHand(head, garden)) choice = other
      }
      eat(head, choice, gardenNeed, true)
    }
    const protein = orders.get(head) ?? []
    const first = protein[0]
    if (first && due(first)) {
      const tons = (good: Good) => Math.round(scale * proteinTons(good) * TON)
      let choice = first
      if (!bag.produced.has(first) && !canFeed(head, first, tons(first))) {
        const fallback = protein.find((good) => good !== first && canFeed(head, good, tons(good)))
        if (fallback) choice = fallback
        else {
          let best = onHand(head, first)
          for (const good of protein) {
            const qty = onHand(head, good)
            if (qty > best) {
              best = qty
              choice = good
            }
          }
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

/** After food, on the head's birthday. A 50% roll buys 0.6 t from a brewer, or drinks it from the household's own brewery. A short pile or a short purse skips the drink. */
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
    if (mulberry32(hashSeed(`${seed}:beer:${year}:${head}`))() >= 0.5) continue
    const own = sellers.find((row) => row.owner === head && (row.store.beer ?? 0) >= BEER_LOT)
    if (own) {
      own.store.beer = (own.store.beer ?? 0) - BEER_LOT
      continue
    }
    const price = offerPrice("beer", prices, 0)
    const cost = Math.round((price * BEER_LOT) / TON)
    if (head >= wealth.length || (wealth[head] ?? 0) < cost) continue
    const seller = sellers.find((row) => row.owner !== head && (row.store.beer ?? 0) >= BEER_LOT)
    if (!seller) continue
    seller.store.beer = (seller.store.beer ?? 0) - BEER_LOT
    payFor(wealth, head, seller.owner, price, BEER_LOT)
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
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, holding.owner, "barrels", TON, prices, targets, marketIds, fee, buyerDeal(farms, holding.owner), "ton")
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

/** January. A post has a 5% chance to use 0.1 t of leather and of tools. A caravan house has a 10% chance, and also uses 0.1 t of wagon parts. */
function feedPost(post: Holding, farms: Farms, stock: Record<Good, number>, stockOwner: Partial<Record<Good, number>>, year: number, seed: string, chance: number, wagon: boolean) {
  const rng = mulberry32(hashSeed(`${seed}:supply:${post.structureId}:${year}`))
  if (rng() < chance) takeOwned(farms, stock, stockOwner, post.owner, "leather", 10)
  if (rng() < chance) takeOwned(farms, stock, stockOwner, post.owner, "steel-tools", 10)
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
) {
  const owned = takeOwned(farms, stock, stockOwner, head, good, hundredths)
  const rest = hundredths - owned
  if (rest > 0) buyGoods(farms, stock, stockOwner, stockAsk, wealth, head, good, rest, prices, targets, marketIds, fee, deal, prefer)
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
    if (!spare.has(row.owner)) spare.set(row.owner, Math.max(0, barnHeld(farms, row.owner, good) - heldBack(targets, row.owner, good)))
    const room = Math.min(row.store[good] ?? 0, spare.get(row.owner) ?? 0)
    if (room >= min) return true
  }
  if (deal !== "retail") {
    const seller = _stockOwner[good]
    if ((stock[good] ?? 0) >= WHOLESALE_MIN && seller !== undefined && seller !== buyer) return true
    if (freshImports(good, buyer).length > 0) return true
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

/** A tenth costs $1 plus 10% of the wholesale tenth, rounded to the nearest dollar. The ton price is ten of those. */
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

/** The state pays at most twice the foreign list. A good with no foreign price has no cap. */
function statePrice(good: Good, price: number): boolean {
  const foreign = WEST_EUROPE[good]
  if (!foreign) return true
  return price <= foreign.price * 2
}

/**
 * A construction buyer takes what is available. Lumber moves by the ton. Other goods
 * move by the tenth from a market, workshop, farm, or construction office. The office
 * holds nothing back and sells at a tenth over what the treasury paid. A trading
 * post or caravan house still sells whole tons. The state rounds that ton up so an
 * office can top up; a building does not buy a ton it does not need.
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
  const local = good === "lumber" ? WHOLESALE_MIN : RETAIL_MIN
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
    const kind = routes.kindOf.get(row.structureId)
    const office = kind === "construction-office"
    const price = kind === "market" || office ? sellPrice(row.cost?.[good] ?? unit) : unit
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
  for (const offer of freshImports(good, buyer)) {
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
  return drawSources(wealth, buyer, draws, left, true, roundImport)
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
    for (const row of farms.rows) {
      if (routes.kindOf.get(row.structureId) !== "caravan-house" || row.owner < 0) continue
      if (!buyerReaches(buyer, row.structureId)) continue
      const room = wholeLots(spareAt(farms, row, good, targets, budget), RETAIL_MIN)
      if (room < RETAIL_MIN) continue
      budget.set(row.owner, (budget.get(row.owner) ?? 0) - room)
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
): Draw[] {
  const draws: Draw[] = []
  for (const offer of producerOffers(farms, shop.owner, good, targets, true)) {
    draws.push({
      price: unit,
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 0,
      id: offer.row.structureId,
      pull: (qty) => {
        const paid = payFor(wealth, shop.owner, offer.row.owner, unit, qty)
        offer.row.store[good] = (offer.row.store[good] ?? 0) - qty
        rememberCost(shop, good, qty, unit)
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
  for (const offer of freshImports(good, shop.owner)) {
    const price = netImport(offer, shop.owner)
    draws.push({
      price,
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 2,
      id: offer.structureId,
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
      const draws = marketDraws(farms, stock, stockOwner, stockAsk, wealth, shop, good, prices, targets, unit)
      drawSources(wealth, shop.owner, routes.kindOf.get(shelf.id) === "shop" ? draws.filter((draw) => shopLinked(shelf.id, draw.id, good)) : draws, coverLots(pile.need, TON), false, true)
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
  return drawSources(wealth, buyer, draws, hundredths, false, true)
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
): { taken: number; spent: number } {
  let left = hundredths
  let spent = 0
  if (left <= 0 || wealth.length <= buyer) return { taken: 0, spent: 0 }
  const unit = offerPrice(good, prices, fee)
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
      tons.push({
        price: unit,
        room,
        min: WHOLESALE_MIN,
        rank: 1,
        id: row.structureId,
        roundUp: true,
        pull: (qty) => {
          const paid = payFor(wealth, buyer, row.owner, unit, qty)
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
          pull: (qty) => {
            const paid = payFor(wealth, buyer, pool.owner, pool.price, qty)
            stock[good] -= qty
            return paid
          },
        })
      }
    }
    for (const offer of freshImports(good, buyer)) {
      tons.push({
        price: netImport(offer, buyer),
        room: offer.room,
        min: WHOLESALE_MIN,
        rank: 2,
        id: offer.structureId,
        roundUp: true,
        pull: (qty) => payImport(wealth, buyer, offer, good, qty),
      })
    }
    const passes = prefer === "ton" ? [tons] : prefer === "input" ? [tons, retail] : [retail, tons]
    let taken = 0
    for (const pass of passes) {
      if (left <= 0) break
      const got = drawSources(wealth, buyer, pass, left, false, true)
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
    draws.push({
      price: unit,
      room,
      min: producerMin,
      rank: 0,
      id: row.structureId,
      pull: (qty) => {
        const paid = payFor(wealth, buyer, row.owner, unit, qty)
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
        pull: (qty) => {
          const paid = payFor(wealth, buyer, pool.owner, pool.price, qty)
          stock[good] -= qty
          return paid
        },
      })
    }
  }
  for (const offer of freshImports(good, buyer)) {
    draws.push({
      price: netImport(offer, buyer),
      room: offer.room,
      min: WHOLESALE_MIN,
      rank: 2,
      id: offer.structureId,
      pull: (qty) => payImport(wealth, buyer, offer, good, qty),
    })
  }
  const got = drawSources(wealth, buyer, draws, left, false, true)
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
    const bought = buyGoods(farms, stock, stockOwner, stockAsk, wealth, owner, good, want, prices, targets, marketIds, fee, deal, prefer)
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
    use.beer += census.beerYear / 12
    for (const need of context.buildNeeds ?? []) {
      if (need.hundredths > 0) use[need.good] += need.hundredths / TON / TARGET_MONTHS
    }
    return use
  }
  let scale = 0
  let clothYear = 0
  let leatherYear = 0
  let spiceYear = 0
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
    if (headOf && homeHead(headOf, id) === id) {
      use.beer += 0.3 / 12
      const standing = context?.rank?.get(id) ?? "poor"
      if (standing === "upper" || standing === "wealthy") spiceYear += 0.003
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
  use.clothing += clothYear / 12
  use.leather += leatherYear / 12
  use.spices += spiceYear / 12
  for (const need of context?.buildNeeds ?? []) {
    if (need.hundredths > 0) use[need.good] += need.hundredths / TON / TARGET_MONTHS
  }
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

/** A barn offers this good. A caravan house offers only its spare wood. Routes must already be bound. */
function onOffer(structureId: number, good: Good): boolean {
  const kind = routes.kindOf.get(structureId)
  if (kind === "construction-office" || kind === "market" || kind === "workshop" || kind === "sawpit" || kind === "farmstead") return true
  return kind === "caravan-house" && good === "wood"
}

/**
 * Hundredths cover can see. A reserve is met from barns that do not sell first, and only the
 * remainder on a selling barn counts. The import pile counts. `bindRoutes` must already have run.
 */
function forSaleStock(
  farms: Farms,
  pool: Record<Good, number>,
  targets: Map<number, Record<Good, number>>,
): Record<Good, number> {
  const stock = emptyGoods()
  for (const good of GOODS) {
    const offered = new Map<number, number>()
    const held = new Map<number, number>()
    for (const row of farms.rows) {
      const qty = row.store[good] ?? 0
      if (qty <= 0) continue
      held.set(row.owner, (held.get(row.owner) ?? 0) + qty)
      if (onOffer(row.structureId, good)) offered.set(row.owner, (offered.get(row.owner) ?? 0) + qty)
    }
    let sale = pool[good] ?? 0
    for (const owner of held.keys()) {
      const reserve = heldBack(targets, owner, good)
      const pile = held.get(owner) ?? 0
      const room = offered.get(owner) ?? 0
      sale += Math.max(0, Math.min(room, pile - reserve))
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

/** Best batch of each specialty that still earns money, highest monthly margin first. A blacksmith or tannery runs three months a year, a creamery six. */
function rankedSpecialties(marks: Record<Good, number>, stock: Record<Good, number>, fee: number): ShopSpecialty[] {
  const order: ShopSpecialty[] = ["sawmill", "blacksmith", "smokehouse", "creamery", "brewer", "cooper", "tanner"]
  const scored: { specialty: ShopSpecialty; margin: number }[] = []
  for (const specialty of order) {
    let top: number | null = null
    for (const batch of SHOP_BATCHES[specialty]) {
      const margin = batchQuote(batch, marks, stock, fee)
      if (margin === null || margin <= 0) continue
      if (top === null || margin > top) top = margin
    }
    if (top === null) continue
    const months = specialty === "blacksmith" || specialty === "tanner" ? 3 / 12 : specialty === "creamery" ? 6 / 12 : 1
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
  shipHouses: readonly ShipHouse[] = [],
  closedShops: ReadonlySet<number> = new Set(),
  buildNeeds: readonly { good: Good; hundredths: number }[] = [],
  foundedYear = year,
): ShopSpecialty[] {
  if (!people) return []
  const owned = new Map(holdings.rows.filter((row) => row.owner >= 0).map((row) => [row.structureId, row]))
  const ownedIds = new Set(owned.keys())
  const yearLows = lows.length > 0 ? lows : [low]
  const plan = planProtein(people, structures, owned, farms, town.prices, yearLows, terrain, feature, seed, year, town.proteinYear === year ? 1 : 0, town, urbanTile)
  const bill = tradingBill(town, yearLows, urbanTile, town.feeWage ?? 0)
  const fee = cheapFee(holdings, structures, new Map(shipHouses.map((house) => [house.structureId, house.fee])), bill.allowance, bill.supplies, bill.tile, year, foundedYear) ?? 0
  bindRoutes(structures, ownedIds)
  const posts = tradeSlots(structures, owned, shipHouses)
  const targets = stockTargets(people, structures, owned, yearLows, terrain, feature, farms, town.prices, plan, closedShops)
  installCloset(people, plan.headOf, plan.rank)
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
      closedShops,
      buildNeeds,
      caravanStaff: new Map(shipHouses.map((house) => [house.structureId, house.staff])),
    })
  const marks = quotedPrices(forSaleStock(farms, town.stock, targets), town.prices, fee, posts, measure)
  const ranked = rankedSpecialties(marks, pool, fee)
  clearCloset()
  return ranked
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

/** January. A wooded farm turns 50 tons of spare wood into 10 tons of coal, once. Heating wood is left in the barn. */
function makeCoal(
  farms: Farms,
  structures: readonly Structure[],
  owned: Map<number, Holding>,
  feature: Uint8Array,
  month: number,
  woodKeep: Map<number, number>,
): Set<number> {
  const made = new Set<number>()
  if (month !== 0) return made
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
    if (specialty === "cooper") buyNeed(farms, stock, stockOwner, stockAsk, wealth, row.owner, "fiber", 20, prices, targets, marketIds, fee, "workshop", "supply")
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
    const batch = chooseBatch(optionsFor(specialty, month, true), row, farms, stock, stockOwner, stockAsk, wealth, prices, targets, marketIds, fee, false, marks)
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
  for (const offer of freshImports(good, buyer, heldRoom ? (id) => heldRoom.get(id) ?? 0 : undefined)) {
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
      if (take < lot.min || wholeLots(affordable(wealth[buyer], lot.price, take), lot.min) < take) continue
      if (lot.postId !== undefined) {
        const foreign = WEST_EUROPE[input.good]?.price ?? lot.price
        const slotFee = importSlots.find((item) => item.structureId === lot.postId)?.fee ?? 0
        payImport(wealth, buyer, { structureId: lot.postId, owner: lot.owner, price: foreign + slotFee, room: lot.hundredths, fee: slotFee }, input.good, take)
      } else {
        const dollars = Math.round((lot.price * take) / TON)
        credit(wealth, buyer, -dollars)
        credit(wealth, lot.owner, dollars)
        if (lot.structureId === null) stock[input.good] -= take
        else {
          const source = farms.rows.find((item) => item.structureId === lot.structureId)
          if (source) source.store[input.good] = (source.store[input.good] ?? 0) - take
        }
      }
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
      undo()
      return false
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
