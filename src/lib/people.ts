import type { Holding, Holdings } from "@/lib/land"
import { hashSeed, mulberry32 } from "@/lib/noise"

export const Sex = {
  Female: 0,
  Male: 1,
} as const

export type SexId = (typeof Sex)[keyof typeof Sex]

/** Adults are this old, inclusive. Offspring may be younger and still live at home. */
const MIN_ADULT_AGE = 18
/** A father hands the household to an adult eldest son from this birthday. */
const RETIRE_AGE = 65
/** Children younger than this can be adopted when both parents are dead. */
const ADOPT_AGE = 16
/** Working households set aside at most this share of the father's purse each January. */
const SEED_SHARE = 0.2
/** A daughter's wedding draws at most this share, once, under the same reserve. */
const DOWRY_SHARE = 0.1
const MAX_ADULT_AGE = 40
const MAX_AGE_GAP = 10
const MAX_CHILDREN = 8

/**
 * Chance a monthly try succeeds, chosen from the mother's age now.
 * A married woman aged 18–45 tries on 1/12 of months, so a year averages one try.
 */
export const MOTHER_FERTILITY: readonly { maxAge: number; chance: number }[] = [
  { maxAge: 25, chance: 0.4 },
  { maxAge: 35, chance: 0.3 },
  { maxAge: 45, chance: 0.2 },
]

const TRY_CHANCE = 1 / 12
const POSTPARTUM_MONTHS = 12

/** Monthly chance an unmarried man looks. He stops after the year he is 50. */
const MARRIAGE_LOOK: readonly { maxAge: number; chance: number }[] = [
  { maxAge: 22, chance: 0.01 },
  { maxAge: 35, chance: 0.02 },
  { maxAge: 50, chance: 0.01 },
]

/** She starts at 65%. Each advantage he holds, vigor or education, moves it by 15%. */
const MARRIAGE_BASE = 0.65
const MARRIAGE_COMPARE = 0.15
/** First list: this many years younger through this many years older. */
const PREFERRED_YOUNGER = 5
const PREFERRED_OLDER = 2
/** At 18–22 a miss widens only to wives 5 years older, not 10. */
const YOUNG_FALLBACK_OLDER = 5
/** From 23 on, a miss widens to 10 years either way. */
const WIDE_GAP = 10

/** A child takes one parent's score, or a wild 2, 1, or 3. */
const INHERIT_MOTHER = 0.4
const INHERIT_FATHER = 0.8
const INHERIT_TWO = 0.95
const INHERIT_ONE = 0.99

export const DIFFICULTIES = [
  { id: "easy", label: "Easy", tenths: 22 },
  { id: "medium", label: "Medium", tenths: 20 },
  { id: "hard", label: "Hard", tenths: 18 },
] as const

export type DifficultyId = (typeof DIFFICULTIES)[number]["id"]

const FOUNDER_TRAIT_BONUS = {
  warrior: { vigor: 1, intellect: 0, willpower: 1 },
  merchant: { vigor: 0, intellect: 1, willpower: 1 },
  explorer: { vigor: 1, intellect: 1, willpower: 1 },
} as const

export type People = {
  age: Uint8Array
  sex: Uint8Array
  birthMonth: Uint8Array
  /** Months still to skip, including the month about to be resolved. */
  cooldown: Uint8Array
  /** Static scores from 1 to 3. */
  vigor: Uint8Array
  intellect: Uint8Array
  willpower: Uint8Array
  /** 0 illiterate, 1 basic, 2 secondary. Higher levels can follow later. */
  education: Uint8Array
  /** Primary attendance, in tenths of a quality-weighted year. */
  primaryYears: Uint8Array
  /** Secondary attendance, in tenths of a quality-weighted year. */
  secondaryYears: Uint8Array
  /**
 * Current work. Student while on a school roll, then the job of the oldest
 * house the person or their spouse owns. A state laborer is written after that
 * when the house left him unemployed. Otherwise Idle under 18 and Unemployed at 18.
   */
  occupation: Uint8Array
  /** 1 while living. Dead rows stay until the January purge. */
  alive: Uint8Array
  /**
   * Trailing year of operating income. Sales and fees in, goods bought and
   * leases out. The first year is the year so far. Land purchases, inheritances,
   * and marriage transfers stay out of it.
   */
  income: Int32Array
  /** Twelve monthly operating results. Slot `id * 12 + month` is that calendar month. */
  incomeLog: Int32Array
  /** Whole dollars held by this person. A wife’s household money sits on her husband. */
  wealth: Int32Array
  spouse: Int32Array
  mother: Int32Array
  father: Int32Array
  /**
   * Retired parent or adopted child lives in this person's household.
   * −1 for everyone else. Biological parents stay on mother and father.
   */
  livesWith: Int32Array
  /** 1 after a parent has handed the household to a child. */
  retired: Uint8Array
}

/** Plots, prices, and the adult cost of living for one month of kinship. Founding passes null. */
export type KinBooks = {
  holdings: Holdings
  /** One household's full yearly cost, in whole dollars. */
  adultCost: number
  /** Food, clothing, and leather for one extra person, at three quarters of the adult rate. */
  memberCost: number
  /** Dollars the treasury pays to take a plot back. */
  salePrice: (structureId: number) => number
}

/** Stored in People.occupation. A person holds one of these at a time. */
export const OCCUPATION = {
  idle: 0,
  student: 1,
  farmer: 2,
  trader: 3,
  craftsman: 4,
  shopkeeper: 5,
  unemployed: 6,
  retired: 7,
  laborer: 8,
} as const

export const OCCUPATION_LABEL = [
  "Idle",
  "Student",
  "Farmer",
  "Trader",
  "Craftsman",
  "Shopkeeper",
  "Unemployed",
  "Retired",
  "Laborer",
] as const

/** A house someone lives in. The lowest id is the oldest, and that one sets the job. */
export type HouseholdHome = {
  id: number
  owner: number
  kind: "farmstead" | "market" | "trading-post" | "workshop" | "shack"
}

const HOME_JOB: Record<HouseholdHome["kind"], number> = {
  farmstead: OCCUPATION.farmer,
  "trading-post": OCCUPATION.trader,
  workshop: OCCUPATION.craftsman,
  market: OCCUPATION.shopkeeper,
  shack: OCCUPATION.unemployed,
}

/** Years a woman spends in each birth band. Matches the fertility table. */
const FERTILITY_BAND_YEARS = [8, 10, 10] as const

export type FertilityYear = {
  births: number
  deaths: number
  bandBirths: [number, number, number]
  /** Woman-months of exposure, ages 18–25, 26–35, and 36–45. */
  bandMonths: [number, number, number]
}

export type FertilityLedger = {
  year: number
  current: FertilityYear
  /** Null until a calendar year has closed. */
  lastBirths: number | null
  lastDeaths: number | null
  lastRate: number | null
}

export function motherFertility(age: number): number {
  for (const band of MOTHER_FERTILITY) {
    if (age <= band.maxAge) return band.chance
  }
  return MOTHER_FERTILITY[MOTHER_FERTILITY.length - 1].chance
}

function emptyFertilityYear(): FertilityYear {
  return { births: 0, deaths: 0, bandBirths: [0, 0, 0], bandMonths: [0, 0, 0] }
}

/** 0 for ages 18–25, 1 for 26–35, 2 for 36–45. */
function fertilityBand(age: number): number {
  if (age < MIN_ADULT_AGE || age > 45) return -1
  if (age <= 25) return 0
  if (age <= 35) return 1
  return 2
}

/**
 * Children per woman if each band's rate lasted for every year of that band.
 * Exposure is woman-months, so a partial year still speaks as an annual rate.
 */
export function fertilityRate(year: FertilityYear): number | null {
  let rate = 0
  let seen = false
  for (let band = 0; band < FERTILITY_BAND_YEARS.length; band++) {
    const months = year.bandMonths[band]
    if (months === 0) continue
    seen = true
    rate += (year.bandBirths[band] / (months / 12)) * FERTILITY_BAND_YEARS[band]
  }
  return seen ? rate : null
}

/** Count this resolved month. A newborn is age 0 and shares the month. */
export function observeMonth(year: FertilityYear, people: People, month: number, deaths: number): FertilityYear {
  const bandBirths: [number, number, number] = [...year.bandBirths]
  const bandMonths: [number, number, number] = [...year.bandMonths]
  let births = year.births
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0 || people.sex[i] !== Sex.Female) continue
    const band = fertilityBand(people.age[i])
    if (band >= 0) bandMonths[band] += 1
  }
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0 || people.age[i] !== 0 || people.birthMonth[i] !== month) continue
    births += 1
    const motherId = people.mother[i]
    if (motherId < 0) continue
    const band = fertilityBand(people.age[motherId])
    if (band >= 0) bandBirths[band] += 1
  }
  return { births, deaths: year.deaths + deaths, bandBirths, bandMonths }
}

/** Opening month is already resolved inside the founded population. */
export function beginFertility(year: number, month: number, people: People): FertilityLedger {
  let deaths = 0
  for (let i = 0; i < people.alive.length; i++) if (people.alive[i] === 0) deaths += 1
  return {
    year,
    current: observeMonth(emptyFertilityYear(), people, month, deaths),
    lastBirths: null,
    lastDeaths: null,
    lastRate: null,
  }
}

/** Fold in one month. A new calendar year closes the previous one first. */
export function noteMonth(
  ledger: FertilityLedger,
  year: number,
  month: number,
  people: People,
  deaths: number,
): FertilityLedger {
  if (year === ledger.year) {
    return { ...ledger, current: observeMonth(ledger.current, people, month, deaths) }
  }
  return {
    year,
    current: observeMonth(emptyFertilityYear(), people, month, deaths),
    lastBirths: ledger.current.births,
    lastDeaths: ledger.current.deaths,
    lastRate: fertilityRate(ledger.current),
  }
}

export type CitizenCensus = {
  averageAge: number
  averageVigor: number
  averageIntellect: number
  averageWillpower: number
  children: number
  infants: number
  kids: number
  teens: number
  adults: number
  youth: number
  youngAdults: number
  matureAdults: number
  elderly: number
}

/**
 * Citizens only. Children are 0–17 (infants 0–5, kids 6–12, teens 13–17).
 * Adults are 18–64 (youth 18–26, young adults 27–40, mature adults 41–64).
 * Elderly are 65 and older.
 */
