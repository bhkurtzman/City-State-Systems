import {
  Feature,
  Resource,
  Terrain,
  type FeatureId,
  type LayerId,
  type ResourceId,
  type TerrainId,
  type World,
} from "@/lib/types"

type RGB = readonly [number, number, number]

const TERRAIN_RGB: Record<TerrainId, RGB> = {
  [Terrain.Sea]: [22, 74, 112],
  [Terrain.Fresh]: [64, 164, 196],
  [Terrain.Flat]: [196, 176, 126],
  [Terrain.Hill]: [150, 108, 70],
  [Terrain.Mountain]: [108, 110, 114],
}

const FEATURE_RGB: Record<FeatureId, RGB> = {
  [Feature.None]: [64, 164, 196],
  [Feature.Barren]: [214, 198, 164],
  [Feature.Scrub]: [166, 156, 86],
  [Feature.Prairie]: [198, 176, 70],
  [Feature.Wetland]: [64, 138, 118],
  [Feature.Woodland]: [112, 158, 78],
  [Feature.Forest]: [36, 104, 56],
}

const RESOURCE_RGB: Record<ResourceId, RGB> = {
  [Resource.None]: [232, 226, 214],
  [Resource.Limestone]: [214, 208, 196],
  [Resource.Iron]: [176, 84, 48],
  [Resource.Coal]: [42, 42, 46],
  [Resource.Copper]: [198, 114, 58],
  [Resource.Bauxite]: [176, 92, 86],
  [Resource.Oil]: [46, 58, 78],
  [Resource.Gold]: [214, 168, 42],
  [Resource.RareEarth]: [122, 82, 168],
}

export type Swatch = { label: string; hex: string }

export function hex(color: RGB): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ]
}

const DRY: RGB = [214, 196, 160]
const MID: RGB = [120, 150, 96]
const WET: RGB = [24, 92, 150]
const POOR: RGB = [120, 86, 62]
const RICH: RGB = [28, 114, 58]

function ramp(value: number, low: RGB, mid: RGB, high: RGB): RGB {
  const t = value / 100
  return t < 0.5 ? mix(low, mid, t * 2) : mix(mid, high, (t - 0.5) * 2)
}

export function sampleCell(world: World, layer: LayerId, index: number): RGB {
  const terrain = world.terrain[index]
  if (layer === "resources") {
    const resource = world.resourceType[index]
    if (terrain === Terrain.Sea && resource === 0) return [176, 196, 206]
    return RESOURCE_RGB[resource as ResourceId] ?? RESOURCE_RGB[Resource.None]
  }
  if (terrain === Terrain.Sea) return TERRAIN_RGB[Terrain.Sea]
  if (terrain === Terrain.Fresh && layer !== "terrain") return TERRAIN_RGB[Terrain.Fresh]
  if (layer === "terrain") return TERRAIN_RGB[terrain as TerrainId]
  if (layer === "features") return FEATURE_RGB[world.feature[index] as FeatureId]
  if (layer === "fertility") return ramp(world.fertility[index], POOR, MID, RICH)
  return ramp(world.groundwater[index], DRY, [110, 156, 176], WET)
}

export function paintLayer(world: World, layer: LayerId, data: Uint8ClampedArray) {
  const count = world.size * world.size
  for (let index = 0; index < count; index++) {
    const [red, green, blue] = sampleCell(world, layer, index)
    const offset = index * 4
    data[offset] = red
    data[offset + 1] = green
    data[offset + 2] = blue
    data[offset + 3] = 255
  }
}

export function legendFor(layer: LayerId): { swatches: Swatch[]; note?: string } {
  if (layer === "terrain") {
    return {
      swatches: [
        { label: "Sea", hex: hex(TERRAIN_RGB[Terrain.Sea]) },
        { label: "Fresh water", hex: hex(TERRAIN_RGB[Terrain.Fresh]) },
        { label: "Flat", hex: hex(TERRAIN_RGB[Terrain.Flat]) },
        { label: "Hill", hex: hex(TERRAIN_RGB[Terrain.Hill]) },
        { label: "Mountain", hex: hex(TERRAIN_RGB[Terrain.Mountain]) },
      ],
    }
  }
  if (layer === "features") {
    return {
      swatches: [
        { label: "Barren", hex: hex(FEATURE_RGB[Feature.Barren]) },
        { label: "Scrub", hex: hex(FEATURE_RGB[Feature.Scrub]) },
        { label: "Prairie", hex: hex(FEATURE_RGB[Feature.Prairie]) },
        { label: "Wetland", hex: hex(FEATURE_RGB[Feature.Wetland]) },
        { label: "Woodland", hex: hex(FEATURE_RGB[Feature.Woodland]) },
        { label: "Forest", hex: hex(FEATURE_RGB[Feature.Forest]) },
        { label: "Water", hex: hex(TERRAIN_RGB[Terrain.Fresh]) },
      ],
    }
  }
  if (layer === "fertility") {
    return {
      note: "Darker green is more fertile. Sea and open water are drawn blue; their fertility is zero.",
      swatches: [
        { label: "Low", hex: hex(POOR) },
        { label: "High", hex: hex(RICH) },
      ],
    }
  }
  if (layer === "groundwater") {
    return {
      note: "Blue is a fuller store. The sea is drawn dark and holds none. Open water reads as full.",
      swatches: [
        { label: "Dry", hex: hex(DRY) },
        { label: "Full", hex: hex(WET) },
      ],
    }
  }
  return {
    note: "Each blob is one mineral. A deposit continues under a river and under the sea.",
    swatches: [
      { label: "Limestone", hex: hex(RESOURCE_RGB[Resource.Limestone]) },
      { label: "Iron", hex: hex(RESOURCE_RGB[Resource.Iron]) },
      { label: "Coal", hex: hex(RESOURCE_RGB[Resource.Coal]) },
      { label: "Copper", hex: hex(RESOURCE_RGB[Resource.Copper]) },
      { label: "Bauxite", hex: hex(RESOURCE_RGB[Resource.Bauxite]) },
      { label: "Oil", hex: hex(RESOURCE_RGB[Resource.Oil]) },
      { label: "Gold", hex: hex(RESOURCE_RGB[Resource.Gold]) },
      { label: "Rare earth minerals", hex: hex(RESOURCE_RGB[Resource.RareEarth]) },
    ],
  }
}
