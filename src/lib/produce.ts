import type { PresetId } from "@/lib/climate"
import type { Structure } from "@/lib/buildings"
import type { PropertyLine } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"
import type { People } from "@/lib/people"
import { Feature, Terrain, type FeatureId } from "@/lib/types"

/**
 * Hundredths of a ton in the barn. A monthly sum may be half a hundredth,
 * and anything under a tenth of a ton is one roll for that tenth.
 */
const TENTH = 10
const TON = 100

/** Hundredths a farmstead will keep. A harvest past this is not stored. Salt and spices are not limited. */
export const FARM_STORE_CAP: Partial<Record<Good, number>> = {
  grain: 40 * TON,
  fiber: 20 * TON,
  meat: 15 * TON,
  fish: 15 * TON,
  dairy: 60 * TON,
  fruit: 20 * TON,
  vegetables: 20 * TON,
  coal: 100 * TON,
  wood: 2000 * TON,
  hide: 5 * TON,
}

export const CROPS = ["grain", "fiber", "fruit", "vegetables", "livestock"] as const
export type Crop = (typeof CROPS)[number]

export const GOODS = [
  "grain",
  "fiber",
  "fruit",
  "dried-fruit",
  "vegetables",
  "spices",
  "dairy",
  "cheese",
  "beer",
  "meat",
  "livestock",
  "hide",
  "lime",
  "wood",
  "lumber",
  "barrels",
  "fish",
  "cured-fish",
  "cured-meat",
  "leather",
  "textiles",
  "clothing",
  "coal",
  "salt",
  "steel",
  "steel-parts",
  "steel-tools",
  "wagon-parts",
] as const
export type Good = (typeof GOODS)[number]

/** One craft, rolled when a workshop is first owned and then kept. */
export type ShopSpecialty = "sawmill" | "blacksmith" | "smokehouse" | "creamery" | "brewer" | "cooper" | "tanner"

const CROP_LABEL: Record<Crop, string> = {
  grain: "Grain",
  fiber: "Fiber",
  fruit: "Fruit",
  vegetables: "Vegetables",
  livestock: "Livestock",
}

export const GOOD_LABEL: Record<Good, string> = {
  grain: "Grain",
  fiber: "Fiber",
  fruit: "Fruit",
  "dried-fruit": "Dried fruit",
  vegetables: "Vegetables",
  spices: "Spices",
  dairy: "Dairy",
  cheese: "Cheese",
  beer: "Beer",
  meat: "Meat",
  livestock: "Livestock",
  hide: "Hides",
  lime: "Lime",
  wood: "Wood",
  lumber: "Lumber",
  barrels: "Barrels",
  fish: "Fish",
  "cured-fish": "Cured fish",
  "cured-meat": "Cured meat",
  leather: "Leather",
  textiles: "Textiles",
  clothing: "Clothing",
  coal: "Coal",
  salt: "Salt",
  steel: "Steel",
  "steel-parts": "Steel parts",
  "steel-tools": "Steel tools",
  "wagon-parts": "Wagon parts",
}

const SHOP_LABEL: Record<ShopSpecialty, string> = {
  sawmill: "Sawmill",
  blacksmith: "Blacksmith",
  smokehouse: "Smokehouse",
  creamery: "Creamery",
  brewer: "Brewer",
  cooper: "Cooper",
  tanner: "Tanner",
}

/** How many equal shares the prairie is split into, including the fallow share. */
type Layout = "quarters" | "thirds" | "none"

