import { MAX_LATITUDE, climateFactor, deriveClimate, lakeMinDepth } from "@/lib/climate"
import { clamp, createNoise, hashSeed, mulberry32, smoothstep } from "@/lib/noise"
import {
  Feature,
  Resource,
  Terrain,
  type Coast,
  type GenerateRequest,
  type MapSize,
  type World,
} from "@/lib/types"

export type ProgressFn = (fraction: number, stage: string) => void

export type Diagnostics = {
  slopeP50: number
  slopeP90: number
  slopeP99: number
  lakeBasins: number
  lakeCells: number
  failedSinkCells: number
  riverCells: number
  openFlats: number
  terrain: number[]
  feature: number[]
  maxMountainSpan: number
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

const HILL_SLOPE = 0.0075
const MOUNTAIN_SLOPE = 0.016
const HILL_ELEV = 0.6
const MOUNTAIN_ELEV = 0.72
const RIVER_SOURCE = 70
const FLOOD_EPS = 0.012
const LAKE_MIN_AREA = 16
const OPEN_RADIUS = 6

class MinHeap {
  private pri: number[] = []
  private idx: number[] = []

  get size(): number {
    return this.idx.length
  }

  push(priority: number, index: number) {
    this.pri.push(priority)
    this.idx.push(index)
    let k = this.idx.length - 1
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (this.pri[parent] <= this.pri[k]) break
      this.swap(parent, k)
      k = parent
    }
  }

  pop(): [number, number] | undefined {
    const n = this.idx.length
    if (n === 0) return undefined
    const priority = this.pri[0]
    const index = this.idx[0]
    const last = n - 1
    this.pri[0] = this.pri[last]
    this.idx[0] = this.idx[last]
    this.pri.pop()
    this.idx.pop()
    let k = 0
    const len = this.idx.length
    while (true) {
      const left = k * 2 + 1
      const right = left + 1
      let smallest = k
      if (left < len && this.pri[left] < this.pri[smallest]) smallest = left
      if (right < len && this.pri[right] < this.pri[smallest]) smallest = right
      if (smallest === k) break
      this.swap(smallest, k)
      k = smallest
    }
    return [priority, index]
  }

  private swap(a: number, b: number) {
    const tp = this.pri[a]
    this.pri[a] = this.pri[b]
    this.pri[b] = tp
    const ti = this.idx[a]
    this.idx[a] = this.idx[b]
    this.idx[b] = ti
  }
}

function u8(value: number): number {
  const rounded = Math.round(value)
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded
}

function coastAmount(
  noise01: (x: number, y: number, octaves: number) => number,
  x: number,
  y: number,
  width: number,
  height: number,
  coast: Coast,
): number {
  if (coast === "none") return 0
  const across =
    coast === "north"
      ? y / (height - 1)
      : coast === "south"
        ? 1 - y / (height - 1)
        : coast === "west"
          ? x / (width - 1)
          : 1 - x / (width - 1)
  const bay = noise01(x / 46 + 3.2, y / 46 + 8.4, 5)
  const detail = noise01(x / 18 + 11, y / 18 + 2.5, 3)
  const shore = 0.3 + (bay - 0.5) * 0.34 + (detail - 0.5) * 0.12
  return smoothstep(shore + 0.07, shore - 0.05, across)
}

/** Drop sea that cannot reach the map border through other sea. */
function keepSeaOnEdge(sea: Uint8Array, width: number, height: number) {
  const n = width * height
  const open = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue
      const i = y * width + x
      if (!sea[i]) continue
      open[i] = 1
      stack[top++] = i
    }
  }
  while (top > 0) {
    const i = stack[--top]
    const x = i % width
    const y = (i / width) | 0
    for (let k = 0; k < 4; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const j = ny * width + nx
      if (!sea[j] || open[j]) continue
      open[j] = 1
      stack[top++] = j
    }
  }
  for (let i = 0; i < n; i++) {
    if (sea[i] && !open[i]) sea[i] = 0
  }
}

