import { MAX_LATITUDE, climateFactor, deriveClimate, lakeMinDepth } from "@/lib/climate"
import { clamp, createNoise, hashSeed, mulberry32, smoothstep, type Noise } from "@/lib/noise"
import {
  Feature,
  Resource,
  SIZES,
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
const FLOOD_EPS = 0.012
const SEA_LEVEL = 0.32
const LAKE_MIN_AREA = 16
const OPEN_RADIUS = 6
const STREAM_HEAD_GAP = 8
/** A river with this many headwaters will not end in a pond. */
const RIVER_LAKE_HEADS = 8
/** Minimum lake cells per headwater before a large river may stop there. */
const RIVER_LAKE_CELLS_PER_HEAD = 32

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
  const span = Math.min(width, height)
  const bay = noise01(x / (span * 0.24) + 3.2, y / (span * 0.24) + 8.4, 2)
  const rough = smoothstep(0.4, 0.74, noise01(x / (span * 0.42) + 1.4, y / (span * 0.42) + 6.2, 2))
  const teeth = noise01(x / (span * 0.1) + 11, y / (span * 0.1) + 2.5, 2)
  const shore = 0.3 + (bay - 0.5) * 0.36 + rough * (teeth - 0.5) * 0.28
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

/** Land fully surrounded by sea is ocean, not a lake basin. */
function fillSeaHoles(sea: Uint8Array, width: number, height: number) {
  const n = width * height
  const open = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue
      const i = y * width + x
      if (sea[i]) continue
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
      if (sea[j] || open[j]) continue
      open[j] = 1
      stack[top++] = j
    }
  }
  for (let i = 0; i < n; i++) {
    if (!sea[i] && !open[i]) sea[i] = 1
  }
}

/** Fixed meters: 400 m ridges, 200 m spurs, 80 m crests. A cell is 10 m. */
const RIDGE_SCALES = [40, 20, 8]

function rangeAt(noise: Noise, x: number, y: number, reliefT: number, hillScale: number): { lift: number; kind: number } {
  const coverage = smoothstep(0.1, 0.95, reliefT)
  if (coverage <= 0) return { lift: 0, kind: Terrain.Flat }
  const plateau = noise.fbm01(x / hillScale, y / hillScale, 2)
  // High bar at low relief, so hills are rare peaks with plains between them.
  const hillCut = 0.86 - 0.5 * coverage
  const present = smoothstep(hillCut, Math.min(0.98, hillCut + 0.16), plateau)
  if (present <= 0.04) return { lift: 0, kind: Terrain.Flat }
  let ridge = 0
  let weight = 0
  let amp = 1
  for (const scale of RIDGE_SCALES) {
    ridge += amp * noise.ridged(x / scale + 2.2, y / scale + 6.4, 1)
    weight += amp
    amp *= 0.55
  }
  ridge /= weight
  const coarse = noise.ridged(x / 40 + 2.2, y / 40 + 6.4, 1)
  const fine = noise.ridged(x / 8 + 1.7, y / 8 + 4.1, 1)
  const ridgeAmp = (0.02 + 0.14 * reliefT) * coverage
  const lift = present * (0.012 + ridgeAmp * (0.32 + 0.68 * ridge)) * coverage
  const mountainT = smoothstep(0.38, 0.92, reliefT)
  const crestCut = 0.84 - 0.16 * mountainT
  const crest = mountainT > 0 && coarse > crestCut && fine > 0.5 - 0.15 * mountainT && present > 0.5
  if (crest) return { lift, kind: Terrain.Mountain }
  return { lift, kind: Terrain.Hill }
}