export function citizenCensus(people: People): CitizenCensus {
  let sum = 0
  let vigor = 0
  let intellect = 0
  let willpower = 0
  let infants = 0
  let kids = 0
  let teens = 0
  let youth = 0
  let youngAdults = 0
  let matureAdults = 0
  let elderly = 0
  let count = 0
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0) continue
    count += 1
    const age = people.age[i]
    sum += age
    vigor += people.vigor[i]
    intellect += people.intellect[i]
    willpower += people.willpower[i]
    if (age <= 5) infants += 1
    else if (age <= 12) kids += 1
    else if (age <= 17) teens += 1
    else if (age <= 26) youth += 1
    else if (age <= 40) youngAdults += 1
    else if (age <= 64) matureAdults += 1
    else elderly += 1
  }
  return {
    averageAge: count === 0 ? 0 : sum / count,
    averageVigor: count === 0 ? 0 : vigor / count,
    averageIntellect: count === 0 ? 0 : intellect / count,
    averageWillpower: count === 0 ? 0 : willpower / count,
    children: infants + kids + teens,
    infants,
    kids,
    teens,
    adults: youth + youngAdults + matureAdults,
    youth,
    youngAdults,
    matureAdults,
    elderly,
  }
}

export type EducationCensus = {
  primaryStudents: number
  secondaryStudents: number
  /** Living people aged 18 and older. */
  adults: number
  literateAdults: number
  secondaryAdults: number
}

/** School rolls are not running yet, so enrolled students stay at zero. */
export function educationCensus(people: People): EducationCensus {
  let adults = 0
  let literateAdults = 0
  let secondaryAdults = 0
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0 || people.age[i] < MIN_ADULT_AGE) continue
    adults += 1
    if (people.education[i] >= 1) literateAdults += 1
    if (people.education[i] >= 2) secondaryAdults += 1
  }
  return { primaryStudents: 0, secondaryStudents: 0, adults, literateAdults, secondaryAdults }
}

export type EconomyCensus = {
  /** Sum of wealth held by living people. */
  total: number
  familyAverage: number | null
  familyMedian: number | null
  singleAverage: number | null
  singleMedian: number | null
  /** Living people whose occupation is Unemployed. */
  unemployed: number
  /** Unemployed divided by people 18 and older who are not students. Null when that group is empty. */
  unemploymentRate: number | null
}

/**
 * Private wealth. A family is a household with a living couple.
 * While a father is alive and under 65, his eldest son, that son's wife, and their
 * children are part of his household. Singles are household heads with no living spouse.
 */
export function economyCensus(people: People, homes: readonly HouseholdHome[] = []): EconomyCensus {
  let total = 0
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0) continue
    total += people.wealth[i]
  }

  const families: number[] = []
  const singles: number[] = []
  for (const unit of households(people, homes)) {
    if (unit.couple) families.push(unit.wealth)
    else if (people.age[unit.head] >= MIN_ADULT_AGE) singles.push(unit.wealth)
  }

  let unemployed = 0
  let labor = 0
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0 || people.age[i] < MIN_ADULT_AGE) continue
    const job = people.occupation?.[i] ?? OCCUPATION.unemployed
    if (job === OCCUPATION.student) continue
    labor += 1
    if (job === OCCUPATION.unemployed) unemployed += 1
  }

  return {
    total,
    familyAverage: average(families),
    familyMedian: median(families),
    singleAverage: average(singles),
    singleMedian: median(singles),
    unemployed,
    unemploymentRate: labor === 0 ? null : unemployed / labor,
  }
}

/** Houses already in place, with the person who owns each one. */
export function householdHomes(
  structures: readonly { id: number; kind: string; pending: boolean; removing: boolean }[],
  holdings: readonly { structureId: number; owner: number }[],
): HouseholdHome[] {
  const ownerOf = new Map<number, number>()
  for (const row of holdings) if (row.owner >= 0) ownerOf.set(row.structureId, row.owner)
  const homes: HouseholdHome[] = []
  for (const structure of structures) {
    if (structure.pending || structure.removing) continue
    if (
      structure.kind !== "farmstead" &&
      structure.kind !== "market" &&
      structure.kind !== "trading-post" &&
      structure.kind !== "workshop" &&
      structure.kind !== "shack"
    ) {
      continue
    }
    const owner = ownerOf.get(structure.id)
    if (owner === undefined) continue
    homes.push({ id: structure.id, owner, kind: structure.kind })
  }
  return homes
}

/**
 * Write one occupation for each person. Retired wins, then a school seat.
 * Otherwise the owner of a house and their living spouse take that house's job,
 * and so do the eldest son still in his father's house and that son's wife.
 * The oldest house wins when the household owns more than one. Everyone else
 * is Idle under 18 and Unemployed at 18. A listed laborer whose house did not
 * give him a job is then a Laborer.
 */
const NO_LABORERS: ReadonlySet<number> = new Set()

export function assignOccupations(
  people: People,
  homes: readonly HouseholdHome[],
  schools: SchoolSession = NO_SCHOOLS,
  laborers: ReadonlySet<number> = NO_LABORERS,
): People {
  const byOwner = new Map<number, { id: number; job: number }[]>()
  for (const home of homes) {
    const list = byOwner.get(home.owner) ?? []
    list.push({ id: home.id, job: HOME_JOB[home.kind] })
    byOwner.set(home.owner, list)
  }
  const owned = ownersOf(homes)
  const headOf = residenceMap(people, owned)
  const eldest = eldestByFather(people)
  const students = new Set<number>()
  for (const seat of schools.primary) students.add(seat.student)
  for (const seat of schools.secondary) students.add(seat.student)
  const occupation = new Uint8Array(people.age.length)
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0) continue
    if ((people.retired?.[i] ?? 0) !== 0) {
      occupation[i] = OCCUPATION.retired
      continue
    }
    if (students.has(i)) {
      occupation[i] = OCCUPATION.student
      continue
    }
    const job = householdJob(people, byOwner, i) ?? heirJob(people, byOwner, headOf, eldest, i)
    if (job !== null) occupation[i] = job
    else occupation[i] = people.age[i] < MIN_ADULT_AGE ? OCCUPATION.idle : OCCUPATION.unemployed
    if (laborers.has(i) && occupation[i] === OCCUPATION.unemployed) occupation[i] = OCCUPATION.laborer
  }
  return { ...people, occupation }
}

/**
 * Couples who form their own household and have no house, and household heads
 * with no living spouse who do not own one. A son still living in his father's
 * house is not a second homeless family. Students are left out of the second count.
 */
export function residenceCensus(
  people: People,
  homes: readonly HouseholdHome[],
): { homelessFamilies: number; homelessSingles: number } {
  const owners = ownersOf(homes)
  const headOf = residenceMap(people, owners)
  let homelessFamilies = 0
  let homelessSingles = 0
  for (let i = 0; i < people.age.length; i++) {
    if (people.alive[i] === 0) continue
    const mate = people.spouse[i]
    const mateAlive = isAlive(people, mate)
    if (mateAlive) {
      if (headOf[i] !== i) continue
      if (!owners.has(i) && !owners.has(mate)) homelessFamilies += 1
      continue
    }
    if (people.age[i] < MIN_ADULT_AGE || headOf[i] !== i) continue
    if ((people.occupation?.[i] ?? OCCUPATION.unemployed) === OCCUPATION.student) continue
    if ((people.retired?.[i] ?? 0) !== 0) continue
    if (!owners.has(i)) homelessSingles += 1
  }
  return { homelessFamilies, homelessSingles }
}

export type ClassCensus = {
  /** Families and single adults. A child living with a parent is part of that household. */
  units: number
  incomeAverage: number | null
  incomeMedian: number | null
  poor: number
  working: number
  middle: number
  upper: number
  wealthy: number
}

/**
 * The full cost once per household, plus the smaller food and clothing share
 * for every other person there. Wealthy through working are tested from the top.
 * Poor is whatever is left.
 */
export function classCensus(people: People, adultCost: number, memberCost: number, homes: readonly HouseholdHome[] = []): ClassCensus {
  const incomes: number[] = []
  const counts = { poor: 0, working: 0, middle: 0, upper: 0, wealthy: 0 }
  for (const unit of households(people, homes)) {
    incomes.push(unit.income)
    counts[classify(unit.income, unit.wealth, householdCost(adultCost, memberCost, unit.size))] += 1
  }
  return {
    units: incomes.length,
    incomeAverage: average(incomes),
    incomeMedian: median(incomes),
    ...counts,
  }
}

function householdCost(full: number, member: number, size: number): number {
  return Math.round(full + member * Math.max(0, size - 1))
}

/** Class of each household head, and the head every living person follows. */
export function householdRanks(
  people: People,
  adultCost: number,
  memberCost: number,
  homes: readonly HouseholdHome[],
): { rank: Map<number, SocialClass>; headOf: Int32Array } {
  const headOf = residenceMap(people, ownersOf(homes))
  const rank = new Map<number, SocialClass>()
  for (const unit of households(people, homes)) {
    rank.set(unit.head, classify(unit.income, unit.wealth, householdCost(adultCost, memberCost, unit.size)))
  }
  return { rank, headOf }
}

export type SocialClass = "poor" | "working" | "middle" | "upper" | "wealthy"

function classify(income: number, wealth: number, cost: number): SocialClass {
  const line = Math.max(0, cost)
  if (income > 20 * line || wealth > 100 * line) return "wealthy"
  if (income > 3 * line || wealth >= 15 * line) return "upper"
  if (income >= 1.5 * line || wealth >= 5 * line) return "middle"
  if (income >= line || wealth >= line) return "working"
  return "poor"
}

type HouseholdRoll = {
  head: number
  couple: boolean
  income: number
  wealth: number
  size: number
}

function households(people: People, homes: readonly HouseholdHome[]): HouseholdRoll[] {
  const owned = ownersOf(homes)
  const headOf = residenceMap(people, owned)
  const members = new Map<number, number[]>()
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0) continue
    const head = headOf[id]
    if (head < 0) continue
    const list = members.get(head) ?? []
    list.push(id)
    members.set(head, list)
  }
  const units: HouseholdRoll[] = []
  for (const [head, list] of members) {
    if (people.alive[head] === 0) continue
    const mate = people.spouse[head]
    const couple = isAlive(people, mate) && headOf[mate] === head
    let income = 0
    let wealth = 0
    for (const id of list) {
      income += people.income?.[id] ?? 0
      wealth += people.wealth[id] ?? 0
    }
    units.push({ head, couple, income, wealth, size: list.length })
  }
  return units
}

function householdJob(
  people: People,
  byOwner: Map<number, { id: number; job: number }[]>,
  id: number,
): number | null {
  const mate = people.spouse[id]
  const mateAlive = isAlive(people, mate)
  const homes = [...(byOwner.get(id) ?? []), ...(mateAlive ? (byOwner.get(mate) ?? []) : [])]
  if (homes.length === 0) return null
  let best = homes[0]
  for (const home of homes) if (home.id < best.id) best = home
  return best.job
}

