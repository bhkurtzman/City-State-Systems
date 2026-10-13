/** 10 m planning cell. Chunk index is floor(coord / CHUNK) for a later streaming generator. */
export const CELL_M = 10
export const CHUNK = 256

export const SIZES = [256, 512, 1024] as const
export type MapSize = (typeof SIZES)[number]

export const Terrain = {
  Sea: 0,
  Fresh: 1,
  Flat: 2,
  Hill: 3,
  Mountain: 4,
} as const

export const Feature = {
  None: 0,
  Barren: 1,
  Scrub: 2,
  Prairie: 3,
  Wetland: 4,
  Woodland: 5,
  Forest: 6,
} as const

export const Resource = {
  None: 0,
  Limestone: 1,
  Iron: 2,
  Coal: 3,
  Copper: 4,
  Bauxite: 5,
  Oil: 6,
  Gold: 7,
  RareEarth: 8,
} as const

export type TerrainId = (typeof Terrain)[keyof typeof Terrain]
export type FeatureId = (typeof Feature)[keyof typeof Feature]
export type ResourceId = (typeof Resource)[keyof typeof Resource]

export const TERRAIN_NAME: Record<TerrainId, string> = {
  [Terrain.Sea]: "Sea",
  [Terrain.Fresh]: "Fresh water",
  [Terrain.Flat]: "Flat",
  [Terrain.Hill]: "Hill",
  [Terrain.Mountain]: "Mountain",
}

export const FEATURE_NAME: Record<FeatureId, string> = {
  [Feature.None]: "—",
  [Feature.Barren]: "Barren",
  [Feature.Scrub]: "Scrub",
  [Feature.Prairie]: "Prairie",
  [Feature.Wetland]: "Wetland",
  [Feature.Woodland]: "Woodland",
  [Feature.Forest]: "Forest",
}

export const RESOURCE_NAME: Record<ResourceId, string> = {
  [Resource.None]: "None",
  [Resource.Limestone]: "Limestone",
  [Resource.Iron]: "Iron",
  [Resource.Coal]: "Coal",
  [Resource.Copper]: "Copper",
  [Resource.Bauxite]: "Bauxite",
  [Resource.Oil]: "Oil",
  [Resource.Gold]: "Gold",
  [Resource.RareEarth]: "Rare earth minerals",
}

export type Coast = "none" | "north" | "south" | "east" | "west"

export type MonthClimate = {
  high: number
  low: number
  precip: number
  humidity: number
}

export type ClimateIndices = {
  annualPrecip: number
  meanTemp: number
  frostMonths: number
  growingMonths: number
  pet: number
  aridity: number
  summerHigh: number
}

export type GenerateRequest = {
  seed: string
  size: MapSize
  relief: number
  coast: Coast
  latitude: number
  months: MonthClimate[]
}

export type World = {
  seed: string
  size: MapSize
  relief: number
  coast: Coast
  latitude: number
  months: MonthClimate[]
  indices: ClimateIndices
  terrain: Uint8Array
  feature: Uint8Array
  fertility: Uint8Array
  groundwater: Uint8Array
  resourceType: Uint8Array
  resourceAmount: Uint8Array
}

export type LayerId = "terrain" | "features" | "fertility" | "groundwater" | "resources"

export const LAYERS: { id: LayerId; label: string }[] = [
  { id: "terrain", label: "Terrain" },
  { id: "features", label: "Features" },
  { id: "fertility", label: "Fertility" },
  { id: "groundwater", label: "Groundwater" },
  { id: "resources", label: "Resources" },
]