function buildElevation(
  width: number,
  height: number,
  relief: number,
  coast: Coast,
  seed: number,
  aridity: number,
  onProgress?: ProgressFn,
): { elev: Float32Array; sea: Uint8Array; upland: Uint8Array } {
  const noise = createNoise(seed)
  const n = width * height
  const elev = new Float32Array(n)
  const sea = new Uint8Array(n)
  const upland = new Uint8Array(n)
  const reliefT = clamp(relief, 0, 100) / 100
  const humid = smoothstep(0.08, 1.05, aridity)
  const span = Math.min(width, height)

  if (coast !== "none") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const seaAmt = coastAmount(noise.fbm01, x, y, width, height, coast)
        if (seaAmt > 0.58) sea[y * width + x] = 1
      }
    }
    keepSeaOnEdge(sea, width, height)
    fillSeaHoles(sea, width, height)
  }

  const fromSea = coast === "none" ? null : edt(sea, width, height)

  for (let y = 0; y < height; y++) {
    if (onProgress && y % 64 === 0) {
      onProgress(0.04 + 0.18 * (y / height), "Shaping terrain")
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i]) {
        const bath = noise.fbm01(x / (span * 0.16) + 2, y / (span * 0.16), 2)
        elev[i] = clamp(SEA_LEVEL - 0.02 - bath * 0.035, 0, SEA_LEVEL - 0.008)
        continue
      }
      const inland = fromSea ? clamp(fromSea[i] / (span * 0.7), 0, 1) : 1 - y / Math.max(1, height - 1)
      const ramp = (fromSea ? SEA_LEVEL + 0.02 : 0.06) + 0.24 * inland
      const range = rangeAt(noise, x, y, reliefT, span * 0.45)
      let lift = range.lift
      let kind = range.kind
      if (fromSea) {
        const gate = smoothstep(28, 150, fromSea[i])
        lift *= gate
        if (gate < 0.45) kind = Terrain.Flat
      }
      const swell = (noise.fbm01(x / 280 + 4, y / 280 + 9, 2) - 0.5) * (0.012 + 0.04 * humid)
      const pocketScale = span * (90 / 1024)
      const pocket = smoothstep(0.15, 0.05, noise.fbm01(x / pocketScale + 11, y / pocketScale + 3, 2)) * humid * 0.32
      upland[i] = kind
      elev[i] = clamp(ramp + lift + swell - pocket, 0, 1)
      if (fromSea && fromSea[i] <= 36) elev[i] = Math.max(elev[i], SEA_LEVEL + 0.012)
    }
  }
  return { elev, sea, upland }
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
  const lakeArea = new Int32Array(n)
  const lakeId = new Int32Array(n)
  lakeId.fill(-1)
  const basinPool = new Uint8Array(n)
  const flooded = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!sea[i] && water[i] - elev[i] > FLOOD_EPS) flooded[i] = 1
  }
  const pour = new Int32Array(n)
  pour.fill(-2)
  const minDepth = lakeMinDepth(aridity)
  const minLake = Math.max(1, Math.round(LAKE_MIN_AREA * (width / 1024) ** 2))
  const minBasin = Math.max(1, Math.round(8 * (width / 1024) ** 2))
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
    if (area < minBasin || depth < 0.03) continue
    if (area >= minLake && area <= maxLake && depth >= minDepth) {
      let marked = 0
      for (const i of cells) {
        if (water[i] - elev[i] > FLOOD_EPS) {
          lake[i] = 1
          marked++
        }
      }
      if (marked >= minLake) {
        const id = lakeBasins++
        for (const i of cells) {
          if (!lake[i]) continue
          lakeArea[i] = marked
          lakeId[i] = id
        }
      } else {
        for (const i of cells) lake[i] = 0
      }
      continue
    }
    if (area > maxSink) continue
    const wet = smoothstep(0.4, 2, aridity)
    const reach = 0.0065 * wet
    for (const i of cells) {
      failed[i] = 1
      if (wet > 0 && elev[i] <= minElev + reach) basinPool[i] = 1
    }
  }
  return { lake, failed, lakeBasins, lakeArea, lakeId, basinPool }
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const prefixW = new Float64Array(width + 1)
  for (let y = 0; y < height; y++) {
    const row = y * width
    prefixW[0] = 0
    for (let x = 0; x < width; x++) prefixW[x + 1] = prefixW[x] + src[row + x]
    for (let x = 0; x < width; x++) {
      const a = Math.max(0, x - radius)
      const b = Math.min(width - 1, x + radius)
      tmp[row + x] = (prefixW[b + 1] - prefixW[a]) / (b - a + 1)
    }
  }
  const prefixH = new Float64Array(height + 1)
  for (let x = 0; x < width; x++) {
    prefixH[0] = 0
    for (let y = 0; y < height; y++) prefixH[y + 1] = prefixH[y] + tmp[y * width + x]
    for (let y = 0; y < height; y++) {
      const a = Math.max(0, y - radius)
      const b = Math.min(height - 1, y + radius)
      out[y * width + x] = (prefixH[b + 1] - prefixH[a]) / (b - a + 1)
    }
  }
  return out
}

