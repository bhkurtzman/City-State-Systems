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

export const CROPS = ["grain", "fiber", "fruit", "vegetables", "dairy", "meat"] as const
export type Crop = (typeof CROPS)[number]

export const GOODS = [
  "grain",
  "fiber",
  "fruit",
  "dried-fruit",
  "vegetables",
  "dairy",
  "cheese",
  "meat",
  "hide",
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
] as const
export type Good = (typeof GOODS)[number]

/** One craft, rolled when a workshop is first owned and then kept. */
export type ShopSpecialty = "sawmill" | "blacksmith" | "smokehouse" | "creamery" | "cooper"

const CROP_LABEL: Record<Crop, string> = {
  grain: "Grain",
  fiber: "Fiber",
  fruit: "Fruit",
  vegetables: "Vegetables",
  dairy: "Dairy",
  meat: "Meat",
}

export const GOOD_LABEL: Record<Good, string> = {
  grain: "Grain",
  fiber: "Fiber",
  fruit: "Fruit",
  "dried-fruit": "Dried fruit",
  vegetables: "Vegetables",
  dairy: "Dairy",
  cheese: "Cheese",
  meat: "Meat",
  hide: "Hides",
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
}

const SHOP_LABEL: Record<ShopSpecialty, string> = {
  sawmill: "Sawmill",
  blacksmith: "Blacksmith",
  smokehouse: "Smokehouse",
  creamery: "Creamery",
  cooper: "Cooper",
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
  /** Hundredths of a ton sitting in the barn. */
  store: Record<Good, number>
  /** Dollars per ton the market paid for goods it is holding to resell. */
  cost?: Partial<Record<Good, number>>
  /** Hundredths an earlier month set aside to export. The next trade month returns them to the barn. */
  trade?: Partial<Record<Good, number>>
  /** Set once, the first month a workshop has an owner. */
  specialty?: ShopSpecialty
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
const PASTURES: Crop[] = ["dairy", "meat"]

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
 * Hundredths. A trading post opens with one year of supplies: 1 t grain,
 * 0.05 t leather, 0.05 t textiles, and 0.025 t steel tools.
 */
const BUSINESS_YEAR: Partial<Record<Good, number>> = {
  grain: 100,
  leather: 5,
  textiles: 5,
  "steel-tools": 3,
}

/** Hundredths a market tries to keep on the shelf. It refills after the pile falls under half. */
export const SHELF_TARGET: Partial<Record<Good, number>> = {
  clothing: 50,
  "steel-tools": 50,
  leather: 50,
  textiles: 50,
  meat: 300,
  fish: 500,
  grain: 500,
  dairy: 1000,
  fruit: 1000,
  vegetables: 1000,
  coal: 1000,
  wood: 5000,
  salt: 100,
}

/** Half a shelf target, rounded to the nearest tenth of a ton. */
function halfShelf(target: number): number {
  return Math.round(target / 20) * 10
}

function isHousehold(kind: Structure["kind"]): boolean {
  return kind === "farmstead" || kind === "shack" || kind === "market" || kind === "trading-post" || kind === "workshop"
}

function isBusiness(kind: Structure["kind"]): boolean {
  return kind === "market" || kind === "workshop" || kind === "trading-post"
}

function emptyStore(): Record<Good, number> {
  const store = {} as Record<Good, number>
  for (const good of GOODS) store[good] = 0
  return store
}

/** Climate specialty weighs twice as much as each other legal crop. Dairy weighs twice meat. Neither changes the soil. */
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
  if (preset === "marine-west-coast") return new Set(["dairy", "meat"])
  if (preset === "humid-continental") return new Set(["grain"])
  if (preset === "tropical-savanna") return new Set(["fiber"])
  if (preset === "humid-subtropical") return new Set(["grain", "fiber"])
  return new Set()
}

/** Added to the fertility reading for this product only. 50 fertility and +20 pay at 0.70, and the sum may pass 100. */
function climateBonus(preset: PresetId, good: Good): number {
  if (preset === "mediterranean" && good === "fruit") return 20
  if (preset === "marine-west-coast" && (good === "meat" || good === "dairy" || good === "hide")) return 20
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
  const weights = open.map((crop) => (garden ? (GARDEN_WEIGHT[crop] ?? 0) + (favored.has(crop) ? 20 : 0) : (crop === "dairy" ? 2 : 1) * (favored.has(crop) ? 2 : 1)))
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
  return layout === "thirds" && uses.some((crop) => crop === "dairy" || crop === "meat")
}