function buildElevation(
  width: number,
  height: number,
  relief: number,
  coast: Coast,
  seed: number,
  onProgress?: ProgressFn,
): { elev: Float32Array; sea: Uint8Array; shore: Uint8Array } {
  const noise = createNoise(seed)
  const n = width * height
  const elev = new Float32Array(n)
  const sea = new Uint8Array(n)
  const shore = new Uint8Array(n)
  const reliefAmp = 0.06 + (clamp(relief, 0, 100) / 100) * 0.52
  const alongCoast = coast === "north" || coast === "south"
  const acrossCoast = coast === "east" || coast === "west"
  const span = Math.min(width, height)
  const riseFull = span * 0.55
  const ridgeStart = span * 0.18
  const ridgeFull = span * 0.4

  if (coast !== "none") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const seaAmt = coastAmount(noise.fbm01, x, y, width, height, coast)
        if (seaAmt > 0.58) sea[y * width + x] = 1
      }
    }
    keepSeaOnEdge(sea, width, height)
  }

  const fromSea = coast === "none" ? null : edt(sea, width, height)

  for (let y = 0; y < height; y++) {
    if (onProgress && y % 64 === 0) {
      onProgress(0.04 + 0.18 * (y / height), "Shaping terrain")
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const warp = 1 / 150
      const wx = noise.simplex(x * warp, y * warp)
      const wy = noise.simplex(x * warp + 19.2, y * warp + 7.4)
      const px = x + wx * 26
      const py = y + wy * 26
      const roll = noise.fbm01(px / 96, py / 96, 5)
      const clump = noise.fbm01(x / 168 + 40, y / 168 + 13, 3)
      const mask = smoothstep(0.56, 0.8, clump)
      const ridgeScaleX = alongCoast ? 84 : 34
      const ridgeScaleY = acrossCoast ? 84 : 34
      const ridge = noise.ridged(px / ridgeScaleX, py / ridgeScaleY, 4)
      const bowlN = noise.fbm01(x / 120 + 17, y / 120 + 4, 4)
      const bowl = smoothstep(0.48, 0.22, bowlN)
      const bowlIrreg = noise.fbm01(px / 42 + 6, py / 42, 3)
      const bowlDepth = bowl * (0.05 + 0.2 * smoothstep(0.22, 0.82, bowlIrreg))
      let mountains = mask * ridge * reliefAmp
      let bowls = bowlDepth * (1 - mask * 0.8)
      let value = 0.5 + (roll - 0.5) * 0.16 + mountains - bowls
      if (fromSea) {
        if (sea[i]) {
          value = 0.16 + noise.fbm01(x / 40 + 2, y / 40, 3) * 0.06
        } else {
          const distance = fromSea[i]
          const shelf = smoothstep(0, riseFull, distance)
          const ridgeGate = smoothstep(ridgeStart, ridgeFull, distance)
          mountains *= ridgeGate
          bowls *= ridgeGate
          value = 0.26 + shelf * 0.24 + (roll - 0.5) * 0.1 + mountains - bowls
          if (distance < ridgeStart) shore[i] = 1
        }
      }
      elev[i] = clamp(value, 0, 1)
    }
  }
  return { elev, sea, shore }
}

function slopeAt(
  elev: Float32Array,
  sea: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): {
  slope: number
  gdx: number
  gdy: number
} {
  const center = elev[y * width + x]
  const at = (sx: number, sy: number) => {
    const index = sy * width + sx
    return sea[index] ? center : elev[index]
  }
  const xm = x > 0 ? x - 1 : x
  const xp = x + 1 < width ? x + 1 : x
  const ym = y > 0 ? y - 1 : y
  const yp = y + 1 < height ? y + 1 : y
  const gdx = at(xp, y) - at(xm, y)
  const gdy = at(x, yp) - at(x, ym)
  const slope = Math.hypot(gdx / (xp - xm || 1), gdy / (yp - ym || 1))
  return { slope, gdx, gdy }
}

function percentileFromBuckets(buckets: Int32Array, total: number, p: number): number {
  const target = total * p
  let seen = 0
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i]
    if (seen >= target) return (i + 0.5) * 0.0005
  }
  return buckets.length * 0.0005
}