function hash01(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, y: number, scale: number): number {
  const fx = x / scale
  const fy = y / scale
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const v00 = hash01(x0, y0)
  const v10 = hash01(x0 + 1, y0)
  const v01 = hash01(x0, y0 + 1)
  const v11 = hash01(x0 + 1, y0 + 1)
  return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v00 - v10 - v01 + v11) * sx * sy
}

function outletDistance(parent: Int32Array, n: number): Int32Array {
  const dist = new Int32Array(n)
  dist.fill(-1)
  const state = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    let j = i
    stack.length = 0
    while (j >= 0 && state[j] === 0) {
      state[j] = 1
      stack.push(j)
      j = parent[j]
    }
    let base = j >= 0 && state[j] === 2 ? dist[j] + 1 : 0
    for (let s = stack.length - 1; s >= 0; s--) {
      dist[stack[s]] = base
      base++
      state[stack[s]] = 2
    }
  }
  return dist
}

function flowDown(
  elev: Float32Array,
  water: Float32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  width: number,
  height: number,
  guide: Uint8Array | null,
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
  const span = Math.min(width, height)
  // 7 cells is 70 m. A blur that grows with the map erases gullies on large maps.
  const radius = guide ? 2 : 7
  const field = boxBlur(surface, width, height, radius)
  const meanderScale = Math.max(16, Math.round(span * 0.14))
  const valleyScale = Math.max(28, Math.round(span * 0.22))
  const meanderAmp = guide ? 0.003 : 0.02
  const flatness = new Float32Array(n)
  const atBlur = (x: number, y: number) =>
    field[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i] || lake[i]) continue
      const gx = atBlur(x + 1, y) - atBlur(x - 1, y)
      const gy = atBlur(x, y + 1) - atBlur(x, y - 1)
      flatness[i] = 1 - smoothstep(0.0008, 0.004, Math.hypot(gx, gy))
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i]) field[i] = -0.25
      else if (lake[i]) field[i] = elev[i] - 0.04
      else {
        const flat = flatness[i]
        const meanderKeep = 0.3 + 0.7 * (1 - flat)
        if (!guide) field[i] += (valueNoise(x + 8, y + 63, valleyScale) - 0.5) * 0.04 * (1 - flat)
        field[i] += (valueNoise(x, y, meanderScale) - 0.5) * meanderAmp * meanderKeep
      }
    }
  }
  const drained = priorityFlood(field, sea, width, height)
  const heightField = drained.water
  const dist = outletDistance(drained.pfDown, n)
  const at = (grid: Float32Array, x: number, y: number) =>
    grid[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i] || lake[i]) continue
      let gx = at(heightField, x + 1, y) - at(heightField, x - 1, y)
      let gy = at(heightField, x, y + 1) - at(heightField, x, y - 1)
      const mag = Math.hypot(gx, gy)
      if (mag > 1e-8) {
        gx = -gx / mag
        gy = -gy / mag
      }
      let best = -1
      let bestScore = -Infinity
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        const intoLake = lake[j] === 1
        const dropField = heightField[i] - heightField[j]
        const closer = dist[j] >= 0 && dist[i] >= 0 && dist[j] < dist[i]
        if (!intoLake && !(dropField > 1e-7 || (dropField >= -1e-7 && closer))) continue
        if (intoLake && surface[j] > surface[i] + 0.02) continue
        const step = k < 4 ? 1 : Math.SQRT2
        const toward = mag > 1e-8 ? (DX[k] * gx + DY[k] * gy) / step : 0
        if (!intoLake && mag > 0.004 && toward < 0.55) continue
        let score = toward + ((surface[i] - surface[j]) / step) * 3
        if (guide?.[j]) score += guide[i] ? 1.5 : 0.8
        if (j === drained.pfDown[i]) score += 0.04 + 0.85 * flatness[i]
        if (score > bestScore) {
          bestScore = score
          best = j
        }
      }
      down[i] = best >= 0 ? best : drained.pfDown[i]
    }
  }
  return down
}

function streamMoisture(annualPrecip: number, aridity: number): number {
  const rain = smoothstep(40, 1500, annualPrecip)
  const humid = smoothstep(0.05, 1, aridity)
  return clamp(0.7 * rain + 0.3 * humid, 0, 1)
}