export type FarmRecord = {
  structureId: number
  /** Person the current crop plan was rolled for. */
  owner: number
  layout: Layout
  uses: Crop[]
  /** Augusts since the fruit quarter was planted. −1 when the plan has no fruit. */
  fruitAge: number
  /** Prairie tiles counted at settlement, then again each February after clearing. */
  prairie: number
  /** Average fertility of those prairie tiles. Absent until the first February. */
  fertility?: number
  /** Hundredths of a ton sitting in the barn. */
  store: Record<Good, number>
  /** Dollars per ton the market paid for goods it is holding to resell. */
  cost?: Partial<Record<Good, number>>
  /** Hundredths an earlier month set aside to export. The next trade month returns them to the barn. */
  trade?: Partial<Record<Good, number>>
  /** Set once, the first month a workshop has an owner. */
  specialty?: ShopSpecialty
  /** Set once, the first month an open shop can afford a specialty. */
  retail?: "baker" | "grocer" | "butcher" | "hardware" | "draper"
  /** Large refill still short of half the shelf. A split delivery adds to `got` and scores once. */
  shelfEpisode?: Partial<Record<Good, { got: number; scored: boolean; debut: boolean }>>
  /** This good has already been lifted above half, so a later large refill can score. */
  shelfReady?: Partial<Record<Good, true>>
  /** This month's harvest that did not fit. The household can eat it without lowering the pile. */
  surplus?: Partial<Record<Good, number>>
}

export type Farms = { rows: FarmRecord[] }

type OwnerRow = { structureId: number; owner: number }

const FEBRUARY = 1
const APRIL = 3
const MAY = 4
const JULY = 6
const AUGUST = 7
const OCTOBER = 9
const NOVEMBER = 10
/** Forest above this count can be cut. Woodland takes twice as many tiles. */
const FOREST_CLEAR = 180
const WOODLAND_CLEAR = FOREST_CLEAR * 2
/** Hundredths. One farmstead's fish for the year. */
const FISH_CAP = 1500

const FIELD_CROPS: Crop[] = ["grain", "fiber", "fruit", "vegetables"]
const GARDEN_CROPS: Crop[] = ["fiber", "fruit", "vegetables"]
const PASTURES: Crop[] = ["livestock"]

export function emptyFarms(): Farms {
  return { rows: [] }
}

/** Hundredths. A house opens with half a ton of grain, vegetables, and fruit, 2 tons of dairy, and 20 tons of wood. */
const HOUSEHOLD_START: Partial<Record<Good, number>> = {
  grain: 50,
  vegetables: 50,
  fruit: 50,
  dairy: 200,
  wood: 2000,
}

/**
 * Hundredths. A trading post opens with one year of supplies: 3 t grain,
 * 0.01 t leather, and 0.01 t steel tools. Each tool and leather use is a 5% chance of 0.1 t,
 * and a year under a hundredth is rounded up to one. The post also opens with 3 t of livestock.
 */
const BUSINESS_YEAR: Partial<Record<Good, number>> = {
  grain: 300,
  leather: 1,
  "steel-tools": 1,
  livestock: 300,
}

/** Hundredths a market keeps on the shelf. One refill a month, in whole tons. */
export const SHELF_TARGET: Partial<Record<Good, number>> = {
  grain: 400,
  fruit: 500,
  vegetables: 500,
  meat: 200,
  fish: 200,
  dairy: 400,
  clothing: 100,
  leather: 100,
  "steel-tools": 100,
  salt: 100,
  "steel-parts": 100,
  textiles: 100,
}

/**
 * Dollars per ton the opening shelf is treated as having cost.
 * Foreign list price, with no trading fee. Fruit and vegetables have no list price.
 * Meat, fish, and dairy use the same local caps as the town quote.
 */
const SHELF_OPEN_COST: Partial<Record<Good, number>> = {
  grain: 180,
  fruit: 45,
  vegetables: 40,
  meat: 200,
  fish: 100,
  dairy: 30,
  clothing: 700,
  leather: 900,
  "steel-tools": 850,
  salt: 90,
  "steel-parts": 1500,
  textiles: 550,
}

function isHousehold(kind: Structure["kind"]): boolean {
  return kind === "farmstead" || kind === "shack" || kind === "market" || kind === "trading-post" || kind === "caravan-house" || kind === "workshop" || kind === "sawpit" || kind === "shop"
}

function isBusiness(kind: Structure["kind"]): boolean {
  return kind === "market" || kind === "workshop" || kind === "trading-post" || kind === "caravan-house" || kind === "sawpit" || kind === "shop"
}

function emptyStore(): Record<Good, number> {
  const store = {} as Record<Good, number>
  for (const good of GOODS) store[good] = 0
  return store
}