/** The house job of the father an heir still lives with. */
function heirJob(
  people: People,
  byOwner: Map<number, { id: number; job: number }[]>,
  headOf: Int32Array,
  eldest: Int32Array,
  id: number,
): number | null {
  const head = headOf[id]
  if (head < 0 || head === id) return null
  const heir = eldest[head]
  if (heir < 0 || headOf[heir] !== head) return null
  const wife = people.spouse[heir]
  if (id !== heir && id !== wife) return null
  return householdJob(people, byOwner, head)
}

function ownersOf(homes: readonly HouseholdHome[]): Set<number> {
  const owners = new Set<number>()
  for (const home of homes) if (home.owner >= 0) owners.add(home.owner)
  return owners
}

function ownersFromRows(rows: readonly Holding[]): Set<number> {
  const owners = new Set<number>()
  for (const row of rows) if (row.owner >= 0) owners.add(row.owner)
  return owners
}

/**
 * Men who may take a vacant plot. A married head who keeps his own house,
 * a widow who is her own head, and a landless man of 18 who is not a student
 * and not the eldest son still in his father's house.
 */
export function propertySeekers(people: People, owned: ReadonlySet<number>): number[] {
  const headOf = residenceMap(people, owned)
  const eldest = eldestByFather(people)
  const seekers: number[] = []
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0 || (people.retired?.[id] ?? 0) !== 0) continue
    if (owned.has(id)) continue
    const mate = people.spouse[id]
    const mateAlive = isAlive(people, mate)
    if (mateAlive && owned.has(mate)) continue
    if (mateAlive) {
      if (people.sex[id] === Sex.Male && headOf[id] === id) seekers.push(id)
      continue
    }
    if (people.age[id] < MIN_ADULT_AGE) continue
    if (people.sex[id] === Sex.Female) {
      if (headOf[id] === id) seekers.push(id)
      continue
    }
    if ((people.occupation?.[id] ?? OCCUPATION.unemployed) === OCCUPATION.student) continue
    if (foldedHeir(people, eldest, id)) continue
    seekers.push(id)
  }
  return seekers
}

function isAlive(people: People, id: number): boolean {
  return id >= 0 && id < people.alive.length && people.alive[id] !== 0
}

/** Eldest living son of each father, or −1. Oldest age wins, then the lower id. */
function eldestByFather(people: People): Int32Array {
  const best = new Int32Array(people.age.length)
  best.fill(-1)
  for (let id = 0; id < people.age.length; id++) {
    if (people.alive[id] === 0 || people.sex[id] !== Sex.Male) continue
    const dad = people.father[id]
    if (!isAlive(people, dad)) continue
    const current = best[dad]
    if (current < 0 || people.age[id] > people.age[current] || (people.age[id] === people.age[current] && id < current)) {
      best[dad] = id
    }
  }
  return best
}

/** The eldest son follows his father while that father is alive, under 65, and not retired. */
function foldedHeir(people: People, eldest: Int32Array, id: number): boolean {
  if (people.sex[id] !== Sex.Male || (people.retired?.[id] ?? 0) !== 0) return false
  const dad = people.father[id]
  if (!isAlive(people, dad) || (people.retired?.[dad] ?? 0) !== 0 || people.age[dad] >= RETIRE_AGE) return false
  return eldest[dad] === id
}

/**
 * Household head of each living person. A wife follows her husband. The eldest
 * son follows his father while the father is alive and under 65, unless that son
 * already owns a plot. Retired parents and adopted children follow livesWith.
 * An unmarried landless child follows a living parent.
 */
function residenceMap(people: People, owned: ReadonlySet<number>): Int32Array {
  const count = people.age.length
  const eldest = eldestByFather(people)
  const head = new Int32Array(count)
  head.fill(-2)
  const state = new Uint8Array(count)
  const resolve = (id: number): number => {
    if (!isAlive(people, id)) return -1
    if (state[id] === 2) return head[id]
    if (state[id] === 1) return id
    state[id] = 1
    head[id] = chooseHead(people, owned, eldest, id, resolve)
    state[id] = 2
    return head[id]
  }
  for (let id = 0; id < count; id++) if (people.alive[id] !== 0) resolve(id)
  return head
}