function traceRivers(
  down: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  failed: Uint8Array,
  landform: Uint8Array,
  width: number,
  height: number,
  relief: number,
  annualPrecip: number,
  aridity: number,
): { channel: Uint8Array; accum: Int32Array } {
  const n = width * height
  const indeg = new Int32Array(n)
  const joins = new Int32Array(n)
  const accum = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    accum[i] = 1
    const d = down[i]
    if (d >= 0 && d !== i) {
      indeg[d]++
      joins[d]++
    }
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

  const reliefT = clamp(relief, 0, 100) / 100
  // Each cell is 10 m, so these counts are a fixed catchment area on every map.
  const moisture = streamMoisture(annualPrecip, aridity)
  const drain = 2.4 - 2 * moisture
  // 0 is fully dry and 2 is fully wet.
  const dryness = 1 - smoothstep(0, 2, aridity)
  const steepMin = Math.max(600, Math.round((1400 + 2000 * reliefT * reliefT) * drain * (1 + 3 * dryness)))
  const flatMin = Math.max(steepMin, Math.round(4800 * drain * (1 + 3 * dryness)))
  const wetlandMin = Math.max(24, Math.round(140 * drain))
  const channel = new Uint8Array(n)

  const start = (origin: number) => {
    if (sea[origin] || lake[origin]) return
    const mine = new Set<number>()
    const beside = (cell: number, previous: number) => {
      const x = cell % width
      const y = (cell / width) | 0
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const neighbor = ny * width + nx
        if (neighbor === previous || mine.has(neighbor)) continue
        if (channel[neighbor]) return neighbor
      }
      return -1
    }
    if (beside(origin, -1) >= 0) return
    let j = origin
    let previous = -1
    for (let guard = 0; guard < n && j >= 0; guard++) {
      if (j !== origin && (sea[j] || lake[j])) break
      if (j !== origin) {
        const join = beside(j, previous)
        if (join >= 0) {
          if (previous === origin) channel[origin] = 0
          else down[previous] = join
          break
        }
      }
      channel[j] = 1
      mine.add(j)
      const next = down[j]
      if (next < 0 || next === j) break
      previous = j
      j = next
    }
  }

  const qualifies = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (sea[i] || lake[i]) continue
    const steep = landform[i] === Terrain.Hill || landform[i] === Terrain.Mountain
    const converged = joins[i] >= 2 || accum[i] >= steepMin * 3
    if (steep && accum[i] >= steepMin && (reliefT < 0.55 || converged)) qualifies[i] = 1
    else if (!steep && accum[i] >= flatMin) qualifies[i] = 1
  }

  const heads: number[] = []
  for (let i = 0; i < n; i++) {
    if (!qualifies[i]) continue
    const x = i % width
    const y = (i / width) | 0
    let fed = false
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const j = ny * width + nx
      if (down[j] === i && qualifies[j]) {
        fed = true
        break
      }
    }
    if (!fed) heads.push(i)
  }
  heads.sort((a, b) => accum[b] - accum[a])

  const blocked = new Uint8Array(n)
  const accept = (origin: number) => {
    if (blocked[origin]) return
    start(origin)
    const x = origin % width
    const y = (origin / width) | 0
    const x0 = Math.max(0, x - STREAM_HEAD_GAP)
    const x1 = Math.min(width - 1, x + STREAM_HEAD_GAP)
    const y0 = Math.max(0, y - STREAM_HEAD_GAP)
    const y1 = Math.min(height - 1, y + STREAM_HEAD_GAP)
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * width
      for (let xx = x0; xx <= x1; xx++) blocked[row + xx] = 1
    }
  }
  for (const origin of heads) accept(origin)
  if (reliefT <= 0.35) {
    const seen = new Uint8Array(n)
    const stack = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      if (!failed[i] || seen[i]) continue
      let top = 0
      stack[top++] = i
      seen[i] = 1
      let bestExit = -1
      let bestAccum = -1
      while (top > 0) {
        const c = stack[--top]
        const next = down[c]
        if (
          accum[c] >= wetlandMin &&
          next >= 0 &&
          !sea[next] &&
          !lake[next] &&
          !failed[next] &&
          accum[c] > bestAccum
        ) {
          bestAccum = accum[c]
          bestExit = next
        }
        const x = c % width
        const y = (c / width) | 0
        for (let k = 0; k < 4; k++) {
          const nx = x + DX[k]
          const ny = y + DY[k]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const j = ny * width + nx
          if (!failed[j] || seen[j]) continue
          seen[j] = 1
          stack[top++] = j
        }
      }
      if (bestExit >= 0) accept(bestExit)
    }
  }

  return { channel, accum }
}