/** Climate specialty weighs twice as much as each other legal crop. Livestock does not change the soil any less than the old pastures. */
export function chooseUses(
  prairieCount: number,
  average: number,
  preset: PresetId,
  rng: () => number,
): { layout: Layout; uses: Crop[] } {
  if (prairieCount >= 150) {
    return {
      layout: "quarters",
      uses: ["grain", pick(GARDEN_CROPS, preset, rng), pick(PASTURES, preset, rng)],
    }
  }
  if (prairieCount >= 50) {
    if (average < 70) return { layout: "thirds", uses: [pick(PASTURES, preset, rng), pick(FIELD_CROPS, preset, rng)] }
    return { layout: "thirds", uses: ["grain", pick(GARDEN_CROPS, preset, rng)] }
  }
  if (prairieCount > 0) return { layout: "thirds", uses: pickTwo(FIELD_CROPS, preset, rng) }
  return { layout: "none", uses: [] }
}

function specialty(preset: PresetId): ReadonlySet<Crop> {
  if (preset === "mediterranean") return new Set(["fruit"])
  if (preset === "marine-west-coast") return new Set(["livestock"])
  if (preset === "humid-continental") return new Set(["grain"])
  if (preset === "tropical-savanna") return new Set(["fiber"])
  if (preset === "humid-subtropical") return new Set(["grain", "fiber"])
  return new Set()
}

/** Added to the fertility reading for this product only. 50 fertility and +20 pay at 0.70, and the sum may pass 100. */
function climateBonus(preset: PresetId, good: Good): number {
  if (preset === "mediterranean" && good === "fruit") return 20
  if (preset === "marine-west-coast" && (good === "livestock" || good === "dairy")) return 20
  if (preset === "humid-continental" && good === "grain") return 20
  if (preset === "tropical-savanna" && good === "fiber") return 20
  if (preset === "humid-subtropical" && (good === "grain" || good === "fiber")) return 10
  return 0
}

const GARDEN_WEIGHT: Partial<Record<Crop, number>> = { fiber: 40, fruit: 20, vegetables: 20 }

function pick(options: readonly Crop[], preset: PresetId, rng: () => number, taken: readonly Crop[] = []): Crop {
  const favored = specialty(preset)
  const open = options.filter((crop) => !taken.includes(crop))
  const garden = open.every((crop) => crop === "fiber" || crop === "fruit" || crop === "vegetables")
  const weights = open.map((crop) => (garden ? (GARDEN_WEIGHT[crop] ?? 0) + (favored.has(crop) ? 20 : 0) : favored.has(crop) ? 2 : 1))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = rng() * total
  for (let i = 0; i < open.length; i++) {
    roll -= weights[i]
    if (roll < 0) return open[i]
  }
  return open[open.length - 1]
}

function pickTwo(options: readonly Crop[], preset: PresetId, rng: () => number): Crop[] {
  const first = pick(options, preset, rng)
  return [first, pick(options, preset, rng, [first])]
}

function improvesSoil(layout: Layout, uses: readonly Crop[]): boolean {
  if (layout === "quarters") return true
  return layout === "thirds" && uses.some((crop) => crop === "livestock")
}

/**
 * Harvest this calendar month. Prairie count, fertility, and crop choice are taken in February, after clearing.
 * A farm settled later in the year has no crops until the next February.
 * Forest is cleared above 180 tiles and woodland above 360. Two cut-points are spent,
 * woodland first at one point and forest at two. One wetland tile is drained every year.
 * A farmstead's April fish haul stops at 15 tons. Salt is taken in that same month.
 */
type Land = { feature: Uint8Array; fertility: Uint8Array; changed: boolean }

