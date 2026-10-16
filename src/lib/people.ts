import { hashSeed, mulberry32 } from "@/lib/noise"

export const Sex = {
  Female: 0,
  Male: 1,
} as const

export type SexId = (typeof Sex)[keyof typeof Sex]

/** Adults are this old, inclusive. Offspring may be younger and still live at home. */
const MIN_ADULT_AGE = 18
const MAX_ADULT_AGE = 40
const MAX_AGE_GAP = 10
const MAX_CHILDREN = 8

/**
 * Chance a monthly try succeeds, chosen from the mother's age now.
 * A married woman aged 18–45 tries on 1/12 of months, so a year averages one try.
 */
export const MOTHER_FERTILITY: readonly { maxAge: number; chance: number }[] = [
  { maxAge: 25, chance: 0.25 },
  { maxAge: 35, chance: 0.2 },
  { maxAge: 45, chance: 0.15 },
]

const TRY_CHANCE = 1 / 12
const POSTPARTUM_MONTHS = 12

/** Monthly chance an unmarried man looks. He stops after the year he is 50. */
const MARRIAGE_LOOK: readonly { maxAge: number; chance: number }[] = [
  { maxAge: 22, chance: 0.01 },
  { maxAge: 35, chance: 0.02 },
  { maxAge: 50, chance: 0.01 },
]

const MARRIAGE_ACCEPT = 0.8
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
  spouse: Int32Array
  mother: Int32Array
  father: Int32Array
}

/** Years a woman spends in each birth band. Matches the fertility table. */
const FERTILITY_BAND_YEARS = [8, 10, 10] as const

export type FertilityYear = {
  births: number
  bandBirths: [number, number, number]
  /** Woman-months of exposure, ages 18–25, 26–35, and 36–45. */
  bandMonths: [number, number, number]
}

export type FertilityLedger = {
  year: number
  current: FertilityYear
  /** Null until a calendar year has closed. */
  lastBirths: number | null
  lastRate: number | null
}

export function motherFertility(age: number): number {
  for (const band of MOTHER_FERTILITY) {
    if (age <= band.maxAge) return band.chance
  }
  return MOTHER_FERTILITY[MOTHER_FERTILITY.length - 1].chance
}