function chooseHead(
  people: People,
  owned: ReadonlySet<number>,
  eldest: Int32Array,
  id: number,
  resolve: (id: number) => number,
): number {
  const withId = people.livesWith?.[id] ?? -1
  if ((people.retired?.[id] ?? 0) !== 0 && isAlive(people, withId)) return resolve(withId)
  const mate = people.spouse[id]
  if (people.sex[id] === Sex.Female && isAlive(people, mate)) return resolve(mate)
  if (foldedHeir(people, eldest, id) && !owned.has(id)) return resolve(people.father[id])
  if ((people.retired?.[id] ?? 0) === 0 && withId >= 0 && isAlive(people, withId) && !owned.has(id)) {
    return resolve(withId)
  }
  if (!isAlive(people, mate) && !owned.has(id)) {
    const dad = people.father[id]
    if (isAlive(people, dad)) return resolve(dad)
    const mom = people.mother[id]
    if (isAlive(people, mom)) return resolve(mom)
  }
  return id
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Founding households. Each is a woman and a man, ages 18–40, at most 10 years apart.
 * Childbearing years follow the younger spouse. Each of those years rolls once at the
 * mother's current fertility, with at most one child per year and eight children total.
 * Birthdays are spread across the year. Parents roll vigor, intellect, and willpower
 * from the difficulty. Children inherit. The opening month is resolved first.
 * Ages 6 and older then roll an education level from their intellect.
 * The father then starts the household purse from that education and his age.
 * Children of 16 or 17 start with $50, and unmarried children of 18 or older with $100.
 * The same seed and founder always rebuild it.
 */
export function foundPeople(
  seed: string,
  founderId: string,
  families: number,
  openingYear: number,
  openingMonth: number,
  difficulty: DifficultyId,
): { people: People; epidemic: Epidemic } {
  const rng = mulberry32(hashSeed(`${seed}|${founderId}|families`))
  const age: number[] = []
  const sex: number[] = []
  const birthMonth: number[] = []
  const cooldown: number[] = []
  const vigor: number[] = []
  const intellect: number[] = []
  const willpower: number[] = []
  const spouse: number[] = []
  const mother: number[] = []
  const father: number[] = []

  for (let family = 0; family < families; family++) {
    const couple = rollCouple(rng)
    const motherId = age.length
    const fatherId = motherId + 1
    add(age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father, couple.mother, Sex.Female, fatherId, -1, -1)
    add(age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father, couple.father, Sex.Male, motherId, -1, -1)

    const younger = Math.min(couple.mother, couple.father)
    const chance = motherFertility(couple.mother)
    let children = 0
    for (let bornWhenYoungerWas = MIN_ADULT_AGE; bornWhenYoungerWas <= younger; bornWhenYoungerWas++) {
      if (rng() >= chance) continue
      const childAge = younger - bornWhenYoungerWas
      const childSex = rng() < 0.5 ? Sex.Female : Sex.Male
      add(age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father, childAge, childSex, -1, motherId, fatherId)
      children += 1
      if (children >= MAX_CHILDREN) break
    }
  }

  const means = traitMeans(difficulty, founderId)
  const traits = mulberry32(hashSeed(`${seed}|${founderId}|${difficulty}|traits`))
  for (let i = 0; i < age.length; i++) {
    if (mother[i] < 0) {
      vigor[i] = parentTrait(means.vigor, traits)
      intellect[i] = parentTrait(means.intellect, traits)
      willpower[i] = parentTrait(means.willpower, traits)
    } else {
      const mom = mother[i]
      const dad = father[i]
      vigor[i] = inheritTrait(vigor[mom], vigor[dad], traits)
      intellect[i] = inheritTrait(intellect[mom], intellect[dad], traits)
      willpower[i] = inheritTrait(willpower[mom], willpower[dad], traits)
    }
  }

  const birthdays = mulberry32(hashSeed(`${seed}|${founderId}|birthdays`))
  for (let i = 0; i < birthMonth.length; i++) birthMonth[i] = Math.floor(birthdays() * 12)
  for (let i = 0; i < age.length; i++) {
    if (mother[i] < 0 || age[i] !== 0) continue
    cooldown[mother[i]] = postpartumRemaining(openingMonth, birthMonth[i])
  }

  const step = advancePeople(
    pack(age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father),
    openingYear,
    openingMonth,
    seed,
    emptyEpidemic(),
  )
  const schooling = mulberry32(hashSeed(`${seed}|${founderId}|education`))
  const people = step.people
  for (let i = 0; i < people.age.length; i++) {
    people.education[i] = foundingEducation(people.age[i], people.intellect[i], schooling)
  }
  grantFoundingWealth(people, founderId)
  return { people, epidemic: step.epidemic }
}

/** Town illness. A declaration waits until the following month, then runs for its rolled length. */
export type Epidemic = {
  /** Boosted months left after the month just resolved. */
  remaining: number
  /** The month just resolved used the epidemic illness rules. */
  active: boolean
  /** Length of a wave that begins next month, or 0 if none was declared. */
  declared: number
}

export function emptyEpidemic(): Epidemic {
  return { remaining: 0, active: false, declared: 0 }
}

const EPIDEMIC_CHANCE = 0.001
const EPIDEMIC_ILLNESS = 10
const EPIDEMIC_KILL = 10
const EPIDEMIC_MIN_MONTHS = 2
const EPIDEMIC_MAX_MONTHS = 6

export type MonthStep = {
  people: People
  /** Deaths resolved this month, before the January purge. */
  deaths: number
  epidemic: Epidemic
  /** Dollars left with no heir, minus what the treasury pays to buy a plot back. */
  toTreasury: number
  /** Old person id to new id after the January purge. Null when nobody was removed. */
  idMap: Int32Array | null
  /** Plot book after succession and sales. Null when this month had no land to settle. */
  holdings: Holdings | null
}

/** A student finishing the school year, and that school's quality from 0 to 100. */
export type SchoolSeat = {
  student: number
  quality: number
}

/** Who attended this September–June year. Empty until a school is built. */
export type SchoolSession = {
  primary: readonly SchoolSeat[]
  secondary: readonly SchoolSeat[]
}

const NO_SCHOOLS: SchoolSession = { primary: [], secondary: [] }

/** Calendar months are 0 = January. School lets out in June. */
const JUNE = 5
/** Attendance is stored in tenths of a credit, so a poor year is 5 and a fine year is 12. */
const CREDIT_TENTHS = 10
/** Primary pass bands: 2.5 credits, 3.1 credits, and 5.0 credits. */
const PRIMARY_LIKELY = 25
const PRIMARY_STEADY = 31
const PRIMARY_SURE = 50
/** A 17-year-old needs 3.0 secondary credits. An 18-year-old needs 2.0. */
const EARLY_SECONDARY = 30
const FINAL_SECONDARY = 20
/** The age-18 multiplier stops rising after 6.0 credits. */
const SECONDARY_CAP = 60

/**
 * Tenths of a credit for one finished year at this quality.
 * Quality 20 and below is half a year. From there it rises to 1.2 at quality 100.
 */
export function schoolYearTenths(quality: number): number {
  if (!Number.isFinite(quality)) return 5
  const q = Math.max(0, Math.min(100, quality))
  if (q <= 20) return 5
  const multiplier = 0.5 + (0.7 * (q - 20)) / 80
  return Math.round(multiplier * CREDIT_TENTHS)
}

/**
 * Resolve the start of one calendar month. Living people age on their birthday.
 * An epidemic declared last month raises illness, and the kill chance of that illness,
 * for its rolled length. Each person then rolls illness and injury. A hit rolls again
 * for death. An adult eldest son then takes a father's house, at the father's death
 * or from the birthday the father is 65. A widow holds it until that son is 18.
 * Plots move with the purse when a land book was passed in. The dead stay in the
 * table, so spouse and parent ids keep working.
 * In June, enrolled students bank one quality-weighted school credit, then ages 12, 17,
 * and 18 sit their exams. In January, working fathers seed landless younger sons.
 * An eldest son still at home, or a man who owns a plot, may marry. A bride's father
 * may pay a dowry. Living wives aged 18–45 may try for a child. A birth skips her for
 * the next 12 months. In January, a dead person whom no living spouse, child, or
 * household still points at is removed and the remaining ids are rewritten.
 * A new epidemic may be declared for the following month.
 * The same people, seed, year, and month always rebuild the same result.
 */
export function advancePeople(
  people: People,
  year: number,
  month: number,
  seed: string,
  epidemic: Epidemic,
  schools: SchoolSession = NO_SCHOOLS,
  kin: KinBooks | null = null,
): MonthStep {
  const count = people.age.length
  const age = new Uint8Array(people.age)
  const sex = new Uint8Array(people.sex)
  const birthMonth = new Uint8Array(people.birthMonth)
  const cooldown = new Uint8Array(people.cooldown)
  const vigor = new Uint8Array(people.vigor)
  const intellect = new Uint8Array(people.intellect)
  const willpower = new Uint8Array(people.willpower)
  const education = new Uint8Array(people.education)
  const primaryYears = new Uint8Array(people.primaryYears)
  const secondaryYears = new Uint8Array(people.secondaryYears)
  const occupation = occupationColumn(people, count)
  const alive = new Uint8Array(people.alive)
  const income = new Int32Array(people.income ?? count)
  const incomeLog = copyIncomeLog(people, count)
  const wealth = new Int32Array(people.wealth)
  const spouse = new Int32Array(people.spouse)
  const mother = new Int32Array(people.mother)
  const father = new Int32Array(people.father)
  const livesWith = livesWithColumn(people, count)
  const retired = retiredColumn(people, count)
  const rows = kin ? kin.holdings.rows.map((row) => ({ ...row })) : null
  const wave = resolveEpidemic(epidemic, year, month, seed)

  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) continue
    if (birthMonth[i] === month && age[i] < 255) age[i] += 1
  }

  const deathRng = mulberry32(hashSeed(`${seed}|${year}|${month}|deaths`))
  let deaths = 0
  const died: number[] = []
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) continue
    const hazard = monthlyHazards(age[i], sex[i], vigor[i], intellect[i])
    const kill = killChance(age[i], sex[i])
    const illness = wave.active ? hazard.illness * EPIDEMIC_ILLNESS : hazard.illness
    const illnessKill = wave.active ? Math.min(0.9, kill * EPIDEMIC_KILL) : kill
    const ill = deathRng() < illness
    const inj = deathRng() < hazard.injury
    let dead = false
    if (ill) dead = deathRng() < illnessKill
    if (inj) dead = deathRng() < kill || dead
    if (!dead) continue
    alive[i] = 0
    deaths += 1
    died.push(i)
  }

  const books = settleKin(
    {
      wealth,
      alive,
      sex,
      age,
      spouse,
      mother,
      father,
      livesWith,
      retired,
      income,
      rows,
      adultCost: kin?.adultCost ?? 0,
      memberCost: kin?.memberCost ?? 0,
      salePrice: kin?.salePrice ?? (() => 0),
      toTreasury: 0,
    },
    died,
  )

  if (month === JUNE) {
    resolveJuneSchooling(
      age,
      intellect,
      willpower,
      education,
      primaryYears,
      secondaryYears,
      alive,
      mother,
      father,
      year,
      seed,
      schools,
    )
  }

  if (kin && month === 0) seedSons(books)

  const marriages = mulberry32(hashSeed(`${seed}|${year}|${month}|marriages`))
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0 || sex[i] !== Sex.Male || spouse[i] >= 0) continue
    if (!maySeekWife(books, i)) continue
    const look = marriageLookChance(age[i])
    if (look === 0 || marriages() >= look) continue
    const wife = pickWife(i, age, sex, alive, spouse, retired, mother, father, marriages)
    if (wife < 0) continue
    const accept = marriageAcceptChance(vigor[i], vigor[wife], education[i], education[wife])
    if (marriages() >= accept) continue
    spouse[i] = wife
    spouse[wife] = i
    wealth[i] += wealth[wife]
    wealth[wife] = 0
    mergeIncome(income, incomeLog, i, wife)
    movePlots(books, [wife], i, "spill")
    if (kin) payDowry(books, wife, i)
    retireChildlessFather(books, wife)
  }

  const rng = mulberry32(hashSeed(`${seed}|${year}|${month}|births`))
  const traitRng = mulberry32(hashSeed(`${seed}|${year}|${month}|traits`))
  const born: { motherId: number; fatherId: number; childSex: SexId; vigor: number; intellect: number; willpower: number }[] = []
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) continue
    if (cooldown[i] > 0) {
      cooldown[i] -= 1
      continue
    }
    if (sex[i] !== Sex.Female || age[i] < MIN_ADULT_AGE || age[i] > 45) continue
    const fatherId = spouse[i]
    if (fatherId < 0 || alive[fatherId] === 0) continue
    if (rng() >= TRY_CHANCE) continue
    if (rng() >= motherFertility(age[i])) continue
    born.push({
      motherId: i,
      fatherId,
      childSex: rng() < 0.5 ? Sex.Female : Sex.Male,
      vigor: inheritTrait(vigor[i], vigor[fatherId], traitRng),
      intellect: inheritTrait(intellect[i], intellect[fatherId], traitRng),
      willpower: inheritTrait(willpower[i], willpower[fatherId], traitRng),
    })
    cooldown[i] = POSTPARTUM_MONTHS
  }

  let next: People
  if (born.length === 0) {
    next = {
      age,
      sex,
      birthMonth,
      cooldown,
      vigor,
      intellect,
      willpower,
      education,
      primaryYears,
      secondaryYears,
      occupation,
      alive,
      income,
      incomeLog,
      wealth,
      spouse,
      mother,
      father,
      livesWith,
      retired,
    }
  } else {
    const grownCount = count + born.length
    const grown = {
      age: new Uint8Array(grownCount),
      sex: new Uint8Array(grownCount),
      birthMonth: new Uint8Array(grownCount),
      cooldown: new Uint8Array(grownCount),
      vigor: new Uint8Array(grownCount),
      intellect: new Uint8Array(grownCount),
      willpower: new Uint8Array(grownCount),
      education: new Uint8Array(grownCount),
      primaryYears: new Uint8Array(grownCount),
      secondaryYears: new Uint8Array(grownCount),
      occupation: new Uint8Array(grownCount),
      alive: new Uint8Array(grownCount),
      income: new Int32Array(grownCount),
      incomeLog: new Int32Array(grownCount * 12),
      wealth: new Int32Array(grownCount),
      spouse: new Int32Array(grownCount),
      mother: new Int32Array(grownCount),
      father: new Int32Array(grownCount),
      livesWith: new Int32Array(grownCount),
      retired: new Uint8Array(grownCount),
    }
    grown.age.set(age)
    grown.sex.set(sex)
    grown.birthMonth.set(birthMonth)
    grown.cooldown.set(cooldown)
    grown.vigor.set(vigor)
    grown.intellect.set(intellect)
    grown.willpower.set(willpower)
    grown.education.set(education)
    grown.primaryYears.set(primaryYears)
    grown.secondaryYears.set(secondaryYears)
    grown.occupation.set(occupation)
    grown.alive.set(alive)
    grown.income.set(income)
    grown.incomeLog.set(incomeLog)
    grown.wealth.set(wealth)
    grown.spouse.set(spouse)
    grown.mother.set(mother)
    grown.father.set(father)
    grown.livesWith.set(livesWith)
    grown.livesWith.fill(-1, count)
    grown.retired.set(retired)
    for (let i = 0; i < born.length; i++) {
      const at = count + i
      const child = born[i]
      grown.age[at] = 0
      grown.sex[at] = child.childSex
      grown.birthMonth[at] = month
      grown.vigor[at] = child.vigor
      grown.intellect[at] = child.intellect
      grown.willpower[at] = child.willpower
      grown.education[at] = 0
      grown.primaryYears[at] = 0
      grown.secondaryYears[at] = 0
      grown.alive[at] = 1
      grown.income[at] = 0
      grown.wealth[at] = 0
      grown.spouse[at] = -1
      grown.mother[at] = child.motherId
      grown.father[at] = child.fatherId
      grown.livesWith[at] = -1
      grown.retired[at] = 0
    }
    next = grown
  }

  let idMap: Int32Array | null = null
  if (month === 0) {
    const purged = purgeUnlinkedDead(next)
    next = purged.people
    idMap = purged.idMap
  }
  const holdings = rows && kin ? { opened: kin.holdings.opened, rows } : null
  return { people: next, deaths, epidemic: wave, toTreasury: books.toTreasury, idMap, holdings }
}

/** A declared wave starts this month. A new roll, if it hits, waits until next month. */
function resolveEpidemic(previous: Epidemic, year: number, month: number, seed: string): Epidemic {
  const scheduled = previous.declared > 0 ? previous.declared : previous.remaining
  const active = scheduled > 0
  const remaining = active ? scheduled - 1 : 0
  const rng = mulberry32(hashSeed(`${seed}|${year}|${month}|epidemic`))
  const span = EPIDEMIC_MAX_MONTHS - EPIDEMIC_MIN_MONTHS + 1
  const declared = rng() < EPIDEMIC_CHANCE ? EPIDEMIC_MIN_MONTHS + Math.floor(rng() * span) : 0
  return { remaining, active, declared }
}

