import { LINEAGES, SURNAME_BANKS, type Lineage } from "@/lib/surname-banks"

/** Share of names that are a stem alone, when a bank sets no `solo`. */
export const DEFAULT_SOLO = 0.2

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"])
const OPEN_CLUSTER = new Set(["l", "r", "n", "m"])
const ENDING_TRIES = 8
const DRAW_TRIES = 48

/**
 * Stem plus ending, or null when the seam is hard to say.
 * A vowel on both sides drops the stem's last vowel. A repeated letter at the
 * seam is kept once. Five consonants across the seam fails. Four fail unless
 * one is l, r, n, or m, so Brandtberg passes and Brandtski does not.
 * The result is 4 to 14 letters.
 */
export function joinSurname(stem: string, ending: string): string | null {
  const end = ending.trim().toLowerCase()
  let body = stem.trim()
  if (!body || !end) return null
  if (body.toLowerCase().endsWith(end)) return null
  if (isVowel(body[body.length - 1]) && isVowel(end[0])) {
    body = body.slice(0, -1)
    if (body.length < 2) return null
  }
  let suffix = end
  if (body[body.length - 1].toLowerCase() === suffix[0]) suffix = suffix.slice(1)
  if (!suffix) return null
  const cluster = trailingConsonants(body) + leadingConsonants(suffix)
  if (cluster.length > 4) return null
  if (cluster.length === 4 && ![...cluster].some((letter) => OPEN_CLUSTER.has(letter))) return null
  const name = body + suffix
  if (name.length < 4 || name.length > 14) return null
  return name[0].toUpperCase() + name.slice(1)
}

/**
 * One surname. An empty lineage list uses every bank. The stem's lineage is
 * chosen first, then the stem, so a longer list does not crowd the other.
 * A compound draws its ending from the same pool, lineage independent of the stem.
 * Null when those banks have nothing that will join.
 */
export function drawSurname(rng: () => number, lineages: readonly string[]): string | null {
  const pool = openLineages(lineages)
  for (let attempt = 0; attempt < DRAW_TRIES; attempt++) {
    const stemFrom = withParts(pool, "stems")
    if (stemFrom.length === 0) return null
    const lineage = stemFrom[Math.floor(rng() * stemFrom.length)]
    const stems = parts(lineage, "stems")
    const stem = stems[Math.floor(rng() * stems.length)]
    if (rng() < soloShare(lineage)) return finishStem(stem)
    const endingFrom = withParts(pool, "endings")
    if (endingFrom.length === 0) return finishStem(stem)
    for (let tryEnding = 0; tryEnding < ENDING_TRIES; tryEnding++) {
      const endingLineage = endingFrom[Math.floor(rng() * endingFrom.length)]
      const endings = parts(endingLineage, "endings")
      const ending = endings[Math.floor(rng() * endings.length)]
      const joined = joinSurname(stem, ending)
      if (joined) return joined
    }
  }
  return null
}

/**
 * Distinct surnames for a founding. A spelling already issued is drawn again.
 * When the banks cannot fill the count, the rest are House 1, House 2, and so on.
 */
export function foundingSurnames(rng: () => number, lineages: readonly string[], count: number): string[] {
  const used = new Set<string>()
  const names: string[] = []
  for (let family = 0; family < count; family++) {
    let name: string | null = null
    for (let attempt = 0; attempt < DRAW_TRIES; attempt++) {
      const drawn = drawSurname(rng, lineages)
      if (!drawn) break
      const key = drawn.toLowerCase()
      if (used.has(key)) continue
      used.add(key)
      name = drawn
      break
    }
    if (!name) {
      let house = family + 1
      while (used.has(`house ${house}`)) house += 1
      name = `House ${house}`
      used.add(name.toLowerCase())
    }
    names.push(name)
  }
  return names
}

/**
 * A surname for one arriving household. A spelling already in the table keeps
 * its id. A new spelling is appended.
 */
export function takeSurname(
  surnames: readonly string[],
  rng: () => number,
  lineages: readonly string[],
): { surnames: string[]; id: number } {
  const drawn = drawSurname(rng, lineages) ?? "House"
  const key = drawn.toLowerCase()
  const existing = surnames.findIndex((name) => name.toLowerCase() === key)
  if (existing >= 0) return { surnames: [...surnames], id: existing }
  return { surnames: [...surnames, drawn], id: surnames.length }
}

function openLineages(lineages: readonly string[]): Lineage[] {
  const known = new Set<string>(LINEAGES)
  const picked = lineages.filter((name): name is Lineage => known.has(name))
  return picked.length > 0 ? picked : [...LINEAGES]
}

function withParts(lineages: readonly Lineage[], part: "stems" | "endings"): Lineage[] {
  return lineages.filter((lineage) => parts(lineage, part).length > 0)
}

function parts(lineage: Lineage, part: "stems" | "endings"): string[] {
  return SURNAME_BANKS[lineage][part].map((text) => text.trim()).filter((text) => text.length > 0)
}

function soloShare(lineage: Lineage): number {
  const solo = SURNAME_BANKS[lineage].solo
  if (solo === undefined || !Number.isFinite(solo)) return DEFAULT_SOLO
  if (solo < 0) return 0
  if (solo > 1) return 1
  return solo
}

function finishStem(stem: string): string {
  const text = stem.trim()
  return text[0].toUpperCase() + text.slice(1)
}

function isVowel(letter: string): boolean {
  return VOWELS.has(letter.toLowerCase())
}

function trailingConsonants(text: string): string {
  let index = text.length
  while (index > 0 && !isVowel(text[index - 1])) index -= 1
  return text.slice(index).toLowerCase()
}

function leadingConsonants(text: string): string {
  let index = 0
  while (index < text.length && !isVowel(text[index])) index += 1
  return text.slice(0, index).toLowerCase()
}