function channelWidths(channel: Uint8Array, down: Int32Array, n: number): Int32Array {
  const width = new Int32Array(n)
  const incoming = new Int32Array(n)
  const pending = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (!channel[i]) continue
    const d = down[i]
    if (d >= 0 && d !== i && channel[d]) pending[d]++
  }
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  for (let i = 0; i < n; i++) if (channel[i] && pending[i] === 0) queue[qt++] = i
  while (qh < qt) {
    const i = queue[qh++]
    width[i] = incoming[i] > 0 ? incoming[i] : 1
    const d = down[i]
    if (d < 0 || d === i || !channel[d]) continue
    incoming[d] += width[i]
    pending[d]--
    if (pending[d] === 0) queue[qt++] = d
  }
  return width
}

function widenChannels(
  channel: Uint8Array,
  width: Int32Array,
  sea: Uint8Array,
  mapW: number,
  mapH: number,
): Uint8Array {
  const wide = new Uint8Array(channel)
  for (let i = 0; i < channel.length; i++) {
    if (!channel[i]) continue
    const span = width[i] > 1 ? width[i] : 1
    if (span <= 1) continue
    const x = i % mapW
    const y = (i / mapW) | 0
    // span is the number of headwaters upstream. Half a log keeps a creek one cell wide until four heads join.
    const radius = Math.log2(span) * 0.5
    const reach = Math.ceil(radius)
    const limit2 = radius * radius + 1e-4
    for (let oy = -reach; oy <= reach; oy++) {
      const ny = y + oy
      if (ny < 0 || ny >= mapH) continue
      for (let ox = -reach; ox <= reach; ox++) {
        if (ox * ox + oy * oy > limit2) continue
        const nx = x + ox
        if (nx < 0 || nx >= mapW) continue
        const j = ny * mapW + nx
        if (sea[j]) continue
        wide[j] = 1
      }
    }
  }
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const i = y * mapW + x
      if (wide[i] || sea[i]) continue
      const has = (ox: number, oy: number) => {
        const nx = x + ox
        const ny = y + oy
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH) return false
        return wide[ny * mapW + nx] === 1
      }
      if ((has(-1, 0) && has(1, 0)) || (has(0, -1) && has(0, 1))) wide[i] = 1
    }
  }
  return wide
}

function carveDrainage(
  elev: Float32Array,
  down: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
  landform: Uint8Array,
  width: number,
  height: number,
  reliefT: number,
) {
  const n = width * height
  const accum = new Int32Array(n)
  const indeg = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    accum[i] = sea[i] ? 0 : 1
    const d = down[i]
    if (d >= 0 && d !== i && !sea[d]) indeg[d]++
  }
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  for (let i = 0; i < n; i++) if (!sea[i] && indeg[i] === 0) queue[qt++] = i
  while (qh < qt) {
    const i = queue[qh++]
    const d = down[i]
    if (d < 0 || d === i || sea[d]) continue
    accum[d] += accum[i]
    indeg[d]--
    if (indeg[d] === 0) queue[qt++] = d
  }

  const logMax = Math.log2(1 + n)
  const cut = new Float32Array(n)
  const floor = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (sea[i] || lake[i] || accum[i] < 64) continue
    const share = Math.log2(1 + accum[i]) / logMax
    const radius = 1.4 + Math.min(11, share * 16)
    const depth = (0.014 + 0.055 * reliefT) * (0.3 + share)
    const x = i % width
    const y = (i / width) | 0
    const reach = Math.ceil(radius)
    const limit2 = radius * radius
    for (let oy = -reach; oy <= reach; oy++) {
      const ny = y + oy
      if (ny < 0 || ny >= height) continue
      for (let ox = -reach; ox <= reach; ox++) {
        const dist2 = ox * ox + oy * oy
        if (dist2 > limit2) continue
        const nx = x + ox
        if (nx < 0 || nx >= width) continue
        const j = ny * width + nx
        if (sea[j] || lake[j]) continue
        const fall = 1 - Math.sqrt(dist2) / radius
        const amount = depth * fall
        if (amount <= cut[j]) continue
        cut[j] = amount
        if (fall > 0.72) floor[j] = 1
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (sea[i] || cut[i] <= 0) continue
    elev[i] = clamp(elev[i] - cut[i], 0, 1)
    if (floor[i]) landform[i] = Terrain.Flat
  }
}

