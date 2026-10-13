const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6

const GRAD: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

export function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Noise = {
  simplex: (x: number, y: number) => number
  fbm: (x: number, y: number, octaves: number) => number
  fbm01: (x: number, y: number, octaves: number) => number
  ridged: (x: number, y: number, octaves: number) => number
}

export function createNoise(seed: number): Noise {
  const rand = mulberry32(seed)
  const source = new Uint8Array(256)
  for (let i = 0; i < 256; i++) source[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const swap = source[i]
    source[i] = source[j]
    source[j] = swap
  }
  const perm = new Uint8Array(512)
  for (let i = 0; i < 512; i++) perm[i] = source[i & 255]

  function simplex(x: number, y: number): number {
    const s = (x + y) * F2
    const i = Math.floor(x + s)
    const j = Math.floor(y + s)
    const t = (i + j) * G2
    const x0 = x - (i - t)
    const y0 = y - (j - t)
    const i1 = x0 > y0 ? 1 : 0
    const j1 = x0 > y0 ? 0 : 1
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2
    const ii = i & 255
    const jj = j & 255
    let n0 = 0
    let n1 = 0
    let n2 = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 >= 0) {
      const g = GRAD[perm[ii + perm[jj]] & 7]
      t0 *= t0
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 >= 0) {
      const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7]
      t1 *= t1
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 >= 0) {
      const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7]
      t2 *= t2
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2)
    }
    return 70 * (n0 + n1 + n2)
  }

  function fbm(x: number, y: number, octaves: number): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * simplex(x * freq, y * freq)
      norm += amp
      amp *= 0.5
      freq *= 2
    }
    return sum / norm
  }

  function fbm01(x: number, y: number, octaves: number): number {
    return fbm(x, y, octaves) * 0.5 + 0.5
  }

  function ridged(x: number, y: number, octaves: number): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(simplex(x * freq, y * freq))
      sum += amp * n * n
      norm += amp
      amp *= 0.5
      freq *= 2.07
    }
    return sum / norm
  }

  return { simplex, fbm, fbm01, ridged }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