function priorityFlood(
  elev: Float32Array,
  sea: Uint8Array,
  width: number,
  height: number,
): { water: Float32Array; pfDown: Int32Array } {
  const n = width * height
  const water = new Float32Array(elev)
  const pfDown = new Int32Array(n)
  pfDown.fill(-1)
  const visited = new Uint8Array(n)
  const heap = new MinHeap()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const i = y * width + x
      if (sea[i] || edge) {
        visited[i] = 1
        heap.push(elev[i], i)
      }
    }
  }
  while (heap.size > 0) {
    const popped = heap.pop()
    if (!popped) break
    const i = popped[1]
    const spill = water[i]
    const x = i % width
    const y = (i / width) | 0
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const j = ny * width + nx
      if (visited[j]) continue
      visited[j] = 1
      pfDown[j] = i
      water[j] = elev[j] < spill ? spill : elev[j]
      heap.push(water[j], j)
    }
  }
  return { water, pfDown }
}

function markBasins(
  elev: Float32Array,
  water: Float32Array,
  pfDown: Int32Array,
  sea: Uint8Array,
  aridity: number,
  width: number,
  height: number,
): { lake: Uint8Array; failed: Uint8Array; lakeBasins: number } {
  const n = width * height
  const lake = new Uint8Array(n)
  const failed = new Uint8Array(n)
  const flooded = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!sea[i] && water[i] - elev[i] > FLOOD_EPS) flooded[i] = 1
  }
  const pour = new Int32Array(n)
  pour.fill(-2)
  const minDepth = lakeMinDepth(aridity)
  const maxLake = Math.floor(n * 0.08)
  const maxSink = Math.floor(n * 0.04)

  function findPour(start: number): number {
    let i = start
    const guardLimit = n
    for (let guard = 0; guard < guardLimit; guard++) {
      if (pour[i] >= -1) return pour[i]
      if (!flooded[i] || sea[i]) {
        pour[i] = i
        return i
      }
      const next = pfDown[i]
      if (next < 0) {
        pour[i] = i
        return i
      }
      i = next
    }
    return start
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (!flooded[i]) continue
    const id = findPour(i)
    let list = groups.get(id)
    if (!list) {
      list = []
      groups.set(id, list)
    }
    list.push(i)
  }

  let lakeBasins = 0
  for (const cells of groups.values()) {
    let minElev = Infinity
    let spill = 0
    for (const i of cells) {
      if (elev[i] < minElev) minElev = elev[i]
      if (water[i] > spill) spill = water[i]
    }
    const depth = spill - minElev
    const area = cells.length
    if (area < 8 || depth < 0.03) continue
    if (area >= LAKE_MIN_AREA && area <= maxLake && depth >= minDepth) {
      let marked = 0
      for (const i of cells) {
        if (water[i] - elev[i] > FLOOD_EPS) {
          lake[i] = 1
          marked++
        }
      }
      if (marked >= LAKE_MIN_AREA) lakeBasins++
      else {
        for (const i of cells) lake[i] = 0
      }
      continue
    }
    if (area > maxSink) continue
    for (const i of cells) failed[i] = 1
  }
  return { lake, failed, lakeBasins }
}

function flowDown(
  elev: Float32Array,
  water: Float32Array,
  pfDown: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  width: number,
  height: number,
): Int32Array {
  const n = width * height
  const surface = new Float32Array(n)
  const down = new Int32Array(n)
  down.fill(-1)
  for (let i = 0; i < n; i++) {
    if (sea[i]) surface[i] = -0.25
    else if (lake[i]) surface[i] = elev[i]
    else surface[i] = water[i]
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i] || lake[i]) continue
      let best = -1
      let bestSlope = 0
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        const dist = k < 4 ? 1 : Math.SQRT2
        const slope = (surface[i] - surface[j]) / dist
        if (slope > bestSlope + 1e-8) {
          bestSlope = slope
          best = j
        }
      }
      down[i] = bestSlope > 1e-7 ? best : pfDown[i]
    }
  }
  return down
}