/** Sentence for the current month, or null when no epidemic is scheduled or underway. */
export function epidemicNotice(epidemic: Epidemic): string | null {
  if (epidemic.declared > 0) {
    const length = monthCount(epidemic.declared)
    if (epidemic.active) {
      return `A new epidemic starts next month and lasts ${length}. This month is still part of the current one.`
    }
    return `An epidemic starts next month and lasts ${length}.`
  }
  if (!epidemic.active) return null
  return `The epidemic has ${monthCount(epidemic.remaining + 1)} left.`
}

function monthCount(count: number): string {
  return count === 1 ? "1 month" : `${count} months`
}

/** Living citizens. Dead rows still sitting in the table are not counted. */
export function livingCount(people: People): number {
  let count = 0
  for (let i = 0; i < people.alive.length; i++) if (people.alive[i] !== 0) count += 1
  return count
}

type KinState = {
  wealth: Int32Array
  alive: Uint8Array
  sex: Uint8Array
  age: Uint8Array
  spouse: Int32Array
  mother: Int32Array
  father: Int32Array
  livesWith: Int32Array
  retired: Uint8Array
  income: Int32Array
  rows: Holding[] | null
  adultCost: number
  memberCost: number
  salePrice: (structureId: number) => number
  toTreasury: number
}

/**
 * Living fathers hand the house to an adult eldest son from age 65. A widow
 * does the same when that son turns 18. Deaths then move the purse and the
 * plots: an adult son, else a living spouse, else an adopting sibling, else
 * the children, else siblings, else the treasury.
 */
function settleKin(state: KinState, died: readonly number[]): KinState {
  handLivingHouseholds(state)
  const ordered = [...died].sort((a, b) => state.sex[b] - state.sex[a] || a - b)
  const seen = new Set<number>()
  for (const dead of ordered) {
    if (seen.has(dead)) continue
    settleDead(state, dead, seen)
  }
  return state
}

function handLivingHouseholds(state: KinState) {
  for (let id = 0; id < state.alive.length; id++) {
    if (state.alive[id] === 0 || state.retired[id] !== 0 || state.sex[id] !== Sex.Male) continue
    if (state.age[id] < RETIRE_AGE) continue
    const son = eldestAdultSon(childrenOf(state, id), state)
    if (son >= 0) handToSon(state, id, son, true)
  }
  for (let id = 0; id < state.alive.length; id++) {
    if (state.alive[id] === 0 || state.retired[id] !== 0 || state.sex[id] !== Sex.Female) continue
    const mate = state.spouse[id]
    if (mate < 0 || state.alive[mate] !== 0) continue
    const son = eldestAdultSon(childrenOf(state, id), state)
    if (son >= 0) handToSon(state, id, son, false)
  }
}

/** Split a father's purse, or pass a widow's whole purse, then retire the parents onto the son. */
function handToSon(state: KinState, holder: number, son: number, split: boolean) {
  const wife = split ? livingMate(state, holder) : -1
  let estate = takePurse(state, holder)
  const from = [holder]
  if (wife >= 0) {
    estate += takePurse(state, wife)
    from.push(wife)
  }
  movePlots(state, from, son, "keep")
  if (split) splitFatherPurse(state, holder, son, estate)
  else if (estate > 0) state.wealth[son] += estate
  retireWith(state, holder, son)
  if (wife >= 0) retireWith(state, wife, son)
}

function settleDead(state: KinState, dead: number, seen: Set<number>) {
  seen.add(dead)
  if (state.retired[dead] !== 0) {
    const heir = livingId(state, state.livesWith[dead]) ? state.livesWith[dead] : -1
    givePurse(state, dead, heir)
    movePlots(state, [dead], heir, "keep")
    return
  }
  const mate = state.spouse[dead]
  const mateAlive = livingId(state, mate)
  const kids = childrenOf(state, dead)
  const adultSon = eldestAdultSon(kids, state)
  if (mateAlive && !(state.sex[dead] === Sex.Male && adultSon >= 0)) {
    givePurse(state, dead, mate)
    movePlots(state, [dead], mate, "keep")
    return
  }
  if (adultSon >= 0) {
    let estate = takePurse(state, dead)
    const from = [dead]
    if (mate >= 0) {
      estate += takePurse(state, mate)
      from.push(mate)
      if (mateAlive) retireWith(state, mate, adultSon)
      else seen.add(mate)
    }
    movePlots(state, from, adultSon, "keep")
    if (state.sex[dead] === Sex.Male) splitFatherPurse(state, dead, adultSon, estate)
    else state.wealth[adultSon] += estate
    return
  }
  const minors = kids.filter((id) => state.age[id] < ADOPT_AGE)
  const sons = kids.filter((id) => state.sex[id] === Sex.Male)
  if (kids.length > 0 && kids.every((id) => state.age[id] < ADOPT_AGE)) {
    if (adoptMinors(state, dead, minors, seen)) return
  }
  const waitingSon = eldestSon(sons, state)
  if (waitingSon >= 0) {
    givePurse(state, dead, waitingSon)
    movePlots(state, [dead], waitingSon, "keep")
    for (const child of minors) if (child !== waitingSon) state.livesWith[child] = waitingSon
    return
  }
  const daughters = kids.filter((id) => state.sex[id] === Sex.Female)
  if (daughters.length > 0) {
    liquidatePlots(state, [dead])
    splitDaughterPurse(state, daughters, takePurse(state, dead))
    const eldest = oldestHeir(daughters, state.age)
    for (const child of minors) state.livesWith[child] = eldest
    return
  }
  const siblings = livingSiblings(dead, state.alive, state.mother, state.father)
  if (siblings.length === 0) {
    state.toTreasury += takePurse(state, dead)
    movePlots(state, [dead], -1, "keep")
    return
  }
  const oldest = oldestHeir(siblings, state.age)
  movePlots(state, [dead], siblingPlotHeir(state, oldest), "keep")
  const estate = takePurse(state, dead)
  divideEstate(estate, siblings, true, state.sex, state.age, state.spouse, state.alive, state.wealth, state.mother, state.father)
}

function adoptMinors(state: KinState, dead: number, minors: readonly number[], seen: Set<number>): boolean {
  const fatherId = state.sex[dead] === Sex.Male ? dead : state.spouse[dead]
  const motherId = state.sex[dead] === Sex.Female ? dead : state.spouse[dead]
  const adopter = adoptingSibling(state, fatherId, motherId)
  if (adopter < 0) return false
  let estate = takePurse(state, dead)
  const from = [dead]
  const other = state.sex[dead] === Sex.Male ? motherId : fatherId
  if (other >= 0 && other < state.alive.length && state.alive[other] === 0) {
    estate += takePurse(state, other)
    from.push(other)
    seen.add(other)
  }
  for (const child of minors) state.livesWith[child] = adopter
  movePlots(state, from, adopter, "spill")
  state.wealth[adopter] += estate
  return true
}

function adoptingSibling(state: KinState, fatherId: number, motherId: number): number {
  const fromFather = adultSiblings(state, fatherId)
  if (fromFather.length > 0) return oldestHeir(fromFather, state.age)
  const fromMother = adultSiblings(state, motherId)
  if (fromMother.length > 0) return oldestHeir(fromMother, state.age)
  return -1
}

function adultSiblings(state: KinState, person: number): number[] {
  if (!Number.isInteger(person) || person < 0 || person >= state.alive.length) return []
  return livingSiblings(person, state.alive, state.mother, state.father).filter((id) => state.age[id] >= MIN_ADULT_AGE)
}

/** Half to the eldest son. The other half to younger sons, else daughters, else back to him. */
function splitFatherPurse(state: KinState, fatherId: number, son: number, estate: number) {
  if (estate <= 0) return
  const half = Math.floor(estate / 2)
  const rest = estate - half
  state.wealth[son] += half
  const younger = childrenOf(state, fatherId).filter((id) => id !== son && state.sex[id] === Sex.Male)
  if (younger.length > 0) {
    divideAmong(state, rest, younger)
    return
  }
  const daughters = childrenOf(state, fatherId).filter((id) => state.sex[id] === Sex.Female)
  if (daughters.length > 0) divideAmong(state, rest, daughters)
  else state.wealth[son] += rest
}

function splitDaughterPurse(state: KinState, daughters: readonly number[], estate: number) {
  if (estate <= 0 || daughters.length === 0) return
  const eldest = oldestHeir(daughters, state.age)
  const half = Math.floor(estate / 2)
  payHeir(eldest, half, state.sex, state.spouse, state.alive, state.wealth)
  const others = daughters.filter((id) => id !== eldest)
  if (others.length === 0) payHeir(eldest, estate - half, state.sex, state.spouse, state.alive, state.wealth)
  else divideAmong(state, estate - half, others)
}

function divideAmong(state: KinState, amount: number, heirs: readonly number[]) {
  if (amount <= 0 || heirs.length === 0) return
  const share = Math.floor(amount / heirs.length)
  let leftover = amount - share * heirs.length
  const oldest = oldestHeir(heirs, state.age)
  for (const heir of heirs) {
    const extra = heir === oldest ? leftover : 0
    if (heir === oldest) leftover = 0
    payHeir(heir, share + extra, state.sex, state.spouse, state.alive, state.wealth)
  }
}

function childrenOf(state: KinState, parent: number): number[] {
  return livingChildren(parent, state.alive, state.mother, state.father)
}

function eldestAdultSon(children: readonly number[], state: KinState): number {
  const sons = children.filter((id) => state.sex[id] === Sex.Male && state.age[id] >= MIN_ADULT_AGE)
  return sons.length === 0 ? -1 : eldestSon(sons, state)
}

function eldestSon(sons: readonly number[], state: KinState): number {
  return sons.length === 0 ? -1 : oldestHeir(sons, state.age)
}

function livingMate(state: KinState, id: number): number {
  const mate = state.spouse[id]
  return livingId(state, mate) ? mate : -1
}

function livingId(state: KinState, id: number): boolean {
  return id >= 0 && id < state.alive.length && state.alive[id] !== 0
}

function takePurse(state: KinState, id: number): number {
  if (id < 0 || id >= state.wealth.length) return 0
  const amount = state.wealth[id]
  state.wealth[id] = 0
  return amount > 0 ? amount : 0
}

function givePurse(state: KinState, from: number, to: number) {
  const amount = takePurse(state, from)
  if (amount <= 0) return
  if (to >= 0) state.wealth[to] += amount
  else state.toTreasury += amount
}

