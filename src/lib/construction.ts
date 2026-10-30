import type { Structure } from "@/lib/buildings"
import { noteOperatingIncome, OCCUPATION, Sex, type People } from "@/lib/people"

/** A new hire must be this age or younger. Men already on the crew may stay past it. */
export const HIRE_MAX_AGE = 55
const HIRE_MIN_AGE = 18

export type PublicWages = { e1: number; e2: number; e3: number }

export const DEFAULT_WAGES: PublicWages = { e1: 200, e2: 300, e3: 400 }

export type Hire = { id: number; year: number; month: number }

export type OfficeCrew = {
  structureId: number
  /** Authorized laborers: 0, 2, 4, 6, 8, or 10. Cuts take effect in January. */
  target: number
  /** Oldest hire first. */
  crew: Hire[]
}

export function emptyOffices(): OfficeCrew[] {
  return []
}

export function laborerIds(offices: readonly OfficeCrew[]): Set<number> {
  const ids = new Set<number>()
  for (const office of offices) for (const hire of office.crew) ids.add(hire.id)
  return ids
}

/** Whole even count from 0 through 10. */
export function clampWorkers(value: number): number {
  const even = Math.round(Math.max(0, value) / 2) * 2
  return Math.min(10, even)
}

export function setOfficeTarget(offices: readonly OfficeCrew[], structureId: number, target: number): OfficeCrew[] {
  const next = clampWorkers(target)
  if (!offices.some((office) => office.structureId === structureId)) {
    return [...offices, { structureId, target: next, crew: [] }]
  }
  return offices.map((office) => (office.structureId === structureId ? { ...office, target: next } : office))
}

/**
 * Drop men who died, retired, or took a working house. In January, fire the
 * newest hires down to the target. Then fill open jobs with unemployed men
 * from 18 through 55, lowest id first. In December, pay every man still on a
 * crew the E1 wage from the treasury.
 */
export function runConstruction(
  people: People,
  offices: readonly OfficeCrew[],
  structures: readonly Structure[],
  month: number,
  year: number,
  idMap: Int32Array | null,
  wage: number,
): { people: People; offices: OfficeCrew[]; paid: number } {
  const standing = new Map<number, Structure>()
  for (const structure of structures) {
    if (structure.kind !== "construction-office" || structure.removing) continue
    standing.set(structure.id, structure)
  }
  const taken = new Set<number>()
  const next: OfficeCrew[] = []
  for (const office of [...offices].sort((a, b) => a.structureId - b.structureId)) {
    if (!standing.has(office.structureId)) continue
    const crew: Hire[] = []
    for (const hire of office.crew) {
      const moved = remap(hire, idMap)
      if (!moved || !keepsJob(people, moved.id) || taken.has(moved.id)) continue
      taken.add(moved.id)
      crew.push(moved)
    }
    next.push({ structureId: office.structureId, target: clampWorkers(office.target), crew })
  }
  for (const structure of standing.values()) {
    if (next.some((office) => office.structureId === structure.id)) continue
    next.push({ structureId: structure.id, target: 0, crew: [] })
  }
  next.sort((a, b) => a.structureId - b.structureId)

  for (const office of next) {
    const structure = standing.get(office.structureId)
    if (!structure || structure.pending) continue
    if (month === 0 && office.crew.length > office.target) {
      const kept = [...office.crew].sort((a, b) => a.year - b.year || a.month - b.month || a.id - b.id).slice(0, office.target)
      for (const hire of office.crew) if (!kept.some((item) => item.id === hire.id)) taken.delete(hire.id)
      office.crew = kept
    }
    while (office.crew.length < office.target) {
      const id = seekLaborer(people, taken)
      if (id < 0) break
      taken.add(id)
      office.crew.push({ id, year, month })
    }
  }

  const wealth = new Int32Array(people.wealth)
  const income = new Int32Array(people.income)
  const incomeLog = new Int32Array(people.incomeLog)
  let paid = 0
  if (month === 11) {
    const yearly = Math.max(0, Math.floor(wage))
    for (const office of next) {
      const structure = standing.get(office.structureId)
      if (!structure || structure.pending) continue
      for (const hire of office.crew) {
        if (hire.id < 0 || hire.id >= wealth.length) continue
        wealth[hire.id] += yearly
        noteOperatingIncome(income, incomeLog, hire.id, yearly, month)
        paid += yearly
      }
    }
  }
  return { people: { ...people, wealth, income, incomeLog }, offices: next, paid }
}

function remap(hire: Hire, idMap: Int32Array | null): Hire | null {
  if (!idMap) return hire
  const id = hire.id < idMap.length ? idMap[hire.id] : -1
  if (id < 0) return null
  return { ...hire, id }
}

/** A laborer keeps the job while his house, if he has one, does not already employ him. */
function keepsJob(people: People, id: number): boolean {
  if (id < 0 || id >= people.alive.length || people.alive[id] === 0) return false
  if ((people.retired?.[id] ?? 0) !== 0) return false
  const job = people.occupation?.[id] ?? OCCUPATION.unemployed
  return job === OCCUPATION.unemployed || job === OCCUPATION.laborer
}

function seekLaborer(people: People, taken: ReadonlySet<number>): number {
  for (let id = 0; id < people.age.length; id++) {
    if (taken.has(id) || people.alive[id] === 0 || people.sex[id] !== Sex.Male) continue
    if (people.age[id] < HIRE_MIN_AGE || people.age[id] > HIRE_MAX_AGE) continue
    if ((people.retired?.[id] ?? 0) !== 0) continue
    if ((people.occupation?.[id] ?? OCCUPATION.unemployed) !== OCCUPATION.unemployed) continue
    return id
  }
  return -1
}