function paintRivers(
  down: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  landform: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const n = width * height
  const indeg = new Int32Array(n)
  const accum = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    accum[i] = 1
    const d = down[i]
    if (d >= 0 && d !== i) indeg[d]++
  }
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue[qt++] = i
  while (qh < qt) {
    const i = queue[qh++]
    const d = down[i]
    if (d < 0 || d === i) continue
    accum[d] += accum[i]
    indeg[d]--
    if (indeg[d] === 0) queue[qt++] = d
  }

  const channel = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (sea[i] || lake[i]) continue
    const form = landform[i]
    if (form !== Terrain.Hill && form !== Terrain.Mountain) continue
    if (accum[i] < RIVER_SOURCE) continue
    let j = i
    for (let guard = 0; guard < n && j >= 0; guard++) {
      if (sea[j] || lake[j]) break
      channel[j] = 1
      const next = down[j]
      if (next < 0 || next === j) break
      j = next
    }
  }
  assertRivers(channel, down, sea, lake, landform, width, height)
  return channel
}

function assertRivers(
  channel: Uint8Array,
  down: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  landform: Uint8Array,
  width: number,
  height: number,
) {
  const n = width * height
  const seen = new Int32Array(n)
  let stamp = 1
  for (let i = 0; i < n; i++) {
    if (!channel[i]) continue
    const next = down[i]
    const nextIsOutlet =
      next < 0 ||
      (next >= 0 && (sea[next] || lake[next] || channel[next]))
    if (!nextIsOutlet) {
      throw new Error("A river channel has a gap before it reaches water.")
    }
    let j = i
    const color = stamp++
    for (let guard = 0; guard < n; guard++) {
      if (j < 0 || sea[j] || lake[j]) break
      if (!channel[j] && j !== i) {
        throw new Error("A river channel has a gap before it reaches water.")
      }
      if (seen[j] === color) throw new Error("A river channel loops.")
      seen[j] = color
      const edge = j % width === 0 || ((j / width) | 0) === 0 || j % width === width - 1 || ((j / width) | 0) === height - 1
      const step = down[j]
      if (step < 0) {
        if (!edge && !sea[j] && !lake[j]) {
          throw new Error("A river channel stops before a lake or the sea.")
        }
        break
      }
      j = step
    }
  }
  const inflow = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!channel[i]) continue
    const d = down[i]
    if (d >= 0 && channel[d]) inflow[d] = 1
  }
  for (let i = 0; i < n; i++) {
    if (!channel[i] || inflow[i]) continue
    const form = landform[i]
    if (form !== Terrain.Hill && form !== Terrain.Mountain) {
      throw new Error("A river headwater is not on steep ground.")
    }
  }
}

function edt(fresh: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height
  const inf = 1e20
  const horizontal = new Float64Array(n)
  const row = new Float64Array(Math.max(width, height))
  const rowOut = new Float64Array(Math.max(width, height))
  for (let y = 0; y < height; y++) {
    const offset = y * width
    for (let x = 0; x < width; x++) row[x] = fresh[offset + x] ? 0 : inf
    edt1d(row, width, rowOut)
    for (let x = 0; x < width; x++) horizontal[offset + x] = rowOut[x]
  }
  const out = new Float32Array(n)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) row[y] = horizontal[y * width + x]
    edt1d(row, height, rowOut)
    for (let y = 0; y < height; y++) out[y * width + x] = Math.sqrt(rowOut[y])
  }
  return out
}

function edt1d(f: Float64Array, length: number, out: Float64Array) {
  const v = new Int32Array(length)
  const z = new Float64Array(length + 1)
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < length; q++) {
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < length; q++) {
    while (z[k + 1] < q) k++
    const dx = q - v[k]
    out[q] = dx * dx + f[v[k]]
  }
}

function dilate8(mask: Uint8Array, width: number, height: number, times: number): Uint8Array {
  let src = mask
  for (let t = 0; t < times; t++) {
    const dst = new Uint8Array(src)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (!src[i]) continue
        for (let k = 0; k < 8; k++) {
          const nx = x + DX[k]
          const ny = y + DY[k]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          dst[ny * width + nx] = 1
        }
      }
    }
    src = dst
  }
  return src
}

function coverBands(score: number): number {
  if (score >= 0.75) return Feature.Forest
  if (score >= 0.4) return Feature.Woodland
  if (score >= 0.1) return Feature.Scrub
  return Feature.Barren
}

function openFlatGate(aridity: number): number {
  if (aridity >= 0.4) return Feature.Prairie
  if (aridity >= 0.1) return Feature.Scrub
  return Feature.Barren
}