function retireWith(state: KinState, person: number, head: number) {
  state.retired[person] = 1
  state.livesWith[person] = head
}

function siblingPlotHeir(state: KinState, sibling: number): number {
  if (state.age[sibling] < ADOPT_AGE) {
    const dad = state.father[sibling]
    if (livingId(state, dad)) return dad
    const mom = state.mother[sibling]
    if (livingId(state, mom)) return mom
  }
  const mate = state.spouse[sibling]
  if (state.sex[sibling] === Sex.Female && livingId(state, mate)) return mate
  return sibling
}

function movePlots(state: KinState, from: readonly number[], to: number, policy: "keep" | "spill") {
  if (!state.rows) return
  const sources = new Set(from)
  for (const row of state.rows) {
    if (!sources.has(row.owner)) continue
    if (to < 0) {
      clearPlot(row)
      continue
    }
    if (policy === "spill" && ownsOtherPlot(state, to, row)) {
      const next = spillSon(state, to)
      if (next >= 0) row.owner = next
      else sellPlot(state, row, to)
      continue
    }
    row.owner = to
  }
}

function liquidatePlots(state: KinState, from: readonly number[]) {
  if (!state.rows) return
  const sources = new Set(from)
  for (const row of state.rows) {
    if (!sources.has(row.owner)) continue
    sellPlot(state, row, row.owner)
  }
}

function ownsOtherPlot(state: KinState, person: number, except: Holding): boolean {
  return state.rows?.some((row) => row !== except && row.owner === person) ?? false
}

/** An adult son other than the eldest, so the heir of the adopter's own house stays home. */
function spillSon(state: KinState, adopter: number): number {
  const sons = childrenOf(state, adopter).filter((id) => state.sex[id] === Sex.Male && state.age[id] >= MIN_ADULT_AGE)
  if (sons.length === 0) return -1
  const eldest = eldestSon(sons, state)
  const others = sons.filter((id) => id !== eldest && !ownsPlot(state, id))
  return others.length === 0 ? -1 : eldestSon(others, state)
}

function ownsPlot(state: KinState, person: number): boolean {
  return state.rows?.some((row) => row.owner === person) ?? false
}

function sellPlot(state: KinState, row: Holding, payTo: number) {
  const price = Math.max(0, Math.floor(state.salePrice(row.structureId)))
  if (payTo >= 0 && payTo < state.wealth.length) state.wealth[payTo] += price
  state.toTreasury -= price
  clearPlot(row)
}

function clearPlot(row: Holding) {
  row.owner = -1
  row.lease = 0
  row.paid = 0
}

function seedSons(state: KinState) {
  const homes = homesFromRows(state.rows ?? [])
  const owned = ownersFromRows(state.rows ?? [])
  for (const unit of households(kinView(state), homes)) {
    const head = unit.head
    if (state.alive[head] === 0 || state.sex[head] !== Sex.Male || state.retired[head] !== 0) continue
    const males = childrenOf(state, head).filter((id) => state.sex[id] === Sex.Male)
    if (males.length === 0) continue
    const heir = eldestSon(males, state)
    const younger = males.filter((id) => id !== heir && state.age[id] >= ADOPT_AGE && !owned.has(id))
    if (younger.length === 0) continue
    const gift = purseGift(state, head, unit, SEED_SHARE)
    if (gift <= 0) continue
    state.wealth[head] -= gift
    divideAmong(state, gift, younger)
  }
}

function payDowry(state: KinState, bride: number, husband: number) {
  const dad = state.father[bride]
  if (!livingId(state, dad) || state.retired[dad] !== 0) return
  const unit = householdContaining(state, dad)
  if (!unit) return
  const gift = purseGift(state, dad, unit, DOWRY_SHARE)
  if (gift <= 0) return
  state.wealth[dad] -= gift
  state.wealth[husband] += gift
}

/** A father with no living son retires onto his eldest married daughter once the last daughter marries. */
function retireChildlessFather(state: KinState, bride: number) {
  const dad = state.father[bride]
  if (!livingId(state, dad) || state.retired[dad] !== 0 || state.sex[dad] !== Sex.Male) return
  if (childrenOf(state, dad).some((id) => state.sex[id] === Sex.Male)) return
  const daughters = childrenOf(state, dad).filter((id) => state.sex[id] === Sex.Female)
  if (daughters.length === 0 || daughters.some((id) => !livingId(state, state.spouse[id]))) return
  const eldest = oldestHeir(daughters, state.age)
  const wife = livingMate(state, dad)
  const from = wife >= 0 ? [dad, wife] : [dad]
  liquidatePlots(state, from)
  let estate = takePurse(state, dad)
  if (wife >= 0) estate += takePurse(state, wife)
  splitDaughterPurse(state, daughters, estate)
  retireWith(state, dad, eldest)
  if (wife >= 0) retireWith(state, wife, eldest)
}

function purseGift(state: KinState, payer: number, unit: HouseholdRoll, share: number): number {
  const cost = householdCost(state.adultCost, state.memberCost, unit.size)
  if (classify(unit.income, unit.wealth, cost) === "poor") return 0
  const purse = state.wealth[payer]
  const cap = Math.floor(purse * share)
  const room = purse - cost
  return Math.max(0, Math.min(cap, room))
}

function householdContaining(state: KinState, person: number): HouseholdRoll | null {
  const view = kinView(state)
  const head = residenceMap(view, ownersFromRows(state.rows ?? []))[person]
  if (head < 0) return null
  return households(view, homesFromRows(state.rows ?? [])).find((unit) => unit.head === head) ?? null
}

function kinView(state: KinState): People {
  const count = state.age.length
  return {
    age: state.age,
    sex: state.sex,
    birthMonth: new Uint8Array(count),
    cooldown: new Uint8Array(count),
    vigor: new Uint8Array(count),
    intellect: new Uint8Array(count),
    willpower: new Uint8Array(count),
    education: new Uint8Array(count),
    primaryYears: new Uint8Array(count),
    secondaryYears: new Uint8Array(count),
    occupation: new Uint8Array(count),
    alive: state.alive,
    income: state.income,
    incomeLog: new Int32Array(count * 12),
    wealth: state.wealth,
    spouse: state.spouse,
    mother: state.mother,
    father: state.father,
    livesWith: state.livesWith,
    retired: state.retired,
  }
}

function homesFromRows(rows: readonly Holding[]): HouseholdHome[] {
  return rows.filter((row) => row.owner >= 0).map((row) => ({ id: row.structureId, owner: row.owner, kind: "farmstead" }))
}

/** A man looks when he owns a plot, or he is the eldest son still in his father's house. */
function maySeekWife(state: KinState, id: number): boolean {
  if (ownsPlot(state, id)) return true
  const dad = state.father[id]
  if (!livingId(state, dad) || state.retired[dad] !== 0 || state.age[dad] >= RETIRE_AGE) return false
  const sons = childrenOf(state, dad).filter((son) => state.sex[son] === Sex.Male)
  return eldestSon(sons, state) === id
}

function livingChildren(dead: number, alive: Uint8Array, mother: Int32Array, father: Int32Array): number[] {
  const heirs: number[] = []
  for (let i = 0; i < alive.length; i++) {
    if (alive[i] === 0) continue
    if (mother[i] === dead || father[i] === dead) heirs.push(i)
  }
  return heirs
}

function livingSiblings(dead: number, alive: Uint8Array, mother: Int32Array, father: Int32Array): number[] {
  const heirs: number[] = []
  for (let i = 0; i < alive.length; i++) {
    if (i === dead || alive[i] === 0) continue
    if (sharesParent(mother, father, dead, i)) heirs.push(i)
  }
  return heirs
}

function divideEstate(
  estate: number,
  heirs: readonly number[],
  minorsToHousehold: boolean,
  sex: Uint8Array,
  age: Uint8Array,
  spouse: Int32Array,
  alive: Uint8Array,
  wealth: Int32Array,
  mother: Int32Array,
  father: Int32Array,
) {
  const share = Math.floor(estate / heirs.length)
  let leftover = estate - share * heirs.length
  const oldest = oldestHeir(heirs, age)
  for (const heir of heirs) {
    const amount = share + (heir === oldest ? leftover : 0)
    if (heir === oldest) leftover = 0
    if (minorsToHousehold && age[heir] < 16 && payLivingParent(heir, amount, alive, wealth, mother, father)) continue
    payHeir(heir, amount, sex, spouse, alive, wealth)
  }
}

/** A child under 16 does not keep a purse while a parent is alive. */
function payLivingParent(
  heir: number,
  amount: number,
  alive: Uint8Array,
  wealth: Int32Array,
  mother: Int32Array,
  father: Int32Array,
): boolean {
  if (amount <= 0) return true
  const dad = father[heir]
  if (dad >= 0 && alive[dad] !== 0) {
    wealth[dad] += amount
    return true
  }
  const mom = mother[heir]
  if (mom >= 0 && alive[mom] !== 0) {
    wealth[mom] += amount
    return true
  }
  return false
}

function oldestHeir(heirs: readonly number[], age: Uint8Array): number {
  let best = heirs[0]
  for (const heir of heirs) {
    if (age[heir] > age[best] || (age[heir] === age[best] && heir < best)) best = heir
  }
  return best
}

function payHeir(
  heir: number,
  amount: number,
  sex: Uint8Array,
  spouse: Int32Array,
  alive: Uint8Array,
  wealth: Int32Array,
) {
  if (amount <= 0) return
  const mate = spouse[heir]
  if (sex[heir] === Sex.Female && mate >= 0 && alive[mate] !== 0) wealth[mate] += amount
  else wealth[heir] += amount
}

const FOUNDING_CASH = {
  warrior: { level: 500, year: 100, from: 18 },
  merchant: { level: 1500, year: 150, from: 25 },
  explorer: { level: 250, year: 60, from: 18 },
} as const

/** Level 0 pays the base stake. Each further level adds the same amount again. */
function grantFoundingWealth(people: People, founderId: string) {
  const rates = FOUNDING_CASH[founderId as keyof typeof FOUNDING_CASH] ?? FOUNDING_CASH.warrior
  for (let i = 0; i < people.age.length; i++) {
    people.income[i] = 0
    if (people.alive[i] === 0) {
      people.wealth[i] = 0
      continue
    }
    if (people.mother[i] < 0) {
      const years = people.age[i] > rates.from ? people.age[i] - rates.from : 0
      people.wealth[i] = people.sex[i] === Sex.Male ? (people.education[i] + 1) * rates.level + years * rates.year : 0
      continue
    }
    if (people.spouse[i] >= 0) {
      people.wealth[i] = 0
      continue
    }
    if (people.age[i] >= 18) people.wealth[i] = 100
    else if (people.age[i] >= 16) people.wealth[i] = 50
    else people.wealth[i] = 0
  }
}

