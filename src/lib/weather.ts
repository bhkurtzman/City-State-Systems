import { clamp, hashSeed, mulberry32 } from "@/lib/noise"
import type { MonthClimate } from "@/lib/types"

export type Sky = "sun" | "cloud" | "rain" | "snow"

export type MonthWeather = {
  high: number
  low: number
  sky: Sky
}

const TEMP_SPREAD = 1.8

function gaussian(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v)
}

/** One weather report for a calendar month. The same seed, year, and month always rebuild it. */
export function monthWeather(
  seed: string,
  year: number,
  month: number,
  climate: MonthClimate,
): MonthWeather {
  const rng = mulberry32(hashSeed(`${seed}|${year}|${month}`))
  let high = Math.round(climate.high + gaussian(rng) * TEMP_SPREAD)
  let low = Math.round(climate.low + gaussian(rng) * TEMP_SPREAD)
  if (low > high) {
    const swap = high
    high = low
    low = swap
  }
  if (Object.is(high, -0)) high = 0
  if (Object.is(low, -0)) low = 0

  const precip = Math.max(0, climate.precip)
  const pPrecip = clamp(precip / 180, 0, 0.8)
  const pCloud = (1 - pPrecip) * clamp(precip / 100, 0, 0.7)
  const roll = rng()
  let sky: Sky = "sun"
  if (roll < pPrecip) {
    const mean = (climate.high + climate.low) / 2
    sky = mean < 2 ? "snow" : "rain"
  } else if (roll < pPrecip + pCloud) {
    sky = "cloud"
  }

  return { high, low, sky }
}