/** A trading post left empty by a move into a caravan house. Its barn is added to that house. */
function carriedPantry(
  farms: Farms,
  structures: readonly Structure[],
  ownerOf: Map<number, number>,
  idMap: Int32Array | null,
): Map<number, Record<Good, number>> {
  const kindOf = new Map(structures.map((structure) => [structure.id, structure.kind]))
  const into = new Map<number, Record<Good, number>>()
  for (const row of farms.rows) {
    if (kindOf.get(row.structureId) !== "trading-post") continue
    if ((ownerOf.get(row.structureId) ?? -1) >= 0) continue
    let head = row.owner
    if (idMap && head >= 0) head = head < idMap.length ? idMap[head] : -1
    if (head < 0) continue
    const house = structures.find((structure) => structure.kind === "caravan-house" && !structure.removing && (ownerOf.get(structure.id) ?? -1) === head)
    if (!house) continue
    const bag = into.get(house.id) ?? emptyStore()
    for (const good of GOODS) bag[good] += row.store[good] ?? 0
    into.set(house.id, bag)
  }
  return into
}

export function workFarms(
  farms: Farms,
  structures: readonly Structure[],
  owners: readonly OwnerRow[],
  terrain: Uint8Array,
  featureIn: Uint8Array,
  fertilityIn: Uint8Array,
  preset: PresetId,
  month: number,
  year: number,
  seed: string,
  idMap: Int32Array | null = null,
  aridity = 99,
  openingRanks: readonly ShopSpecialty[] = [],
  wealth: Int32Array | null = null,
  buildReserve: (structureId: number) => number = () => 0,
): { farms: Farms; feature: Uint8Array; fertility: Uint8Array; changedLand: boolean } {
  const ownerOf = new Map(owners.map((row) => [row.structureId, row.owner]))
  const standing = structures.filter((structure) => {
    if (structure.removing) return false
    if (structure.pending) return structure.kind === "caravan-house" && (ownerOf.get(structure.id) ?? -1) >= 0
    return structure.kind === "farmstead" || structure.kind === "shack" || structure.kind === "construction-office" || isBusiness(structure.kind)
  })
  const land: Land = { feature: featureIn, fertility: fertilityIn, changed: false }
  const writeLand = () => {
    if (land.changed) return
    land.feature = new Uint8Array(featureIn)
    land.fertility = new Uint8Array(fertilityIn)
    land.changed = true
  }

  const carried = carriedPantry(farms, structures, ownerOf, idMap)
  const rows: FarmRecord[] = []
  for (const structure of standing) {
    const owner = ownerOf.get(structure.id) ?? -1
    const previous = farms.rows.find((row) => row.structureId === structure.id)
    let record: FarmRecord | null = previous
      ? { ...previous, uses: [...previous.uses], store: { ...emptyStore(), ...previous.store }, trade: previous.trade ? { ...previous.trade } : undefined }
      : null
    if (record) {
      for (const good of GOODS) if (!Number.isFinite(record.store[good])) record.store[good] = 0
    }
    if (record && idMap && record.owner >= 0) record.owner = record.owner < idMap.length ? idMap[record.owner] : -1
    if (owner < 0) {
      if (structure.kind === "construction-office") {
        if (!record) record = stockRecord(structure, -1, seed)
        rows.push(record)
      } else if (record) rows.push(record)
      continue
    }
    if (!record) record = structure.kind === "farmstead" ? rollRecord(structure, land, preset, owner, seed, year, month) : stockRecord(structure, owner, seed)
    if (structure.kind === "sawpit" && !record.specialty) record.specialty = "sawmill"
    if (structure.kind === "workshop" && !record.specialty) {
      const purse = wealth && owner >= 0 && owner < wealth.length ? wealth[owner] ?? 0 : 0
      const cash = purse - Math.max(0, buildReserve(structure.id))
      const affordable = openingRanks.filter((specialty) => canFoundShop(specialty, cash))
      record.specialty = pickShopSpecialty(affordable, structure.id, seed, year, month) ?? rollSpecialty(structure.id, seed, cash) ?? undefined
    }
    if (structure.kind !== "farmstead") {
      record.owner = owner
      const brought = carried.get(structure.id)
      if (brought) for (const good of GOODS) record.store[good] = (record.store[good] ?? 0) + brought[good]
      rows.push(record)
      continue
    }
    record.owner = owner
    const harvest = monthWork(structure, record, terrain, land, preset, month, year, seed, writeLand, aridity)
    rows.push(harvest.record)
  }
  return { farms: { rows }, feature: land.feature, fertility: land.fertility, changedLand: land.changed }
}