/**
 * Remove a dead person only when no living spouse, parent, or household field
 * still names them. Surviving ids are packed from the front. A pointer at
 * someone who was removed becomes −1.
 */
export function purgeUnlinkedDead(people: People): { people: People; idMap: Int32Array | null } {
  const count = people.age.length
  const keep = new Uint8Array(count)
  for (let i = 0; i < count; i++) if (people.alive[i] !== 0) keep[i] = 1
  for (let i = 0; i < count; i++) {
    if (people.alive[i] === 0) continue
    const spouseId = people.spouse[i]
    if (spouseId >= 0) keep[spouseId] = 1
    const motherId = people.mother[i]
    if (motherId >= 0) keep[motherId] = 1
    const fatherId = people.father[i]
    if (fatherId >= 0) keep[fatherId] = 1
    const homeId = people.livesWith?.[i] ?? -1
    if (homeId >= 0) keep[homeId] = 1
  }
  let kept = 0
  for (let i = 0; i < count; i++) if (keep[i] !== 0) kept += 1
  if (kept === count) return { people, idMap: null }

  const map = new Int32Array(count)
  map.fill(-1)
  let nextId = 0
  for (let i = 0; i < count; i++) if (keep[i] !== 0) map[i] = nextId++

  const age = new Uint8Array(kept)
  const sex = new Uint8Array(kept)
  const birthMonth = new Uint8Array(kept)
  const cooldown = new Uint8Array(kept)
  const vigor = new Uint8Array(kept)
  const intellect = new Uint8Array(kept)
  const willpower = new Uint8Array(kept)
  const education = new Uint8Array(kept)
  const primaryYears = new Uint8Array(kept)
  const secondaryYears = new Uint8Array(kept)
  const occupation = new Uint8Array(kept)
  const alive = new Uint8Array(kept)
  const income = new Int32Array(kept)
  const incomeLog = new Int32Array(kept * 12)
  const wealth = new Int32Array(kept)
  const spouse = new Int32Array(kept)
  const mother = new Int32Array(kept)
  const father = new Int32Array(kept)
  const livesWith = new Int32Array(kept)
  livesWith.fill(-1)
  const retired = new Uint8Array(kept)
  for (let i = 0; i < count; i++) {
    const at = map[i]
    if (at < 0) continue
    age[at] = people.age[i]
    sex[at] = people.sex[i]
    birthMonth[at] = people.birthMonth[i]
    cooldown[at] = people.cooldown[i]
    vigor[at] = people.vigor[i]
    intellect[at] = people.intellect[i]
    willpower[at] = people.willpower[i]
    education[at] = people.education[i]
    primaryYears[at] = people.primaryYears[i]
    secondaryYears[at] = people.secondaryYears[i]
    occupation[at] = people.occupation?.[i] ?? 0
    alive[at] = people.alive[i]
    income[at] = people.income?.[i] ?? 0
    writeIncomeLog(incomeLog, at, people.incomeLog, i)
    wealth[at] = people.wealth[i]
    spouse[at] = people.spouse[i] < 0 ? -1 : map[people.spouse[i]]
    mother[at] = people.mother[i] < 0 ? -1 : map[people.mother[i]]
    father[at] = people.father[i] < 0 ? -1 : map[people.father[i]]
    const homeId = people.livesWith?.[i] ?? -1
    livesWith[at] = homeId < 0 ? -1 : map[homeId]
    retired[at] = people.retired?.[i] ?? 0
  }
  return {
    people: {
      age,
      sex,
      birthMonth,
      cooldown,
      vigor,
      intellect,
      willpower,
      education,
      primaryYears,
      secondaryYears,
      occupation,
      alive,
      income,
      incomeLog,
      wealth,
      spouse,
      mother,
      father,
      livesWith,
      retired,
    },
    idMap: map,
  }
}

function marriageLookChance(age: number): number {
  if (age < MIN_ADULT_AGE) return 0
  for (const band of MARRIAGE_LOOK) {
    if (age <= band.maxAge) return band.chance
  }
  return 0
}

/**
 * Her answer. Matching scores leave the base alone. Being ahead counts the same
 * whether he leads by one step or two, and so does being behind.
 */
function marriageAcceptChance(manVigor: number, womanVigor: number, manEducation: number, womanEducation: number): number {
  const chance = MARRIAGE_BASE + compared(manVigor, womanVigor) + compared(manEducation, womanEducation)
  if (chance < 0) return 0
  if (chance > 1) return 1
  return chance
}

function compared(his: number, hers: number): number {
  if (his > hers) return MARRIAGE_COMPARE
  if (his < hers) return -MARRIAGE_COMPARE
  return 0
}

/**
 * One candidate. Preferred wives are 5 years younger through 2 years older.
 * If none are free, a man of 23 or older widens to 10 years. A younger man
 * widens only as far as 5 years older. A refusal is the caller's problem.
 */
function pickWife(
  man: number,
  age: Uint8Array,
  sex: Uint8Array,
  alive: Uint8Array,
  spouse: Int32Array,
  retired: Uint8Array,
  mother: Int32Array,
  father: Int32Array,
  rng: () => number,
): number {
  const preferred = wivesInRange(man, PREFERRED_YOUNGER, PREFERRED_OLDER, age, sex, alive, spouse, retired, mother, father)
  const pool =
    preferred.length > 0
      ? preferred
      : age[man] <= 22
        ? wivesInRange(man, PREFERRED_YOUNGER, YOUNG_FALLBACK_OLDER, age, sex, alive, spouse, retired, mother, father)
        : wivesInRange(man, WIDE_GAP, WIDE_GAP, age, sex, alive, spouse, retired, mother, father)
  if (pool.length === 0) return -1
  return pool[Math.floor(rng() * pool.length)]
}

function wivesInRange(
  man: number,
  younger: number,
  older: number,
  age: Uint8Array,
  sex: Uint8Array,
  alive: Uint8Array,
  spouse: Int32Array,
  retired: Uint8Array,
  mother: Int32Array,
  father: Int32Array,
): number[] {
  const manAge = age[man]
  const youngest = Math.max(MIN_ADULT_AGE, manAge - younger)
  const oldest = Math.min(45, manAge + older)
  const found: number[] = []
  for (let j = 0; j < age.length; j++) {
    if (alive[j] === 0 || sex[j] !== Sex.Female) continue
    const mate = spouse[j]
    if (mate >= 0 && alive[mate] !== 0) continue
    if (mate >= 0 && retired[j] !== 0) continue
    const hers = age[j]
    if (hers < youngest || hers > oldest) continue
    if (sharesParent(mother, father, man, j)) continue
    found.push(j)
  }
  return found
}

/** Monthly illness chance before vigor. */
function illnessChance(age: number): number {
  if (age <= 5) return 0.005
  if (age <= 12) return 0.0015
  if (age <= 25) return 0.001
  if (age <= 40) return 0.0015
  if (age <= 55) return 0.003
  if (age <= 65) return 0.005
  if (age <= 79) return 0.01
  return 0.015
}

/** Monthly injury chance before sex and trait multipliers. */
function injuryChance(age: number): number {
  if (age <= 5) return 0.001
  if (age <= 12) return 0.0025
  if (age <= 25) return 0.005
  if (age <= 40) return 0.0025
  if (age <= 55) return 0.003
  if (age <= 65) return 0.005
  if (age <= 79) return 0.01
  return 0.015
}

/** Chance a hit kills. From 56 the 7% band keeps climbing, capped at 90%. */
function killChance(age: number, sex: number): number {
  if (age <= 5) return 0.07
  if (age <= 12) return 0.0025
  if (age <= 25) return 0.015
  if (age <= 40) return 0.03
  if (age <= 55) return 0.07
  const step = sex === Sex.Female ? 0.0135 : 0.015
  const chance = 0.07 + step * (age - 55)
  return chance > 0.9 ? 0.9 : chance
}

/** Vigor 1 and intellect 1 raise a hazard. A 3 lowers it. A 2 leaves it alone. */
function traitHazard(score: number): number {
  if (score <= 1) return 1.2
  if (score >= 3) return 0.8
  return 1
}

/**
 * Illness uses vigor. Injury uses vigor and intellect, and women take half
 * the injury chance from ages 6 through 55.
 */
function monthlyHazards(
  age: number,
  sex: number,
  vigor: number,
  intellect: number,
): { illness: number; injury: number } {
  const vigorScale = traitHazard(vigor)
  let injury = injuryChance(age) * vigorScale * traitHazard(intellect)
  if (sex === Sex.Female && age >= 6 && age <= 55) injury *= 0.5
  return { illness: illnessChance(age) * vigorScale, injury }
}

/** Same mother or same father. A missing parent (−1) never counts as shared. */
function sharesParent(mother: Int32Array, father: Int32Array, a: number, b: number): boolean {
  const am = mother[a]
  if (am >= 0 && am === mother[b]) return true
  const af = father[a]
  if (af >= 0 && af === father[b]) return true
  return false
}

/** Months of skip still ahead, including the opening month, for a child born in the past year. */
function postpartumRemaining(openingMonth: number, childBirthMonth: number): number {
  const monthsAgo =
    childBirthMonth === openingMonth
      ? 12
      : (openingMonth - childBirthMonth + 12) % 12
  return POSTPARTUM_MONTHS + 1 - monthsAgo
}

function traitMeans(difficulty: DifficultyId, founderId: string): { vigor: number; intellect: number; willpower: number } {
  const base = DIFFICULTIES.find((item) => item.id === difficulty)?.tenths ?? 20
  const bonus = FOUNDER_TRAIT_BONUS[founderId as keyof typeof FOUNDER_TRAIT_BONUS] ?? {
    vigor: 0,
    intellect: 0,
    willpower: 0,
  }
  return {
    vigor: base + bonus.vigor,
    intellect: base + bonus.intellect,
    willpower: base + bonus.willpower,
  }
}

/** Seventy percent score 2. A higher mean moves the other 30% from 1 toward 3. */
function parentTrait(meanTenths: number, rng: () => number): number {
  const shift = 5 * (meanTenths - 17)
  const roll = rng()
  if (roll < (30 - shift) / 100) return 1
  if (roll < (100 - shift) / 100) return 2
  return 3
}

function inheritTrait(motherScore: number, fatherScore: number, rng: () => number): number {
  const roll = rng()
  if (roll < INHERIT_MOTHER) return motherScore
  if (roll < INHERIT_FATHER) return fatherScore
  if (roll < INHERIT_TWO) return 2
  if (roll < INHERIT_ONE) return 1
  return 3
}