/** Large rivers cross ponds. The pond stays in `drained` so it can be drawn as wetland. */
function continuePastSmallLakes(
  channel: Uint8Array,
  down: Int32Array,
  heads: Int32Array,
  lakeId: Int32Array,
  lakeArea: Int32Array,
  pfDown: Int32Array,
  sea: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const n = width * height
  let lakeCount = 0
  for (let i = 0; i < n; i++) if (lakeId[i] >= lakeCount) lakeCount = lakeId[i] + 1
  const refused = new Uint8Array(lakeCount)
  const drained = new Uint8Array(n)

  const isDrained = (cell: number) => {
    const id = lakeId[cell]
    return id >= 0 && refused[id] === 1
  }
  const accepts = (cell: number, headCount: number) => {
    if (headCount < RIVER_LAKE_HEADS) return true
    return lakeArea[cell] >= headCount * RIVER_LAKE_CELLS_PER_HEAD
  }
  const spillOf = (start: number) => {
    let j = start
    for (let guard = 0; guard < n; guard++) {
      if (lakeId[j] < 0) return j
      const next = pfDown[j]
      if (next < 0 || next === j) return -1
      j = next
    }
    return -1
  }
  const beside = (cell: number, previous: number, mine: Set<number>) => {
    const x = cell % width
    const y = (cell / width) | 0
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const neighbor = ny * width + nx
      if (neighbor === previous || mine.has(neighbor)) continue
      if (channel[neighbor]) return neighbor
    }
    return -1
  }

  const extendFrom = (shore: number, headCount: number) => {
    let previous = shore
    let j = down[shore]
    const mine = new Set<number>()
    mine.add(shore)
    for (let guard = 0; guard < n && j >= 0 && j !== previous; guard++) {
      if (sea[j] || mine.has(j)) {
        down[previous] = j
        return
      }
      if (lakeId[j] >= 0 && !isDrained(j)) {
        if (accepts(j, headCount) || spillOf(j) < 0) {
          down[previous] = j
          return
        }
        refused[lakeId[j]] = 1
      }
      if (channel[j]) {
        down[previous] = j
        return
      }
      if (!isDrained(j)) {
        const join = beside(j, previous, mine)
        if (join >= 0) {
          down[previous] = join
          return
        }
      }
      channel[j] = 1
      mine.add(j)
      down[previous] = j
      let next = isDrained(j) ? pfDown[j] : down[j]
      if (!isDrained(j) && isDrained(previous) && next >= 0 && lakeId[next] === lakeId[previous]) {
        const alt = pfDown[j]
        if (alt >= 0 && alt !== j && lakeId[alt] !== lakeId[previous]) next = alt
        else return
      }
      if (next < 0 || next === j) return
      down[j] = next
      previous = j
      j = next
    }
  }

  let grew = true
  for (let spins = 0; grew && spins < 12; spins++) {
    grew = false
    for (let i = 0; i < n; i++) {
      if (!channel[i]) continue
      const next = down[i]
      if (next < 0 || lakeId[next] < 0 || isDrained(next)) continue
      if (accepts(next, heads[i]) || spillOf(next) < 0) continue
      refused[lakeId[next]] = 1
      grew = true
    }
    for (let i = 0; i < n; i++) {
      if (!channel[i]) continue
      const next = down[i]
      if (next < 0 || !isDrained(next) || channel[next]) continue
      extendFrom(i, Math.max(1, heads[i]))
      grew = true
    }
  }

  for (let i = 0; i < n; i++) if (isDrained(i)) drained[i] = 1
  return drained
}

function assertRivers(
  channel: Uint8Array,
  down: Int32Array,
  sea: Uint8Array,
  lake: Uint8Array,
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

function aspectAdjust(gdx: number, gdy: number, slope: number, latitude: number): number {
  if (slope < HILL_SLOPE * 0.5) return 0
  if (Math.abs(gdx) > Math.abs(gdy)) {
    // East matches north in the northern hemisphere. West matches south. This pair does not flip south of the equator.
    return gdx > 0 ? -0.2 : 0.2
  }
  const facesSouth = gdy < 0
  if (latitude >= 0) return facesSouth ? -0.2 : 0.2
  return facesSouth ? 0.2 : -0.2
}

/** Cells of Chebyshev distance from the marked sources. */
function chebyshevDistance(source: Uint8Array, width: number, height: number): Int16Array {
  const n = width * height
  const dist = new Int16Array(n)
  dist.fill(32767)
  for (let i = 0; i < n; i++) if (source[i]) dist[i] = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      let d = dist[i]
      if (x > 0) d = Math.min(d, dist[i - 1] + 1)
      if (y > 0) d = Math.min(d, dist[i - width] + 1)
      if (x > 0 && y > 0) d = Math.min(d, dist[i - width - 1] + 1)
      if (x + 1 < width && y > 0) d = Math.min(d, dist[i - width + 1] + 1)
      dist[i] = d
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      let d = dist[i]
      if (x + 1 < width) d = Math.min(d, dist[i + 1] + 1)
      if (y + 1 < height) d = Math.min(d, dist[i + width] + 1)
      if (x + 1 < width && y + 1 < height) d = Math.min(d, dist[i + width + 1] + 1)
      if (x > 0 && y + 1 < height) d = Math.min(d, dist[i + width - 1] + 1)
      dist[i] = d
    }
  }
  return dist
}