function rollRecord(
  structure: Structure,
  land: Land,
  _preset: PresetId,
  owner: number,
  _seed: string,
  _year: number,
  _month: number,
): FarmRecord {
  const prairie = tilesWhere(structure.tiles, land.feature, Feature.Prairie)
  return {
    structureId: structure.id,
    owner,
    layout: "none",
    uses: [],
    fruitAge: -1,
    prairie: prairie.length,
    store: openingStore(structure.kind),
  }
}

function stockRecord(structure: Structure, owner: number, _seed: string): FarmRecord {
  return {
    structureId: structure.id,
    owner,
    layout: "none",
    uses: [],
    fruitAge: -1,
    prairie: 0,
    store: openingStore(structure.kind),
    cost: structure.kind === "market" ? { ...SHELF_OPEN_COST } : undefined,
  }
}

/** 45% the best monthly margin, 25% the second, 15% the third, and the rest split across whatever is left. Fewer than four drop the empty slots and rescale. */
export function pickShopSpecialty(
  ranked: readonly ShopSpecialty[],
  structureId: number,
  seed: string,
  year: number,
  month: number,
): ShopSpecialty | null {
  if (ranked.length === 0) return null
  const rng = mulberry32(hashSeed(`${seed}:shop:${structureId}:${year}:${month}`))
  const roll = rng()
  const raw = ranked.map((_, index) => {
    if (ranked.length >= 4 && index >= 3) return 0.15 / (ranked.length - 3)
    return [0.45, 0.25, 0.15, 0.15][index] ?? 0
  })
  const total = raw.reduce((sum, weight) => sum + weight, 0)
  let cursor = 0
  for (let index = 0; index < ranked.length; index++) {
    cursor += raw[index] / total
    if (roll < cursor) return ranked[index]
  }
  return ranked[ranked.length - 1]
}

const SHOP_PURSE: Record<ShopSpecialty, number> = {
  sawmill: 1000,
  blacksmith: 5000,
  smokehouse: 1000,
  creamery: 1000,
  brewer: 1000,
  cooper: 1000,
  tanner: 1000,
}

function canFoundShop(specialty: ShopSpecialty, cash: number): boolean {
  return cash >= SHOP_PURSE[specialty]
}

function rollSpecialty(id: number, seed: string, cash: number): ShopSpecialty | null {
  const kinds = (["sawmill", "blacksmith", "smokehouse", "creamery", "brewer", "cooper", "tanner"] as const).filter((kind) => canFoundShop(kind, cash))
  if (kinds.length === 0) return null
  const roll = mulberry32(hashSeed(`${seed}:shop:${id}`))()
  return kinds[Math.min(kinds.length - 1, Math.floor(roll * kinds.length))]
}

/** Hundredths of a ton. Nested: under 0.5, under 1.0, then under 1.2. */
function saltFromAridity(aridity: number): number {
  if (aridity < 0.5) return 10
  if (aridity < 1) return 5
  if (aridity < 1.2) return 2
  return 0
}

function openingStore(kind: Structure["kind"]): Record<Good, number> {
  const store = emptyStore()
  if (isHousehold(kind) && kind !== "workshop" && kind !== "shop") {
    for (const good of GOODS) store[good] += HOUSEHOLD_START[good] ?? 0
  }
  if (kind === "trading-post") {
    for (const good of GOODS) store[good] += BUSINESS_YEAR[good] ?? 0
  }
  if (kind === "caravan-house") {
    store.grain += 500
    store.leather += 1
    store["steel-tools"] += 1
    store["wagon-parts"] += 10
    store.barrels += 100
  }
  if (kind === "farmstead") {
    store.leather += 10
    store.textiles += 10
    store["steel-tools"] += 10
  }
  if (kind === "sawpit") store["steel-tools"] += 10
  if (kind === "market") {
    for (const good of GOODS) {
      const target = SHELF_TARGET[good]
      if (target) store[good] = Math.max(store[good], target)
    }
  }
  return store
}