function emptyFertilityYear(): FertilityYear {
  return { births: 0, bandBirths: [0, 0, 0], bandMonths: [0, 0, 0] }
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
export function observeMonth(year: FertilityYear, people: People, month: number): FertilityYear {
  const bandBirths: [number, number, number] = [...year.bandBirths]
  const bandMonths: [number, number, number] = [...year.bandMonths]
  let births = year.births
  for (let i = 0; i < people.age.length; i++) {
    if (people.sex[i] !== Sex.Female) continue
    const band = fertilityBand(people.age[i])
    if (band >= 0) bandMonths[band] += 1
  }
  for (let i = 0; i < people.age.length; i++) {
    if (people.age[i] !== 0 || people.birthMonth[i] !== month) continue
    births += 1
    const motherId = people.mother[i]
    if (motherId < 0) continue
    const band = fertilityBand(people.age[motherId])
    if (band >= 0) bandBirths[band] += 1
  }
  return { births, bandBirths, bandMonths }
}

/** Opening month is already resolved inside the founded population. */
export function beginFertility(year: number, month: number, people: People): FertilityLedger {
  return {
    year,
    current: observeMonth(emptyFertilityYear(), people, month),
    lastBirths: null,
    lastRate: null,
  }
}

/** Fold in one month. A new calendar year closes the previous one first. */
export function noteMonth(ledger: FertilityLedger, year: number, month: number, people: People): FertilityLedger {
  if (year === ledger.year) {
    return { ...ledger, current: observeMonth(ledger.current, people, month) }
  }
  return {
    year,
    current: observeMonth(emptyFertilityYear(), people, month),
    lastBirths: ledger.current.births,
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
  for (let i = 0; i < people.age.length; i++) {
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
  const count = people.age.length
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

/**
 * Founding households. Each is a woman and a man, ages 18–40, at most 10 years apart.
 * Childbearing years follow the younger spouse. Each of those years rolls once at the
 * mother's current fertility, with at most one child per year and eight children total.
 * Birthdays are spread across the year. Parents roll vigor, intellect, and willpower
 * from the difficulty. Children inherit. The opening month is then resolved, so July
 * birthdays and births are already in the result. The same seed and founder always rebuild it.
 */
export function foundPeople(
  seed: string,
  founderId: string,
  families: number,
  openingYear: number,
  openingMonth: number,
  difficulty: DifficultyId,
): People {
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

  return advancePeople(
    pack(age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father),
    openingYear,
    openingMonth,
    seed,
  )
}

/**
 * Resolve the start of one calendar month. Ages tick on birthdays, then unmarried men
 * aged 18–50 may marry, then married women aged 18–45 may try for a child.
 * A birth skips her for the next 12 months.
 * The same people, seed, year, and month always rebuild the same result.
 */
export function advancePeople(people: People, year: number, month: number, seed: string): People {
  const count = people.age.length
  const age = new Uint8Array(people.age)
  const sex = new Uint8Array(people.sex)
  const birthMonth = new Uint8Array(people.birthMonth)
  const cooldown = new Uint8Array(people.cooldown)
  const vigor = new Uint8Array(people.vigor)
  const intellect = new Uint8Array(people.intellect)
  const willpower = new Uint8Array(people.willpower)
  const spouse = new Int32Array(people.spouse)
  const mother = new Int32Array(people.mother)
  const father = new Int32Array(people.father)

  for (let i = 0; i < count; i++) {
    if (birthMonth[i] === month) age[i] += 1
  }

  const marriages = mulberry32(hashSeed(`${seed}|${year}|${month}|marriages`))
  for (let i = 0; i < count; i++) {
    if (sex[i] !== Sex.Male || spouse[i] >= 0) continue
    const look = marriageLookChance(age[i])
    if (look === 0 || marriages() >= look) continue
    const wife = pickWife(i, age, sex, spouse, mother, father, marriages)
    if (wife < 0 || marriages() >= MARRIAGE_ACCEPT) continue
    spouse[i] = wife
    spouse[wife] = i
  }

  const rng = mulberry32(hashSeed(`${seed}|${year}|${month}|births`))
  const traitRng = mulberry32(hashSeed(`${seed}|${year}|${month}|traits`))
  const born: { motherId: number; fatherId: number; childSex: SexId; vigor: number; intellect: number; willpower: number }[] = []
  for (let i = 0; i < count; i++) {
    if (cooldown[i] > 0) {
      cooldown[i] -= 1
      continue
    }
    if (sex[i] !== Sex.Female || age[i] < MIN_ADULT_AGE || age[i] > 45) continue
    const fatherId = spouse[i]
    if (fatherId < 0) continue
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

  if (born.length === 0) {
    return { age, sex, birthMonth, cooldown, vigor, intellect, willpower, spouse, mother, father }
  }

  const next = count + born.length
  const grown = {
    age: new Uint8Array(next),
    sex: new Uint8Array(next),
    birthMonth: new Uint8Array(next),
    cooldown: new Uint8Array(next),
    vigor: new Uint8Array(next),
    intellect: new Uint8Array(next),
    willpower: new Uint8Array(next),
    spouse: new Int32Array(next),
    mother: new Int32Array(next),
    father: new Int32Array(next),
  }
  grown.age.set(age)
  grown.sex.set(sex)
  grown.birthMonth.set(birthMonth)
  grown.cooldown.set(cooldown)
  grown.vigor.set(vigor)
  grown.intellect.set(intellect)
  grown.willpower.set(willpower)
  grown.spouse.set(spouse)
  grown.mother.set(mother)
  grown.father.set(father)
  for (let i = 0; i < born.length; i++) {
    const at = count + i
    const child = born[i]
    grown.age[at] = 0
    grown.sex[at] = child.childSex
    grown.birthMonth[at] = month
    grown.vigor[at] = child.vigor
    grown.intellect[at] = child.intellect
    grown.willpower[at] = child.willpower
    grown.spouse[at] = -1
    grown.mother[at] = child.motherId
    grown.father[at] = child.fatherId
  }
  return grown
}

function marriageLookChance(age: number): number {
  if (age < MIN_ADULT_AGE) return 0
  for (const band of MARRIAGE_LOOK) {
    if (age <= band.maxAge) return band.chance
  }
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
  spouse: Int32Array,
  mother: Int32Array,
  father: Int32Array,
  rng: () => number,
): number {
  const preferred = wivesInRange(man, PREFERRED_YOUNGER, PREFERRED_OLDER, age, sex, spouse, mother, father)
  const pool =
    preferred.length > 0
      ? preferred
      : age[man] <= 22
        ? wivesInRange(man, PREFERRED_YOUNGER, YOUNG_FALLBACK_OLDER, age, sex, spouse, mother, father)
        : wivesInRange(man, WIDE_GAP, WIDE_GAP, age, sex, spouse, mother, father)
  if (pool.length === 0) return -1
  return pool[Math.floor(rng() * pool.length)]
}

function wivesInRange(
  man: number,
  younger: number,
  older: number,
  age: Uint8Array,
  sex: Uint8Array,
  spouse: Int32Array,
  mother: Int32Array,
  father: Int32Array,
): number[] {
  const manAge = age[man]
  const youngest = Math.max(MIN_ADULT_AGE, manAge - younger)
  const oldest = manAge + older
  const found: number[] = []
  for (let j = 0; j < age.length; j++) {
    if (sex[j] !== Sex.Female || spouse[j] >= 0) continue
    const hers = age[j]
    if (hers < youngest || hers > oldest) continue
    if (sharesParent(mother, father, man, j)) continue
    found.push(j)
  }
  return found
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

function rollCouple(rng: () => number): { mother: number; father: number } {
  const span = MAX_ADULT_AGE - MIN_ADULT_AGE + 1
  for (;;) {
    const mother = MIN_ADULT_AGE + Math.floor(rng() * span)
    const father = MIN_ADULT_AGE + Math.floor(rng() * span)
    if (Math.abs(mother - father) <= MAX_AGE_GAP) return { mother, father }
  }
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
    spouse: Int32Array.from(spouse),
    mother: Int32Array.from(mother),
    father: Int32Array.from(father),
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