/** Medium-map distances: 2 cells at 600 mm, 32 cells at 2000 mm. Other maps scale by width / 1024. */
function forestReach(annualPrecip: number, span: number): number {
  if (annualPrecip < 600) return 0
  const t = clamp((annualPrecip - 600) / 1400, 0, 1)
  return Math.max(1, Math.round((2 + 30 * t) * (span / 1024)))
}

function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v)
}

function placeResources(
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
  const blobCount = Math.max(1, Math.round((width * height) / (256 * 256)))
  const centers: { x: number; y: number; type: number; scale: number }[] = []
  let sep = 76 * (width / 256)
  let guard = 0
  while (centers.length < blobCount && guard < 12000) {
    guard++
    const x = Math.floor(rng() * width)
    const y = Math.floor(rng() * height)
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
    // Current outline is the low end. A normal draw reaches about five times that.
    const scale = clamp(3 + gaussian(rng), 1, 5)
    centers.push({ x, y, type: pick(), scale })
  }
  const noise = createNoise(seed ^ 0x27d4eb2f)
  for (const center of centers) {
    const reach = Math.ceil(center.scale * 26 * 1.08)
    const x0 = Math.max(0, center.x - reach)
    const x1 = Math.min(width - 1, center.x + reach)
    const y0 = Math.max(0, center.y - reach)
    const y1 = Math.min(height - 1, center.y + reach)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x
        const dx = x - center.x
        const dy = y - center.y
        const dist = Math.hypot(dx, dy)
        const nominal = center.scale * 26
        const px = dist === 0 ? center.x : center.x + (dx / dist) * nominal
        const py = dist === 0 ? center.y : center.y + (dy / dist) * nominal
        const warp = noise.simplex(px / 16, py / 16)
        const radius = nominal * (0.88 + 0.2 * (warp * 0.5 + 0.5))
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
  if (!SIZES.includes(size)) {
    throw new Error("Map size must be 512, 1024, or 2048.")
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

  const { elev, sea, upland } = buildElevation(
    width,
    height,
    request.relief,
    request.coast,
    seed,
    indices.aridity,
    onProgress,
  )
  onProgress?.(0.24, "Classing slopes")

  const slope = new Float32Array(n)
  const landform = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (sea[i]) landform[i] = Terrain.Sea
    else if (upland[i] === Terrain.Mountain) landform[i] = Terrain.Mountain
    else if (upland[i] === Terrain.Hill) landform[i] = Terrain.Hill
    else landform[i] = Terrain.Flat
  }

  onProgress?.(0.36, "Finding lakes")
  const { water, pfDown } = priorityFlood(elev, sea, width, height)
  const basins = markBasins(elev, water, pfDown, sea, indices.aridity, width, height)
  const drained = flowDown(elev, water, sea, basins.lake, width, height, null)
  onProgress?.(0.46, "Cutting valleys")
  carveDrainage(elev, drained, sea, basins.lake, landform, width, height, request.relief / 100)
  const draftDown = flowDown(elev, elev, sea, basins.lake, width, height, null)
  onProgress?.(0.5, "Tracing rivers")
  const draft = traceRivers(
    draftDown,
    sea,
    basins.lake,
    basins.failed,
    landform,
    width,
    height,
    request.relief,
    indices.annualPrecip,
    indices.aridity,
  )
  const channel = draft.channel
  const arriving = channelWidths(channel, draftDown, n)
  const drainedLakes = continuePastSmallLakes(
    channel,
    draftDown,
    arriving,
    basins.lakeId,
    basins.lakeArea,
    pfDown,
    sea,
    width,
    height,
  )
  assertRivers(channel, draftDown, sea, basins.lake, width, height)
  const sized = channelWidths(channel, draftDown, n)
  const wide = widenChannels(channel, sized, sea, width, height)

  const slopeBuckets = new Int32Array(200)
  let slopeSamples = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (sea[i]) continue
      const sample = slopeAt(elev, sea, width, height, x, y)
      slope[i] = sample.slope
      const bucket = clamp(Math.floor(sample.slope / 0.0005), 0, 199)
      slopeBuckets[bucket]++
      slopeSamples++
    }
  }

  const terrain = new Uint8Array(landform)
  let lakeCells = 0
  let riverCells = 0
  let failedSinkCells = 0
  for (let i = 0; i < n; i++) {
    if (sea[i]) {
      terrain[i] = Terrain.Sea
      continue
    }
    if (basins.lake[i] && !drainedLakes[i]) {
      terrain[i] = Terrain.Fresh
      lakeCells++
      continue
    }
    if (wide[i]) {
      terrain[i] = Terrain.Fresh
      riverCells++
    }
  }

  const fresh = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (terrain[i] === Terrain.Fresh) fresh[i] = 1
  const nearFresh = dilate8(fresh, width, height, 1)

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
  const prairieScale = Math.min(width, height) * 0.45 * (84 / 220)
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
      const field = noise.fbm01(x / prairieScale, y / prairieScale, 3)
      const clearingScale = Math.min(width, height) * 0.45 * (30 / 220)
      const clearing = noise.fbm01(x / clearingScale + 20, y / clearingScale + 9, 2)
      const prairieZone = field >= 0.42 || (field < 0.42 && clearing > 0.88)
      if (open[i] && prairieZone) {
        prairieGround[i] = 1
        feature[i] = openFlatGate(indices.aridity)
      } else {
        feature[i] = coverBands(score)
      }
      if (basins.basinPool[i] && landform[i] !== Terrain.Mountain) {
        feature[i] = Feature.Wetland
        failedSinkCells++
      }
    }
  }
  if (indices.aridity >= 0.4) {
    for (let i = 0; i < n; i++) {
      if (!prairieGround[i] || terrain[i] === Terrain.Fresh || sea[i]) continue
      if (nearFresh[i]) feature[i] = Feature.Wetland
    }
  }
  const aridT = clamp((indices.aridity - 0.4) / 1.6, 0, 1)
  const marshShare =
    indices.aridity < 0.4
      ? 0
      : (0.01 + 0.09 * Math.pow(aridT, 1.35)) * (1 - smoothstep(0.05, 0.5, request.relief / 100))
  if (marshShare > 0) {
    const marshAt = (x: number, y: number) => noise.fbm01(x / 70 + 4, y / 70 + 12, 2)
    const samples: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (!prairieGround[i] || terrain[i] === Terrain.Fresh || sea[i]) continue
        samples.push(marshAt(x, y))
      }
    }
    if (samples.length > 0) {
      samples.sort((a, b) => a - b)
      const rank = Math.min(samples.length - 1, Math.floor((1 - marshShare) * samples.length))
      const cutoff = samples[rank]
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          if (!prairieGround[i] || terrain[i] === Terrain.Fresh || sea[i]) continue
          if (marshAt(x, y) >= cutoff) feature[i] = Feature.Wetland
        }
      }
    }
  }
  const reach = forestReach(indices.annualPrecip, Math.min(width, height))
  if (reach > 0) {
    const woods = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (feature[i] === Feature.Forest) woods[i] = 1
    const fromWoods = chebyshevDistance(woods, width, height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (feature[i] !== Feature.Prairie || fromWoods[i] > reach) continue
        feature[i] = Feature.Forest
        prairieGround[i] = 0
      }
    }
  }
  if (indices.aridity < 0.4) {
    const river = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (terrain[i] === Terrain.Fresh && (!basins.lake[i] || drainedLakes[i])) river[i] = 1
    }
    const bank = dilate8(river, width, height, 2)
    const bankCover = indices.aridity < 0.1 ? Feature.Scrub : Feature.Woodland
    for (let i = 0; i < n; i++) {
      if (!bank[i] || sea[i] || terrain[i] === Terrain.Fresh) continue
      feature[i] = bankCover
      prairieGround[i] = 0
    }
  }
  for (let i = 0; i < n; i++) {
    if (!drainedLakes[i] || sea[i] || terrain[i] === Terrain.Fresh) continue
    feature[i] = Feature.Wetland
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
  const resources = placeResources(width, height, seed)
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