function monthWork(
  structure: Structure,
  record: FarmRecord,
  terrain: Uint8Array,
  land: Land,
  preset: PresetId,
  month: number,
  year: number,
  seed: string,
  writeLand: () => void,
  aridity = 99,
): { record: FarmRecord } {
  const next = record
  if (!Number.isFinite(next.prairie)) next.prairie = 0
  next.uses = withLivestock(next.uses)
  const feature = () => land.feature
  const bucket = emptyStore()

  if (month === 0 && improvesSoil(next.layout, next.uses)) {
    writeLand()
    for (const tile of tilesWhere(structure.tiles, feature(), Feature.Prairie)) {
      if (land.fertility[tile] < 80) land.fertility[tile] += 1
    }
  }

  if (month === FEBRUARY) {
    const woodland = structure.tiles.filter((tile) => feature()[tile] === Feature.Woodland)
    const forest = structure.tiles.filter((tile) => feature()[tile] === Feature.Forest)
    const cut = new Set<number>()
    const openWood = woodland.length > WOODLAND_CLEAR ? woodland : []
    const openForest = forest.length > FOREST_CLEAR ? forest : []
    let points = 2
    while (points >= 1 && openWood.length > 0) {
      cut.add(openWood.shift() as number)
      points -= 1
    }
    if (points >= 2 && openForest.length > 0) cut.add(openForest.shift() as number)
    for (const tile of structure.tiles) {
      if (cut.has(tile)) continue
      if (feature()[tile] === Feature.Woodland) bucket.wood += 10
      else if (feature()[tile] === Feature.Forest) bucket.wood += 20
    }
    for (const tile of cut) bucket.wood += feature()[tile] === Feature.Forest ? 500 : 200
    const wetland = structure.tiles.filter((tile) => feature()[tile] === Feature.Wetland)
    if (cut.size > 0 || wetland.length > 0) writeLand()
    for (const tile of cut) land.feature[tile] = Feature.Prairie
    if (wetland.length > 0) land.feature[wetland[0]] = Feature.Prairie
    if (next.fruitAge === 34) {
      bucket.wood += cropShare(next.prairie, next.uses.length) * 200
      next.fruitAge = 0
    }
    const prairie = tilesWhere(structure.tiles, feature(), Feature.Prairie)
    next.prairie = prairie.length
    next.fertility = averageFertility(prairie, land.fertility)
    if (next.uses.length === 0) {
      const rng = mulberry32(hashSeed(`${seed}:crops:${structure.id}:${year}:${month}:${next.owner}`))
      const chosen = chooseUses(next.prairie, next.fertility, preset, rng)
      next.layout = chosen.layout
      next.uses = chosen.uses
      next.fruitAge = chosen.uses.includes("fruit") ? 0 : -1
    }
  }

  const average = next.fertility
  const count = average === undefined ? 0 : cropShare(next.prairie, next.uses.length)
  if (average !== undefined && count > 0) {
    for (let slot = 0; slot < next.uses.length; slot++) {
      const crop = next.uses[slot]
      if (crop === "grain" && month === OCTOBER) pile(bucket, "grain", count, 5, average, preset)
      if (crop === "fiber" && month === OCTOBER) {
        pile(bucket, "fiber", count, 2, average, preset)
        pile(bucket, "grain", count, 1, average, preset)
      }
      if (crop === "vegetables" && month === JULY) pile(bucket, "vegetables", count, 20, average, preset)
      if (crop === "fruit" && month === AUGUST && next.fruitAge >= 3 && next.fruitAge <= 33) {
        pile(bucket, "fruit", count, 20, average, preset)
      }
    }
  }
  if (average !== undefined) tendHerd(next, bucket, count, average, preset, month)

  if (month === AUGUST) {
    for (const tile of structure.tiles) if (feature()[tile] === Feature.Woodland) bucket.fruit += 0.5
    if (next.uses.includes("fruit") && next.fruitAge >= 0 && next.fruitAge < 34) next.fruitAge += 1
  }
  if (month === JULY) {
    for (const tile of structure.tiles) if (feature()[tile] === Feature.Forest) bucket.vegetables += 0.5
  }
  if (month === NOVEMBER) {
    for (const tile of structure.tiles) {
      if (feature()[tile] === Feature.Woodland) {
        bucket.meat += 0.1
        bucket.hide += 0.1
      } else if (feature()[tile] === Feature.Forest) {
        bucket.meat += 0.1
        bucket.hide += 0.1
      } else if (feature()[tile] === Feature.Wetland) bucket.meat += 0.1
    }
  }
  if (month === OCTOBER) {
    for (const tile of structure.tiles) if (feature()[tile] === Feature.Wetland) bucket.fiber += 0.2
  }
  if (month === APRIL) {
    let sea = false
    for (const tile of structure.tiles) {
      if (terrain[tile] === Terrain.Sea) {
        bucket.fish += 10
        sea = true
      } else if (terrain[tile] === Terrain.Fresh) bucket.fish += 5
    }
    if (bucket.fish > FISH_CAP) bucket.fish = FISH_CAP
    if (sea) next.store.salt += saltFromAridity(aridity)
  }

  const rng = mulberry32(hashSeed(`${seed}:harvest:${structure.id}:${year}:${month}`))
  const surplus: Partial<Record<Good, number>> = {}
  for (const good of GOODS) {
    const gained = keep(bucket[good], rng)
    if (gained <= 0) continue
    const cap = FARM_STORE_CAP[good]
    if (cap === undefined) {
      next.store[good] += gained
      continue
    }
    const room = Math.max(0, cap - (next.store[good] ?? 0))
    const kept = Math.min(gained, room)
    next.store[good] += kept
    if (gained > kept) surplus[good] = gained - kept
  }
  next.surplus = surplus
  return { record: next }
}