function failedSinkCover(aridity: number): number {
  if (aridity >= 0.4) return Feature.Wetland
  if (aridity >= 0.2) return Feature.Prairie
  if (aridity >= 0.1) return Feature.Scrub
  return Feature.Barren
}

function aspectAdjust(gdx: number, gdy: number, slope: number, latitude: number): number {
  if (slope < HILL_SLOPE * 0.5) return 0
  if (Math.abs(gdy) <= Math.abs(gdx)) return 0
  const facesSouth = gdy < 0
  if (latitude >= 0) return facesSouth ? -0.2 : 0.2
  return facesSouth ? 0.2 : -0.2
}

function placeResources(
  sea: Uint8Array,
  width: number,
  height: number,
  seed: number,
): { type: Uint8Array; amount: Uint8Array } {
  const n = width * height
  const type = new Uint8Array(n)
  const amount = new Uint8Array(n)
  const claim = new Float32Array(n)
  claim.fill(2)
  const rng = mulberry32(seed ^ 0x51ed9e2d)
  const weights = [0, 5, 5, 5, 2, 2, 2, 1, 1]
  const common = [Resource.Limestone, Resource.Iron, Resource.Coal]
  const uncommon = [Resource.Copper, Resource.Bauxite, Resource.Oil]
  const ci = Math.floor(rng() * common.length)
  const ui = Math.floor(rng() * uncommon.length)
  const swapped = weights[common[ci]]
  weights[common[ci]] = weights[uncommon[ui]]
  weights[uncommon[ui]] = swapped
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const pick = () => {
    let roll = rng() * totalWeight
    for (let id = 1; id < weights.length; id++) {
      roll -= weights[id]
      if (roll <= 0) return id
    }
    return Resource.Limestone
  }
  const blobCount = Math.max(1, Math.round((5 * width * height) / (256 * 256)))
  const centers: { x: number; y: number; type: number }[] = []
  let sep = 76 * (width / 256)
  let guard = 0
  while (centers.length < blobCount && guard < 12000) {
    guard++
    const x = Math.floor(rng() * width)
    const y = Math.floor(rng() * height)
    if (sea[y * width + x]) continue
    let clear = true
    for (const center of centers) {
      const dx = center.x - x
      const dy = center.y - y
      if (dx * dx + dy * dy < sep * sep) {
        clear = false
        break
      }
    }
    if (!clear) {
      if (guard % 500 === 0) sep *= 0.86
      continue
    }
    centers.push({ x, y, type: pick() })
  }
  const noise = createNoise(seed ^ 0x27d4eb2f)
  const reach = 40
  for (const center of centers) {
    const x0 = Math.max(0, center.x - reach)
    const x1 = Math.min(width - 1, center.x + reach)
    const y0 = Math.max(0, center.y - reach)
    const y1 = Math.min(height - 1, center.y + reach)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x
        if (sea[i]) continue
        const dx = x - center.x
        const dy = y - center.y
        const dist = Math.hypot(dx, dy)
        const warp = noise.simplex(x / 16, y / 16)
        const radius = 26 * (0.88 + 0.2 * (warp * 0.5 + 0.5))
        if (dist > radius) continue
        const norm = dist / radius
        if (norm >= claim[i]) continue
        claim[i] = norm
        type[i] = center.type
        amount[i] = u8(46 + 54 * (1 - norm))
      }
    }
  }
  return { type, amount }
}

function mountainSpan(terrain: Uint8Array, width: number, height: number): number {
  const n = width * height
  const seen = new Uint8Array(n)
  let maxSpan = 0
  const stack = new Int32Array(n)
  for (let start = 0; start < n; start++) {
    if (seen[start] || terrain[start] !== Terrain.Mountain) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    while (top > 0) {
      const i = stack[--top]
      const x = i % width
      const y = (i / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (seen[j] || terrain[j] !== Terrain.Mountain) continue
        seen[j] = 1
        stack[top++] = j
      }
    }
    const span = Math.max(maxX - minX, maxY - minY)
    if (span > maxSpan) maxSpan = span
  }
  return maxSpan
}

