import { clamp, smoothstep } from "@/lib/noise"
import type { ClimateIndices, MonthClimate } from "@/lib/types"

export type PresetId =
  | "hot-desert"
  | "mediterranean"
  | "humid-subtropical"
  | "marine-west-coast"
  | "humid-continental"
  | "tropical-savanna"

/** Northern and southern limit of the latitude slider and the climate model. */
export const MAX_LATITUDE = 80

export type ClimatePreset = {
  id: PresetId
  name: string
  latitude: number
  months: MonthClimate[]
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

export const MONTH_LABELS = MONTH_NAMES

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MID_DAY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]

function months(
  high: number[],
  low: number[],
  precip: number[],
  humidity: number[],
): MonthClimate[] {
  return high.map((h, i) => ({
    high: h,
    low: low[i],
    precip: precip[i],
    humidity: humidity[i],
  }))
}

export const PRESETS: ClimatePreset[] = [
  {
    id: "hot-desert",
    name: "Hot desert",
    latitude: 25,
    months: months(
      [21, 24, 29, 34, 39, 43, 44, 43, 40, 34, 27, 22],
      [7, 9, 13, 17, 22, 26, 28, 28, 24, 18, 12, 8],
      [6, 4, 3, 2, 1, 0, 1, 3, 2, 3, 4, 6],
      [36, 30, 24, 20, 18, 16, 20, 24, 26, 28, 32, 36],
    ),
  },
  {
    id: "mediterranean",
    name: "Mediterranean",
    latitude: 41.9,
    months: months(
      [12, 13, 15, 18, 23, 27, 31, 31, 26, 22, 16, 13],
      [3, 4, 6, 9, 13, 16, 19, 19, 16, 12, 8, 4],
      [86, 74, 68, 60, 44, 24, 13, 22, 64, 117, 130, 102],
      [76, 73, 70, 68, 66, 60, 57, 59, 66, 73, 77, 78],
    ),
  },
  {
    id: "humid-subtropical",
    name: "Humid subtropical",
    latitude: 32,
    months: months(
      [14, 16, 20, 24, 28, 32, 33, 33, 30, 25, 19, 15],
      [3, 5, 8, 12, 16, 20, 22, 22, 18, 12, 7, 4],
      [118, 112, 128, 100, 96, 132, 148, 140, 112, 88, 90, 116],
      [72, 70, 68, 66, 70, 74, 76, 77, 75, 72, 72, 73],
    ),
  },
  {
    id: "marine-west-coast",
    name: "Marine west coast",
    latitude: 48,
    months: months(
      [8, 9, 11, 14, 17, 20, 22, 22, 19, 15, 11, 8],
      [2, 2, 3, 5, 8, 11, 13, 13, 11, 8, 4, 2],
      [125, 95, 80, 62, 55, 48, 42, 52, 72, 105, 125, 130],
      [86, 84, 80, 76, 74, 74, 75, 76, 80, 84, 86, 87],
    ),
  },
  {
    id: "humid-continental",
    name: "Humid continental",
    latitude: 42,
    months: months(
      [-1, 2, 8, 15, 21, 27, 29, 28, 24, 17, 9, 2],
      [-9, -7, -2, 4, 10, 15, 18, 17, 13, 6, 0, -6],
      [42, 38, 62, 86, 98, 96, 92, 88, 80, 68, 62, 48],
      [74, 72, 68, 64, 64, 66, 68, 70, 70, 68, 74, 76],
    ),
  },
  {
    id: "tropical-savanna",
    name: "Tropical savanna",
    latitude: 13,
    months: months(
      [33, 36, 38, 39, 37, 34, 31, 31, 32, 34, 34, 33],
      [17, 20, 23, 26, 26, 24, 22, 22, 22, 22, 19, 17],
      [1, 2, 6, 22, 78, 155, 230, 250, 170, 55, 8, 2],
      [28, 24, 30, 40, 55, 72, 82, 84, 78, 62, 42, 32],
    ),
  },
]

export function presetById(id: string): ClimatePreset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[1]
}

export function cloneMonths(monthsIn: MonthClimate[]): MonthClimate[] {
  return monthsIn.map((month) => ({ ...month }))
}

/** Annual-mean cooling, °C, for each degree of latitude away from the equator. */
const COOLING_PER_DEGREE = 0.35

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * High and low for a preset placed at `latitude`.
 * The preset's own latitude reproduces its table. Farther from the equator is cooler
 * and more seasonal. The opposite hemisphere swaps the warm and cold months.
 * Rain and humidity stay on `monthsIn`.
 */
export function temperaturesForLatitude(
  preset: ClimatePreset,
  latitude: number,
  monthsIn: MonthClimate[],
): MonthClimate[] {
  const lat = clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE)
  const baseLat = preset.latitude
  const means = preset.months.map((month) => (month.high + month.low) / 2)
  const annual = means.reduce((sum, mean) => sum + mean, 0) / means.length
  const season = Math.abs(lat) / MAX_LATITUDE
  const baseSeason = Math.abs(baseLat) / MAX_LATITUDE
  const scale = baseSeason === 0 ? 1 : season / baseSeason
  const cool = COOLING_PER_DEGREE * (Math.abs(lat) - Math.abs(baseLat))
  const flip = lat !== 0 && baseLat !== 0 && Math.sign(lat) !== Math.sign(baseLat)
  return monthsIn.map((month, index) => {
    const source = preset.months[flip ? (index + 6) % 12 : index]
    const mean = (source.high + source.low) / 2
    const shifted = annual + (mean - annual) * scale - cool
    const delta = shifted - mean
    return sanitizeMonth({
      high: roundTenth(source.high + delta),
      low: roundTenth(source.low + delta),
      precip: month.precip,
      humidity: month.humidity,
    })
  })
}

