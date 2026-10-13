import { PRESETS, deriveClimate } from "../src/lib/climate"
import { generateDetailed, generateWorld } from "../src/lib/generate"
import { Feature, Terrain, type GenerateRequest, type World } from "../src/lib/types"

const failures: string[] = []

function check(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}

function request(id: string, size: 256 | 512 | 1024 = 256, coast: GenerateRequest["coast"] = "none"): GenerateRequest {
  const preset = PRESETS.find((item) => item.id === id)
  if (!preset) throw new Error(`Missing preset ${id}`)
  return {
    seed: "cistern-4",
    size,
    relief: 48,
    coast,
    latitude: preset.latitude,
    months: preset.months,
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameWorld(a: World, b: World): boolean {
  return (
    sameBytes(a.terrain, b.terrain) &&
    sameBytes(a.feature, b.feature) &&
    sameBytes(a.fertility, b.fertility) &&
    sameBytes(a.groundwater, b.groundwater) &&
    sameBytes(a.resourceType, b.resourceType) &&
    sameBytes(a.resourceAmount, b.resourceAmount)
  )
}

function freshDistance(terrain: Uint8Array, width: number): Int16Array {
  const count = terrain.length
  const dist = new Int16Array(count).fill(999)
  let current: number[] = []
  for (let i = 0; i < count; i++) {
    if (terrain[i] === Terrain.Fresh) {
      dist[i] = 0
      current.push(i)
    }
  }
  const dx = [1, -1, 0, 0, 1, 1, -1, -1]
  const dy = [0, 0, 1, -1, 1, -1, 1, -1]
  while (current.length) {
    const next: number[] = []
    for (const index of current) {
      const x = index % width
      const y = (index / width) | 0
      const step = dist[index] + 1
      if (step > 4) continue
      for (let k = 0; k < 8; k++) {
        const nx = x + dx[k]
        const ny = y + dy[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue
        const neighbor = ny * width + nx
        if (dist[neighbor] <= step) continue
        dist[neighbor] = step
        next.push(neighbor)
      }
    }
    current = next
  }
  return dist
}

function resourceStats(world: World) {
  const width = world.size
  const count = width * width
  const seen = new Uint8Array(count)
  const dx = [1, -1, 0, 0]
  const dy = [0, 0, 1, -1]
  const spans: number[] = []
  let seaWith = 0
  let freshWith = 0
  let holes = 0
  for (let i = 0; i < count; i++) {
    if (world.terrain[i] === Terrain.Sea && world.resourceType[i] !== 0) seaWith++
    if (world.terrain[i] === Terrain.Fresh && world.resourceType[i] !== 0) freshWith++
    if (world.terrain[i] === Terrain.Fresh && world.resourceType[i] === 0) {
      const x = i % width
      const y = (i / width) | 0
      const tally = new Map<number, number>()
      for (let k = 0; k < 4; k++) {
        const nx = x + dx[k]
        const ny = y + dy[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue
        const type = world.resourceType[ny * width + nx]
        if (type) tally.set(type, (tally.get(type) ?? 0) + 1)
      }
      for (const neighbors of tally.values()) if (neighbors >= 3) holes++
    }
    const type = world.resourceType[i]
    if (!type || seen[i]) continue
    const stack = [i]
    seen[i] = 1
    let minX = 0
    let maxX = 0
    let minY = 0
    let maxY = 0
    minX = width
    minY = width
    let area = 0
    while (stack.length) {
      const cell = stack.pop()!
      area++
      const x = cell % width
      const y = (cell / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let k = 0; k < 4; k++) {
        const nx = x + dx[k]
        const ny = y + dy[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue
        const neighbor = ny * width + nx
        if (seen[neighbor] || world.resourceType[neighbor] !== type) continue
        seen[neighbor] = 1
        stack.push(neighbor)
      }
    }
    if (area > 20) spans.push(Math.max(maxX - minX, maxY - minY) + 1)
  }
  const meanSpan = spans.reduce((sum, span) => sum + span, 0) / (spans.length || 1)
  return { blobs: spans.length, meanSpan, seaWith, freshWith, holes }
}

function coverStats(world: World) {
  const dist = freshDistance(world.terrain, world.size)
  let flat = 0
  let flatBarren = 0
  let flatPrairie = 0
  let hill = 0
  let hillForest = 0
  let wetNear = 0
  let wetFar = 0
  let freshFertility = 0
  let seaGroundwater = 0
  let freshGroundwater = 0
  const count = world.size * world.size
  for (let i = 0; i < count; i++) {
    if (world.terrain[i] === Terrain.Flat) {
      flat++
      if (world.feature[i] === Feature.Barren) flatBarren++
      if (world.feature[i] === Feature.Prairie) flatPrairie++
    }
    if (world.terrain[i] === Terrain.Hill) {
      hill++
      if (world.feature[i] === Feature.Forest) hillForest++
    }
    if (world.feature[i] === Feature.Wetland) {
      if (dist[i] <= 2) wetNear++
      else wetFar++
    }
    if (world.terrain[i] === Terrain.Fresh && world.fertility[i] !== 0) freshFertility++
    if (world.terrain[i] === Terrain.Sea && world.groundwater[i] !== 0) seaGroundwater++
    if (world.terrain[i] === Terrain.Fresh && world.groundwater[i] !== 100) freshGroundwater++
  }
  return { flat, flatBarren, flatPrairie, hill, hillForest, wetNear, wetFar, freshFertility, seaGroundwater, freshGroundwater }
}

const mediterranean = PRESETS.find((preset) => preset.id === "mediterranean")!
const med = deriveClimate(mediterranean.latitude, mediterranean.months)
check(Math.round(med.annualPrecip) === 804, `Mediterranean rain ${med.annualPrecip}`)
check(Math.abs(med.meanTemp - 15.7) < 0.15, `Mediterranean mean ${med.meanTemp}`)
check(med.frostMonths === 0 && med.growingMonths === 12, "Mediterranean frost and growing season")
check(med.aridity > 0.9 && med.aridity < 1.05, `Mediterranean aridity ${med.aridity}`)

const desertPreset = PRESETS.find((preset) => preset.id === "hot-desert")!
const desertClimate = deriveClimate(desertPreset.latitude, desertPreset.months)
check(desertClimate.aridity < 0.1, `Hot desert aridity ${desertClimate.aridity}`)

const humidPreset = PRESETS.find((preset) => preset.id === "humid-subtropical")!
const humidClimate = deriveClimate(humidPreset.latitude, humidPreset.months)
check(humidClimate.aridity >= 0.95, `Humid subtropical aridity ${humidClimate.aridity}`)

const continental = PRESETS.find((preset) => preset.id === "humid-continental")!
const continentalClimate = deriveClimate(continental.latitude, continental.months)
check(
  continentalClimate.frostMonths >= 2 && continentalClimate.summerHigh > 25,
  "Humid continental summer frost bonus",
)

const desertRun = generateDetailed(request("hot-desert"))
const humidRun = generateDetailed(request("humid-subtropical"))
const desertAgain = generateWorld(request("hot-desert"))
check(sameWorld(desertRun.world, desertAgain), "Same seed and settings are not deterministic")

const otherSeed = generateWorld({ ...request("hot-desert"), seed: "other-seed" })
check(!sameWorld(desertRun.world, otherSeed), "A different seed produced the same map")

const desertCover = coverStats(desertRun.world)
const humidCover = coverStats(humidRun.world)
console.log("desert", desertRun.diagnostics, desertCover)
console.log("humid", humidRun.diagnostics, humidCover)

check(desertRun.diagnostics.lakeCells < 40, `Desert lakes ${desertRun.diagnostics.lakeCells}`)
check(desertCover.flat > 0 && desertCover.flatBarren / desertCover.flat >= 0.7, "Desert flats are not mostly barren")
check(desertCover.wetNear > 0 && desertCover.wetFar === 0, "Desert wetlands are not limited to river banks")
check(humidRun.diagnostics.lakeBasins >= 1 && humidRun.diagnostics.lakeCells > 80, "Humid map has no lakes")
check(humidCover.hill > 0 && humidCover.hillForest / humidCover.hill >= 0.7, "Humid hills are not forested")
check(humidCover.flatPrairie > 800, `Humid prairie ${humidCover.flatPrairie}`)
check(humidCover.wetFar > 40, `Humid sink wetlands ${humidCover.wetFar}`)
check(desertRun.diagnostics.maxMountainSpan < 180, `Mountain span ${desertRun.diagnostics.maxMountainSpan}`)

const deposits = resourceStats(desertRun.world)
console.log("deposits", deposits)
check(deposits.blobs >= 3 && deposits.blobs <= 8, `Blob count ${deposits.blobs}`)
check(deposits.meanSpan >= 40 && deposits.meanSpan <= 75, `Blob span ${deposits.meanSpan}`)
check(deposits.holes === 0, `Resource holes ${deposits.holes}`)
check(deposits.seaWith === 0, "Sea received a deposit")
check(deposits.freshWith > 0, "No river cell kept a mineral")
check(desertCover.freshFertility === 0 && desertCover.seaGroundwater === 0, "Water fertility or sea groundwater")
check(humidCover.freshGroundwater === 0, "Open water groundwater is not full")

const coast = generateDetailed(request("hot-desert", 256, "west"))
let sea = 0
let shoreMin = 256
let shoreMax = 0
for (let y = 0; y < 256; y++) {
  for (let x = 0; x < 256; x++) {
    if (coast.world.terrain[y * 256 + x] !== Terrain.Sea) continue
    sea++
    if (x < shoreMin) shoreMin = x
    if (x > shoreMax) shoreMax = x
  }
}
check(sea > 4000 && sea < 40000, `Coast sea cells ${sea}`)
check(shoreMax - shoreMin > 30, "Coast is not a rough shoreline")

const medium = generateWorld(request("humid-subtropical", 512))
check(medium.terrain.length === 512 * 512, "Medium map has the wrong length")

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log("verify ok")