/**
 * June, after birthdays and deaths. Enrolled students bank one quality-weighted credit.
 * A student listed twice takes the first seat. Age 12 then rolls for level 1, age 17 for
 * an early level 2, and age 18 for level 2 if the early roll failed. A level already held
 * is left alone. Each exam has its own draw, so one result does not move the next.
 */
function resolveJuneSchooling(
  age: Uint8Array,
  intellect: Uint8Array,
  willpower: Uint8Array,
  education: Uint8Array,
  primaryYears: Uint8Array,
  secondaryYears: Uint8Array,
  alive: Uint8Array,
  mother: Int32Array,
  father: Int32Array,
  year: number,
  seed: string,
  schools: SchoolSession,
) {
  grantClass(primaryYears, alive, schools.primary)
  grantClass(secondaryYears, alive, schools.secondary)
  const held = new Uint8Array(education)
  for (let i = 0; i < age.length; i++) {
    if (alive[i] === 0) continue
    const parent = highestParentEducation(i, held, mother, father)
    if (age[i] === 12 && held[i] < 1) {
      const chance = primaryChance(intellect[i], willpower[i], parent, primaryYears[i])
      if (passedExam(chance, seed, year, i, "primary")) education[i] = 1
    } else if (age[i] === 17 && held[i] === 1 && (secondaryYears[i] >= EARLY_SECONDARY || parent >= 3)) {
      const chance = earlySecondaryChance(intellect[i], willpower[i], parent, secondaryYears[i])
      if (passedExam(chance, seed, year, i, "early")) education[i] = 2
    } else if (age[i] === 18 && held[i] === 1 && secondaryYears[i] >= FINAL_SECONDARY) {
      const chance = finalSecondaryChance(intellect[i], willpower[i], parent, secondaryYears[i])
      if (passedExam(chance, seed, year, i, "final")) education[i] = 2
    }
  }
}

function grantClass(years: Uint8Array, alive: Uint8Array, seats: readonly SchoolSeat[]) {
  const seen = new Uint8Array(years.length)
  for (const seat of seats) {
    const i = seat.student
    if (!Number.isInteger(i) || i < 0 || i >= years.length || alive[i] === 0 || seen[i] === 1) continue
    seen[i] = 1
    const sum = years[i] + schoolYearTenths(seat.quality)
    years[i] = sum > 255 ? 255 : sum
  }
}

function highestParentEducation(person: number, education: Uint8Array, mother: Int32Array, father: Int32Array): number {
  return Math.max(parentEducation(mother[person], education), parentEducation(father[person], education))
}

function parentEducation(parent: number, education: Uint8Array): number {
  if (parent < 0 || parent >= education.length) return 0
  return education[parent]
}

/** Level 1 from schooling, or from intellect, willpower, parents, and whatever credit is under 2.5. */
function primaryChance(intellect: number, willpower: number, parent: number, tenths: number): number {
  if (tenths >= PRIMARY_SURE) return 1
  if (tenths >= PRIMARY_STEADY) return 0.95
  if (tenths >= PRIMARY_LIKELY) return 0.9
  let chance = traitBonus(intellect, 0, 0.3, 0.6) + traitBonus(willpower, 0, 0.1, 0.2)
  if (parent >= 4) chance += 0.95
  else if (parent === 3) chance += 0.85
  else if (parent === 2) chance += 0.65
  else if (parent === 1) chance += 0.4
  chance += tenths * 0.01
  return Math.min(1, chance)
}

/** Early level 2. Five points per credit, then a cap at certainty. */
function earlySecondaryChance(intellect: number, willpower: number, parent: number, tenths: number): number {
  let chance = traitBonus(intellect, 0, 0.1, 0.3) + traitBonus(willpower, 0, 0.1, 0.3)
  if (parent >= 4) chance += 0.2
  chance += tenths * 0.005
  return Math.min(1, chance)
}

/** Level 2 at 18. Traits and parents add, then the sum scales by credits over a 4-credit course. */
function finalSecondaryChance(intellect: number, willpower: number, parent: number, tenths: number): number {
  let sum = traitBonus(intellect, 0.2, 0.4, 0.6) + traitBonus(willpower, 0.2, 0.4, 0.6)
  if (parent >= 4) sum += 0.3
  else if (parent === 3) sum += 0.15
  return Math.min(1, (sum * Math.min(tenths, SECONDARY_CAP)) / 40)
}

function traitBonus(score: number, low: number, mid: number, high: number): number {
  if (score >= 3) return high
  if (score === 2) return mid
  return low
}

function passedExam(chance: number, seed: string, year: number, person: number, exam: string): boolean {
  if (chance <= 0) return false
  if (chance >= 1) return true
  const rng = mulberry32(hashSeed(`${seed}|${year}|${JUNE}|education|${exam}|${person}`))
  return rng() < chance
}

/**
 * Founding literacy. Intellect 1 is half level 1. Intellect 2 is mostly level 1,
 * with some level 2 and a few left at 0. Intellect 3 splits level 1 and level 2.
 * Ages 6–12 fold any level 2 chance into level 1. Ages 5 and under stay at 0.
 */
function foundingEducation(age: number, intellect: number, rng: () => number): number {
  if (age <= 5) return 0
  const roll = rng()
  const child = age <= 12
  if (intellect <= 1) return roll < 0.5 ? 0 : 1
  if (intellect >= 3) return child || roll < 0.5 ? 1 : 2
  if (child) return roll < 0.1 ? 0 : 1
  if (roll < 0.1) return 0
  if (roll < 0.8) return 1
  return 2
}

function rollCouple(rng: () => number): { mother: number; father: number } {
  const span = MAX_ADULT_AGE - MIN_ADULT_AGE + 1
  for (;;) {
    const mother = MIN_ADULT_AGE + Math.floor(rng() * span)
    const father = MIN_ADULT_AGE + Math.floor(rng() * span)
    if (Math.abs(mother - father) <= MAX_AGE_GAP) return { mother, father }
  }
}

function filledAlive(count: number): Uint8Array {
  const alive = new Uint8Array(count)
  alive.fill(1)
  return alive
}

/** Copy household pointers, or −1 when an older table has none. */
function livesWithColumn(people: People, count: number): Int32Array {
  const next = new Int32Array(count)
  next.fill(-1)
  const current = people.livesWith
  if (current) {
    for (let i = 0; i < Math.min(count, current.length); i++) next[i] = current[i]
  }
  return next
}

/** Copy retirement flags, or zeros when an older table has none. */
function retiredColumn(people: People, count: number): Uint8Array {
  const next = new Uint8Array(count)
  const current = people.retired
  if (current) next.set(current.subarray(0, Math.min(count, current.length)))
  return next
}

/** Copy the occupation column, or zeros when an older table has none. */
function occupationColumn(people: People, count: number): Uint8Array {
  const next = new Uint8Array(count)
  const current = people.occupation
  if (current) next.set(current.subarray(0, Math.min(count, current.length)))
  return next
}

/** Copy twelve months of operating income for each person, or zeros when an older table has none. */
export function copyIncomeLog(people: People, count: number): Int32Array {
  const next = new Int32Array(count * 12)
  const current = people.incomeLog
  if (current) next.set(current.subarray(0, Math.min(current.length, next.length)))
  return next
}

function writeIncomeLog(dest: Int32Array, destId: number, src: Int32Array | undefined, srcId: number) {
  if (!src) return
  const from = srcId * 12
  const to = destId * 12
  for (let month = 0; month < 12; month++) dest[to + month] = src[from + month] ?? 0
}

function mergeIncome(income: Int32Array, log: Int32Array, head: number, other: number) {
  if (other < 0 || other >= income.length || head < 0 || head >= income.length) return
  income[head] += income[other]
  income[other] = 0
  for (let month = 0; month < 12; month++) {
    log[head * 12 + month] += log[other * 12 + month] ?? 0
    log[other * 12 + month] = 0
  }
}

/** Drop this calendar month's result from a year ago, then record the new month in that slot. */
export function openIncomeMonth(people: People, month: number): People {
  const count = people.age.length
  const income = new Int32Array(people.income ?? count)
  const incomeLog = copyIncomeLog(people, count)
  const slot = ((month % 12) + 12) % 12
  for (let id = 0; id < count; id++) {
    const at = id * 12 + slot
    income[id] -= incomeLog[at] ?? 0
    incomeLog[at] = 0
  }
  return { ...people, income, incomeLog }
}

/** Add a sale, fee, goods purchase, or lease payment to the open month. */
export function noteOperatingIncome(income: Int32Array, log: Int32Array, id: number, dollars: number, month: number) {
  if (!Number.isFinite(dollars) || dollars === 0) return
  if (id < 0 || id >= income.length) return
  const slot = ((month % 12) + 12) % 12
  income[id] += dollars
  log[id * 12 + slot] += dollars
}

function pack(
  age: number[],
  sex: number[],
  birthMonth: number[],
  cooldown: number[],
  vigor: number[],
  intellect: number[],
  willpower: number[],
  spouse: number[],
  mother: number[],
  father: number[],
): People {
  return {
    age: Uint8Array.from(age),
    sex: Uint8Array.from(sex),
    birthMonth: Uint8Array.from(birthMonth),
    cooldown: Uint8Array.from(cooldown),
    vigor: Uint8Array.from(vigor),
    intellect: Uint8Array.from(intellect),
    willpower: Uint8Array.from(willpower),
    education: new Uint8Array(age.length),
    primaryYears: new Uint8Array(age.length),
    secondaryYears: new Uint8Array(age.length),
    occupation: new Uint8Array(age.length),
    alive: filledAlive(age.length),
    income: new Int32Array(age.length),
    incomeLog: new Int32Array(age.length * 12),
    wealth: new Int32Array(age.length),
    spouse: Int32Array.from(spouse),
    mother: Int32Array.from(mother),
    father: Int32Array.from(father),
    livesWith: new Int32Array(age.length).fill(-1),
    retired: new Uint8Array(age.length),
  }
}

function add(
  age: number[],
  sex: number[],
  birthMonth: number[],
  cooldown: number[],
  vigor: number[],
  intellect: number[],
  willpower: number[],
  spouse: number[],
  mother: number[],
  father: number[],
  nextAge: number,
  nextSex: SexId,
  nextSpouse: number,
  nextMother: number,
  nextFather: number,
) {
  age.push(nextAge)
  sex.push(nextSex)
  birthMonth.push(0)
  cooldown.push(0)
  vigor.push(0)
  intellect.push(0)
  willpower.push(0)
  spouse.push(nextSpouse)
  mother.push(nextMother)
  father.push(nextFather)
}