/**
 * This month's rainfall divided by its Thornthwaite PET.
 * The annual index in deriveClimate is unchanged; salt uses the month.
 */
export function monthAridity(latitude: number, monthsIn: MonthClimate[], index: number): number {
  if (index < 0 || index > 11 || monthsIn.length < 12) return 99
  const clean = monthsIn.map(sanitizeMonth)
  const means = clean.map((month) => (month.high + month.low) / 2)
  let heat = 0
  for (const mean of means) if (mean > 0) heat += (mean / 5) ** 1.514
  if (heat <= 0 || means[index] <= 0) return clean[index].precip > 0 ? 99 : 0
  const a = 6.75e-7 * heat ** 3 - 7.71e-5 * heat ** 2 + 1.792e-2 * heat + 0.49239
  const unadjusted = 16 * (10 * means[index] / heat) ** a
  const hours = daylightHours(latitude, MID_DAY[index])
  const pet = unadjusted * (DAYS[index] / 30) * (hours / 12)
  if (pet < 1) return clean[index].precip > 0 ? 99 : 0
  return clean[index].precip / pet
}

export function sanitizeMonth(month: MonthClimate): MonthClimate {
  return {
    high: clamp(month.high, -45, 55),
    low: clamp(month.low, -55, 45),
    precip: clamp(month.precip, 0, 800),
    humidity: clamp(month.humidity, 0, 100),
  }
}

function daylightHours(latitude: number, dayOfYear: number): number {
  const phi = (clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180
  const decl =
    ((23.45 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365)
  const cosHour = -Math.tan(phi) * Math.tan(decl)
  if (cosHour <= -1) return 24
  if (cosHour >= 1) return 0
  return (24 / Math.PI) * Math.acos(cosHour)
}

/** Thornthwaite PET (mm/year) and the aridity index P / PET. */
export function deriveClimate(latitude: number, monthsIn: MonthClimate[]): ClimateIndices {
  const clean = monthsIn.map(sanitizeMonth)
  const means = clean.map((month) => (month.high + month.low) / 2)
  let heat = 0
  for (const mean of means) {
    if (mean > 0) heat += (mean / 5) ** 1.514
  }
  const a =
    6.75e-7 * heat ** 3 -
    7.71e-5 * heat ** 2 +
    1.792e-2 * heat +
    0.49239
  let pet = 0
  if (heat > 0) {
    for (let i = 0; i < 12; i++) {
      const mean = means[i]
      if (mean <= 0) continue
      const unadjusted = 16 * (10 * mean / heat) ** a
      const hours = daylightHours(latitude, MID_DAY[i])
      pet += unadjusted * (DAYS[i] / 30) * (hours / 12)
    }
  }
  const annualPrecip = clean.reduce((sum, month) => sum + month.precip, 0)
  const meanTemp = means.reduce((sum, mean) => sum + mean, 0) / 12
  const frostFree = (month: MonthClimate) => month.low >= 4
  const frostMonths = clean.filter((month) => !frostFree(month)).length
  const growingMonths = clean.filter((month) => frostFree(month) && month.high >= 10).length
  const aridity = pet < 1 ? (annualPrecip > 0 ? 99 : 0) : annualPrecip / pet
  const summerIdx = latitude >= 0 ? [5, 6, 7] : [11, 0, 1]
  const summerHigh =
    summerIdx.reduce((sum, index) => sum + clean[index].high, 0) / 3
  return {
    annualPrecip,
    meanTemp,
    frostMonths,
    growingMonths,
    pet,
    aridity,
    summerHigh,
  }
}

/**
 * Fertility multiplier, 0.42–1.0.
 * Aridity reaches its full share at 1.05; growing season supplies the rest.
 */
export function climateFactor(indices: ClimateIndices): number {
  const aridityPart = clamp(indices.aridity / 1.05, 0, 1)
  const seasonPart = clamp(indices.growingMonths / 12, 0, 1)
  const mix = clamp(0.75 * aridityPart + 0.25 * seasonPart, 0, 1)
  return 0.42 + 0.58 * mix
}

export function aridityLabel(aridity: number): string {
  if (aridity < 0.05) return "Hyper-arid"
  if (aridity < 0.2) return "Arid"
  if (aridity < 0.5) return "Semi-arid"
  if (aridity < 0.65) return "Dry sub-humid"
  return "Humid"
}

export function formatGrowing(monthsCount: number): string {
  if (monthsCount >= 12) return "Year-round (12 months)"
  if (monthsCount <= 0) return "None"
  return monthsCount === 1 ? "1 month" : `${monthsCount} months`
}

export function formatFrost(monthsCount: number): string {
  if (monthsCount <= 0) return "None"
  return monthsCount === 1 ? "1 month" : `${monthsCount} months`
}

/** Shallow ponds in humid climates, deep basins only where it is arid. */
export function lakeMinDepth(aridity: number): number {
  const humid = smoothstep(0.08, 1.05, aridity)
  return 0.46 - 0.34 * humid
}