/**
 * Harvest this calendar month, then let a new owner or a finished orchard pick again.
 * Forest is cleared above 180 tiles and woodland above 360. Two cut-points are spent,
 * woodland first at one point and forest at two. One wetland tile is drained every year.
 * A farmstead's April fish haul stops at 15 tons.
 */
type Land = { feature: Uint8Array; fertility: Uint8Array; changed: boolean }

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
): { farms: Farms; feature: Uint8Array; fertility: Uint8Array; changedLand: boolean } {
  const standing = structures.filter((structure) => !structure.pending && !structure.removing && (structure.kind === "farmstead" || structure.kind === "shack" || structure.kind === "construction-office" || isBusiness(structure.kind)))
  const ownerOf = new Map(owners.map((row) => [row.structureId, row.owner]))
  const land: Land = { feature: featureIn, fertility: fertilityIn, changed: false }
  const writeLand = () => {
    if (land.changed) return
    land.feature = new Uint8Array(featureIn)
    land.fertility = new Uint8Array(fertilityIn)
    land.changed = true
  }

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
    const planted = record !== null
    if (!record) record = structure.kind === "farmstead" ? rollRecord(structure, land, preset, owner, seed, year, month) : stockRecord(structure, owner, seed)
    if (structure.kind === "workshop" && !record.specialty) {
      const cash = wealth && owner >= 0 && owner < wealth.length ? wealth[owner] ?? 0 : 0
      const affordable = openingRanks.filter((specialty) => canFoundShop(specialty, cash))
      record.specialty = pickShopSpecialty(affordable, structure.id, seed, year, month) ?? rollSpecialty(structure.id, seed, cash) ?? undefined
      if (record.specialty === "creamery") {
        record.store.salt += 10
        record.store.textiles += 10
      }
      if (record.specialty === "cooper") record.store.fiber += 20
    }
    if (structure.kind !== "farmstead") {
      record.owner = owner
      rows.push(record)
      continue
    }
    const harvest = monthWork(structure, record, terrain, land, preset, month, year, seed, writeLand, aridity)
    record = harvest.record
    const ownerChanged = planted && record.owner !== owner
    if (ownerChanged || harvest.replant) {
      const next = rollRecord(structure, land, preset, owner, seed, year, month)
      next.store = record.store
      next.trade = record.trade
      record = next
    }
    rows.push(record)
  }
  return { farms: { rows }, feature: land.feature, fertility: land.fertility, changedLand: land.changed }
}

function rollRecord(
  structure: Structure,
  land: Land,
  preset: PresetId,
  owner: number,
  seed: string,
  year: number,
  month: number,
): FarmRecord {
  const prairie = tilesWhere(structure.tiles, land.feature, Feature.Prairie)
  const average = averageFertility(prairie, land.fertility)
  const rng = mulberry32(hashSeed(`${seed}:crops:${structure.id}:${year}:${month}:${owner}`))
  const chosen = chooseUses(prairie.length, average, preset, rng)
  return {
    structureId: structure.id,
    owner,
    layout: chosen.layout,
    uses: chosen.uses,
    fruitAge: chosen.uses.includes("fruit") ? 0 : -1,
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
    store: openingStore(structure.kind),
  }
}

/** 70% the best monthly margin, 20% the second, 10% another profitable specialty. */
export function pickShopSpecialty(
  ranked: readonly ShopSpecialty[],
  structureId: number,
  seed: string,
  year: number,
  month: number,
): ShopSpecialty | null {
  if (ranked.length === 0) return null
  if (ranked.length === 1) return ranked[0]
  const rng = mulberry32(hashSeed(`${seed}:shop:${structureId}:${year}:${month}`))
  const roll = rng()
  if (roll < 0.7) return ranked[0]
  if (roll < 0.9) return ranked[1]
  const rest = ranked.slice(2)
  if (rest.length === 0) return ranked[0]
  return rest[Math.min(rest.length - 1, Math.floor(rng() * rest.length))]
}