/** A saved meat or dairy plan is one livestock share. */
function withLivestock(uses: readonly string[]): Crop[] {
  const kept: Crop[] = []
  let herd = false
  for (const crop of uses) {
    if (crop === "dairy" || crop === "meat" || crop === "livestock") {
      herd = true
      continue
    }
    if ((CROPS as readonly string[]).includes(crop) && !kept.includes(crop as Crop)) kept.push(crop as Crop)
  }
  if (herd) kept.push("livestock")
  return kept
}

/** May milks the herd already on hand. November adds births and slaughters only what does not fit. */
function tendHerd(record: FarmRecord, bucket: Record<Good, number>, tiles: number, average: number, preset: PresetId, month: number) {
  if (!record.uses.includes("livestock")) return
  const areas = Math.round(tiles / 40)
  const factor = (good: Good) => (average + climateBonus(preset, good)) / 100
  if (month === MAY) bucket.dairy += (record.store.livestock ?? 0) * 5 * factor("dairy")
  if (month !== NOVEMBER || tiles <= 0) return
  const born = areas * 0.5 * factor("livestock") * TON
  const cap = (1 + areas) * TON
  const room = Math.max(0, cap - (record.store.livestock ?? 0))
  const kept = Math.min(born, room)
  record.store.livestock = (record.store.livestock ?? 0) + kept
  const slaughtered = born - kept
  bucket.meat += slaughtered * 0.8
  bucket.hide += slaughtered * 0.1
}

function pile(bucket: Record<Good, number>, good: Good, count: number, perTile: number, average: number, preset: PresetId) {
  const factor = (average + climateBonus(preset, good)) / 100
  bucket[good] += perTile * count * factor
}

/** Sums under a tenth of a ton are one roll for that tenth. Larger sums are whole hundredths. */
function keep(amount: number, rng: () => number): number {
  if (amount <= 0) return 0
  if (amount >= TENTH) return Math.round(amount)
  return rng() < amount / TENTH ? TENTH : 0
}

function tilesWhere(tiles: readonly number[], feature: Uint8Array, kind: FeatureId): number[] {
  const found: number[] = []
  for (const tile of tiles) if (feature[tile] === kind) found.push(tile)
  return found
}

function averageFertility(tiles: readonly number[], fertility: Uint8Array): number {
  if (tiles.length === 0) return 0
  let sum = 0
  for (const tile of tiles) sum += fertility[tile]
  return sum / tiles.length
}