export function generateDetailed(
  request: GenerateRequest,
  onProgress?: ProgressFn,
): { world: World; diagnostics: Diagnostics } {
  const size = request.size
  if (size !== 256 && size !== 512 && size !== 1024) {
    throw new Error("Map size must be 256, 512, or 1024.")
  }
  const width = size
  const height = size
  const n = width * height
  const months = request.months.map((month) => ({ ...month }))
  const latitude = clamp(request.latitude, -MAX_LATITUDE, MAX_LATITUDE)
  const indices = deriveClimate(latitude, months)
  const factor = climateFactor(indices)
  const seed = hashSeed(request.seed.trim() || "0")
  onProgress?.(0.02, "Reading the climate")

  const { elev, sea, shore } = buildElevation(
    width,
    height,
    request.relief,
    request.coast,
    seed,
    onProgress,
  )
  onProgress?.(0.24, "Classing slopes")

  const slope = new Float32Array(n)
  const landform = new Uint8Array(n)
  const slopeBuckets = new Int32Array(200)
  let slopeSamples = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i]) {
        landform[i] = Terrain.Sea
        continue
      }
      const sample = slopeAt(elev, sea, width, height, x, y)
      slope[i] = sample.slope
      const bucket = clamp(Math.floor(sample.slope / 0.0005), 0, 199)
      slopeBuckets[bucket]++
      slopeSamples++
      const mountain =
        !shore[i] && (elev[i] >= MOUNTAIN_ELEV || sample.slope >= MOUNTAIN_SLOPE)
      if (mountain) landform[i] = Terrain.Mountain
      else if (elev[i] >= HILL_ELEV || sample.slope >= HILL_SLOPE) landform[i] = Terrain.Hill
      else landform[i] = Terrain.Flat
    }
  }

  onProgress?.(0.36, "Finding lakes")
  const { water, pfDown } = priorityFlood(elev, sea, width, height)
  const basins = markBasins(elev, water, pfDown, sea, indices.aridity, width, height)
  const down = flowDown(elev, water, pfDown, sea, basins.lake, width, height)
  onProgress?.(0.58, "Tracing rivers")
  const channel = paintRivers(down, sea, basins.lake, landform, width, height)

  const terrain = new Uint8Array(landform)
  let lakeCells = 0
  let riverCells = 0
  let failedSinkCells = 0
  for (let i = 0; i < n; i++) {
    if (sea[i]) {
      terrain[i] = Terrain.Sea
      continue
    }
    if (basins.lake[i]) {
      terrain[i] = Terrain.Fresh
      lakeCells++
      continue
    }
    if (channel[i]) {
      terrain[i] = Terrain.Fresh
      riverCells++
    }
  }

  const fresh = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (terrain[i] === Terrain.Fresh) fresh[i] = 1
  const nearFresh = dilate8(fresh, width, height, 2)

  const hillMark = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (landform[i] === Terrain.Hill || landform[i] === Terrain.Mountain) hillMark[i] = 1
  }
  const satW = width + 1
  const sat = new Int32Array(satW * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += hillMark[y * width + x]
      sat[(y + 1) * satW + (x + 1)] = sat[y * satW + (x + 1)] + row
    }
  }
  const open = new Uint8Array(n)
  let openFlats = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (landform[i] !== Terrain.Flat) continue
      if (slope[i] >= HILL_SLOPE * 0.5) continue
      const x0 = Math.max(0, x - OPEN_RADIUS)
      const y0 = Math.max(0, y - OPEN_RADIUS)
      const x1 = Math.min(width - 1, x + OPEN_RADIUS)
      const y1 = Math.min(height - 1, y + OPEN_RADIUS)
      const count =
        sat[(y1 + 1) * satW + (x1 + 1)] -
        sat[y0 * satW + (x1 + 1)] -
        sat[(y1 + 1) * satW + x0] +
        sat[y0 * satW + x0]
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      if (count / area < 0.06) {
        open[i] = 1
        openFlats++
      }
    }
  }

  onProgress?.(0.7, "Laying down cover")
  const noise = createNoise(seed ^ 0x85ebca6b)
  const feature = new Uint8Array(n)
  const prairieGround = new Uint8Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i] || terrain[i] === Terrain.Fresh) continue
      if (landform[i] === Terrain.Mountain) {
        feature[i] = Feature.Barren
        continue
      }
      const gradient = slopeAt(elev, sea, width, height, x, y)
      const score = indices.aridity + aspectAdjust(gradient.gdx, gradient.gdy, slope[i], latitude)
      const field = noise.fbm01(x / 84, y / 84, 3)
      const clearing = noise.fbm01(x / 30 + 20, y / 30 + 9, 2)
      const prairieZone = field >= 0.42 || (field < 0.42 && clearing > 0.74)
      if (open[i] && prairieZone) {
        prairieGround[i] = 1
        feature[i] = openFlatGate(indices.aridity)
      } else {
        feature[i] = coverBands(score)
      }
      if (basins.failed[i] && landform[i] !== Terrain.Mountain) {
        feature[i] = failedSinkCover(indices.aridity)
        failedSinkCells++
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!prairieGround[i] || terrain[i] === Terrain.Fresh || sea[i]) continue
    if (nearFresh[i]) feature[i] = Feature.Wetland
  }

  onProgress?.(0.82, "Measuring soil and water")
  const distance = edt(fresh, width, height)
  const fertility = new Uint8Array(n)
  const groundwater = new Uint8Array(n)
  const rainPart = clamp(indices.annualPrecip / 1500, 0, 1)
  const aridPart = clamp(indices.aridity / 1.5, 0, 1)
  const summerBonus =
    indices.summerHigh > 25 && indices.frostMonths >= 2
  for (let i = 0; i < n; i++) {
    if (sea[i]) continue
    if (terrain[i] === Terrain.Fresh) {
      groundwater[i] = 100
      continue
    }
    const low = elev[i] >= 0.65 ? 0 : 8 * ((0.65 - elev[i]) / 0.65)
    let waterScore = 40 * aridPart + low + 16 * rainPart
    if (feature[i] === Feature.Wetland) waterScore += 22
    if (distance[i] <= 36) waterScore += 28 * (1 - distance[i] / 36)
    if (landform[i] === Terrain.Mountain) waterScore -= 10
    groundwater[i] = u8(clamp(waterScore, 0, 100))

    const flatBonus = 20 * clamp(1 - slope[i] / HILL_SLOPE, 0, 1)
    let soil = 26 + flatBonus
    const cover = feature[i]
    if (cover === Feature.Prairie) soil += 20
    else if (cover === Feature.Forest) soil += 10
    else if (cover === Feature.Woodland) soil += 8
    else if (cover === Feature.Wetland) soil += 10
    else if (cover === Feature.Scrub) soil -= 8
    else if (cover === Feature.Barren) soil -= 20
    if (landform[i] === Terrain.Mountain) soil -= 26
    else if (landform[i] === Terrain.Hill) soil -= 5
    if (landform[i] !== Terrain.Mountain && distance[i] <= 18) soil += 12
    if (summerBonus) {
      if (cover === Feature.Prairie) soil += 10
      else if (cover === Feature.Woodland || cover === Feature.Wetland) soil += 5
    }
    fertility[i] = u8(clamp(soil * factor, 0, 100))
  }

  onProgress?.(0.92, "Placing deposits")
  const resources = placeResources(sea, width, height, seed)
  onProgress?.(1, "Map ready")

  const terrainCounts = [0, 0, 0, 0, 0]
  const featureCounts = [0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    terrainCounts[terrain[i]]++
    featureCounts[feature[i]]++
  }

  const world: World = {
    seed: request.seed,
    size: size as MapSize,
    relief: request.relief,
    coast: request.coast,
    latitude,
    months,
    indices,
    terrain,
    feature,
    fertility,
    groundwater,
    resourceType: resources.type,
    resourceAmount: resources.amount,
  }
  return {
    world,
    diagnostics: {
      slopeP50: percentileFromBuckets(slopeBuckets, slopeSamples, 0.5),
      slopeP90: percentileFromBuckets(slopeBuckets, slopeSamples, 0.9),
      slopeP99: percentileFromBuckets(slopeBuckets, slopeSamples, 0.99),
      lakeBasins: basins.lakeBasins,
      lakeCells,
      failedSinkCells,
      riverCells,
      openFlats,
      terrain: terrainCounts,
      feature: featureCounts,
      maxMountainSpan: mountainSpan(terrain, width, height),
    },
  }
}

export function generateWorld(request: GenerateRequest, onProgress?: ProgressFn): World {
  return generateDetailed(request, onProgress).world
}