const SHOP_PURSE: Record<ShopSpecialty, number> = {
  sawmill: 1000,
  blacksmith: 5000,
  smokehouse: 1000,
  creamery: 1000,
  cooper: 1000,
}

function canFoundShop(specialty: ShopSpecialty, cash: number): boolean {
  return cash >= SHOP_PURSE[specialty]
}

function rollSpecialty(id: number, seed: string, cash: number): ShopSpecialty | null {
  const kinds = (["sawmill", "blacksmith", "smokehouse", "creamery", "cooper"] as const).filter((kind) => canFoundShop(kind, cash))
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
  if (isHousehold(kind)) {
    for (const good of GOODS) store[good] += HOUSEHOLD_START[good] ?? 0
  }
  if (kind === "trading-post") {
    for (const good of GOODS) store[good] += BUSINESS_YEAR[good] ?? 0
  }
  if (kind === "farmstead") {
    store.leather += 10
    store.textiles += 10
    store["steel-tools"] += 10
  }
  if (kind === "workshop") store["steel-tools"] += 10
  if (kind === "market") {
    for (const good of GOODS) {
      const target = SHELF_TARGET[good]
      if (target) store[good] = Math.max(store[good], halfShelf(target))
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
): { record: FarmRecord; replant: boolean } {
  const next = record
  const feature = () => land.feature
  const prairie = tilesWhere(structure.tiles, feature(), Feature.Prairie)
  const average = averageFertility(prairie, land.fertility)
  const blocks = assignBlocks(prairie, next.uses.length)
  const bucket = emptyStore()
  let replant = false

  if (month === 0 && improvesSoil(next.layout, next.uses)) {
    writeLand()
    for (const tile of prairie) if (land.fertility[tile] < 80) land.fertility[tile] += 1
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
      bucket.wood += (blocks[next.uses.indexOf("fruit")] ?? []).length * 200
      replant = true
    }
  }

  for (let slot = 0; slot < next.uses.length; slot++) {
    const crop = next.uses[slot]
    const count = blocks[slot]?.length ?? 0
    if (count === 0) continue
    if (crop === "grain" && month === OCTOBER) pile(bucket, "grain", count, 5, average, preset)
    if (crop === "fiber" && month === OCTOBER) {
      pile(bucket, "fiber", count, 2, average, preset)
      pile(bucket, "grain", count, 1, average, preset)
    }
    if (crop === "vegetables" && month === JULY) pile(bucket, "vegetables", count, 30, average, preset)
    if (crop === "dairy" && month === MAY) pile(bucket, "dairy", count, 10, average, preset)
    if (crop === "meat" && month === NOVEMBER) {
      pile(bucket, "meat", count, 1, average, preset)
      pile(bucket, "hide", count, 0.2, average, preset)
    }
    if (crop === "fruit" && month === AUGUST && next.fruitAge >= 3 && next.fruitAge <= 33) {
      pile(bucket, "fruit", count, 25, average, preset)
    }
  }

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
    for (const tile of structure.tiles) {
      if (terrain[tile] === Terrain.Sea) bucket.fish += 10
      else if (terrain[tile] === Terrain.Fresh) bucket.fish += 5
    }
    if (bucket.fish > FISH_CAP) bucket.fish = FISH_CAP
  }

  const rng = mulberry32(hashSeed(`${seed}:harvest:${structure.id}:${year}:${month}`))
  for (const good of GOODS) next.store[good] += keep(bucket[good], rng)
  if (structure.tiles.some((tile) => terrain[tile] === Terrain.Sea)) next.store.salt += saltFromAridity(aridity)
  return { record: next, replant }
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

/** Each use gets an equal share. The leftover tiles stay fallow, at the southeast end of the list. */
function assignBlocks(prairie: readonly number[], uses: number): number[][] {
  if (uses === 0) return []
  const share = Math.floor(prairie.length / (uses + 1))
  const blocks: number[][] = []
  for (let slot = 0; slot < uses; slot++) blocks.push(prairie.slice(slot * share, (slot + 1) * share))
  return blocks
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