/** Each crop's tile count. The leftover share stays fallow. */
function cropShare(prairie: number, uses: number): number {
  if (prairie <= 0 || uses <= 0) return 0
  return Math.floor(prairie / (uses + 1))
}

export function productionLines(
  structure: Structure,
  farms: Farms,
  people: People | null,
): PropertyLine[] {
  if (structure.kind === "construction-office") return supplyLines(structure, farms)
  if (structure.pending) return []
  const record = farms.rows.find((row) => row.structureId === structure.id)
  if (!record || record.owner < 0) return []
  const lines: PropertyLine[] = []
  if (record.specialty) lines.push({ label: "Specialty", value: SHOP_LABEL[record.specialty] })
  if (structure.kind === "farmstead") {
    lines.push({ label: "Prairie tiles", value: `${record.prairie ?? 0}` })
    lines.push({
      label: "Avg. fertility",
      value: record.fertility === undefined ? "—" : record.fertility.toLocaleString("en-US", { maximumFractionDigits: 1 }),
    })
    lines.push({ label: "Crops", value: record.uses.length > 0 ? [...record.uses.map((crop) => CROP_LABEL[crop]), "Fallow"].join(", ") : "No prairie crops" })
    if (record.fruitAge >= 0) lines.push({ label: "Orchard", value: record.fruitAge === 34 ? "Year 34, wood in February" : `Year ${record.fruitAge}` })
  }
  for (const good of GOODS) {
    if (record.store[good] <= 0) continue
    lines.push({ label: GOOD_LABEL[good], value: formatTons(record.store[good]) })
  }
  if (people) lines.push({ label: "Yearly need", value: yearlyNeed(people, record.owner) })
  return lines
}

/** The office pantry. Empty until construction supplies are stocked. */
function supplyLines(structure: Structure, farms: Farms): PropertyLine[] {
  const record = farms.rows.find((row) => row.structureId === structure.id)
  const lines: PropertyLine[] = []
  if (record) {
    for (const good of GOODS) {
      if ((record.store[good] ?? 0) <= 0) continue
      lines.push({ label: GOOD_LABEL[good], value: formatTons(record.store[good]) })
    }
  }
  if (lines.length === 0) lines.push({ label: "Supplies", value: "None" })
  return lines
}

/** The owner's living household: self, a living spouse, and their unmarried children. */
export function familyPortions(people: People, owner: number): { scale: number; adults: number; children: number } {
  const empty = { scale: 0, adults: 0, children: 0 }
  if (owner < 0 || owner >= people.age.length || people.alive[owner] === 0) return empty
  const mate = people.spouse[owner]
  const spouse = mate >= 0 && mate < people.alive.length && people.alive[mate] !== 0 ? mate : -1
  const members = [owner]
  if (spouse >= 0) members.push(spouse)
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0 || i === owner || i === spouse || people.spouse[i] >= 0) continue
    const mother = people.mother[i]
    const father = people.father[i]
    if (mother === owner || father === owner || (spouse >= 0 && (mother === spouse || father === spouse))) members.push(i)
  }
  let scale = 0
  let adults = 0
  let children = 0
  for (const id of members) {
    const age = people.age[id] ?? 0
    scale += portion(age)
    if (age >= 13) adults += 1
    else children += 1
  }
  return { scale, adults, children }
}

function yearlyNeed(people: People, owner: number): string {
  const family = familyPortions(people, owner)
  if (family.scale <= 0) return "—"
  return `${formatNeed(family.scale * 0.1)} meat or fish, or ${formatNeed(family.scale * 0.4)} dairy · ${formatNeed(family.scale * 0.3)} fruit or vegetables · ${formatNeed(family.scale * 0.1)} grain`
}

function portion(age: number): number {
  if (age <= 5) return 0.5
  if (age <= 12) return 0.75
  return 1
}

export function formatTons(hundredths: number): string {
  const tons = hundredths / 100
  return `${tons.toLocaleString("en-US", { maximumFractionDigits: 2 })} t`
}

function formatNeed(tons: number): string {
  return `${tons.toLocaleString("en-US", { maximumFractionDigits: 3 })} t`
}
