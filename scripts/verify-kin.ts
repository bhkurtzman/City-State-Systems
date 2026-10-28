import { emptyHoldings, plotSalePrice, settleHoldings, type Holdings } from "../src/lib/land"
import { advancePeople, classCensus, economyCensus, emptyEpidemic, propertySeekers, type People } from "../src/lib/people"
import { defaultLandSchedule } from "../src/lib/land"
import type { Structure } from "../src/lib/buildings"

function people(count: number, fill: (people: People, id: number) => void): People {
  const table: People = {
    age: new Uint8Array(count),
    sex: new Uint8Array(count),
    birthMonth: new Uint8Array(count),
    cooldown: new Uint8Array(count),
    vigor: new Uint8Array(count),
    intellect: new Uint8Array(count),
    willpower: new Uint8Array(count),
    education: new Uint8Array(count),
    primaryYears: new Uint8Array(count),
    secondaryYears: new Uint8Array(count),
    occupation: new Uint8Array(count),
    alive: new Uint8Array(count),
    income: new Int32Array(count),
    incomeLog: new Int32Array(count * 12),
    wealth: new Int32Array(count),
    spouse: new Int32Array(count).fill(-1),
    mother: new Int32Array(count).fill(-1),
    father: new Int32Array(count).fill(-1),
    livesWith: new Int32Array(count).fill(-1),
    retired: new Uint8Array(count),
  }
  table.alive.fill(1)
  table.vigor.fill(2)
  table.intellect.fill(2)
  table.willpower.fill(2)
  for (let id = 0; id < count; id++) fill(table, id)
  return table
}

function plot(owner: number): Holdings {
  return { opened: true, rows: [{ structureId: 1, owner, lease: 0, leaseMonth: 0, paid: 100 }] }
}

const terrain = new Uint8Array(4)
const feature = new Uint8Array(4)
const schedule = defaultLandSchedule()
const farm: Structure = {
  id: 1,
  kind: "farmstead",
  tiles: [0],
  fresh: [],
  pending: false,
  removing: false,
  home: [0, 0],
}

function assert(label: string, condition: boolean, detail: string) {
  if (!condition) throw new Error(`${label}: ${detail}`)
  console.log(`ok ${label}`)
}

const retiring = people(4, (table, id) => {
  const rows = [
    { age: 64, sex: 1, birth: 3, wealth: 1000, spouse: 1 },
    { age: 60, sex: 0, birth: 4, wealth: 0, spouse: 0 },
    { age: 20, sex: 1, birth: 1, wealth: 0, father: 0, mother: 1 },
    { age: 16, sex: 1, birth: 2, wealth: 0, father: 0, mother: 1 },
  ][id]
  table.age[id] = rows.age
  table.sex[id] = rows.sex
  table.birthMonth[id] = rows.birth
  table.wealth[id] = rows.wealth
  table.spouse[id] = rows.spouse ?? -1
  table.father[id] = rows.father ?? -1
  table.mother[id] = rows.mother ?? -1
})

const handed = advancePeople(retiring, 2, 3, "kin-retire", emptyEpidemic(), undefined, {
  holdings: plot(0),
  adultCost: 100,
  salePrice: () => plotSalePrice(farm, terrain, feature, 4, schedule),
})
assert("eldest son receives the plot", handed.holdings?.rows[0].owner === 2, `owner ${handed.holdings?.rows[0].owner}`)
assert("father's purse is split in half", handed.people.wealth[2] === 500 && handed.people.wealth[3] === 500, handed.people.wealth.join(","))
assert("parents retire onto the son", handed.people.retired[0] === 1 && handed.people.retired[1] === 1 && handed.people.livesWith[0] === 2, `${handed.people.retired[0]},${handed.people.livesWith[0]}`)

const seeded = people(4, (table, id) => {
  const rows = [
    { age: 40, sex: 1, birth: 6, wealth: 10_000, spouse: 1 },
    { age: 38, sex: 0, birth: 7, wealth: 0, spouse: 0 },
    { age: 20, sex: 1, birth: 8, wealth: 0, father: 0, mother: 1 },
    { age: 16, sex: 1, birth: 9, wealth: 0, father: 0, mother: 1 },
  ][id]
  table.age[id] = rows.age
  table.sex[id] = rows.sex
  table.birthMonth[id] = rows.birth
  table.wealth[id] = rows.wealth
  table.spouse[id] = rows.spouse ?? -1
  table.father[id] = rows.father ?? -1
  table.mother[id] = rows.mother ?? -1
})
const january = advancePeople(seeded, 3, 0, "kin-seed", emptyEpidemic(), undefined, {
  holdings: emptyHoldings(),
  adultCost: 100,
  salePrice: () => 0,
})
assert("younger son receives the 20% seed", january.people.wealth[3] === 2000, String(january.people.wealth[3]))
assert("heir is not seeded", january.people.wealth[2] === 0, String(january.people.wealth[2]))
assert("father keeps the rest", january.people.wealth[0] === 8000, String(january.people.wealth[0]))

const folded = people(4, (table, id) => {
  const rows = [
    { age: 50, sex: 1, wealth: 400, spouse: 1 },
    { age: 48, sex: 0, wealth: 0, spouse: 0 },
    { age: 22, sex: 1, wealth: 60, spouse: 3, father: 0, mother: 1 },
    { age: 21, sex: 0, wealth: 0, spouse: 2 },
  ][id]
  table.age[id] = rows.age
  table.sex[id] = rows.sex
  table.wealth[id] = rows.wealth
  table.spouse[id] = rows.spouse ?? -1
  table.father[id] = rows.father ?? -1
  table.mother[id] = rows.mother ?? -1
})
const classes = classCensus(folded, 100, [{ id: 1, owner: 0, kind: "farmstead" }])
const economy = economyCensus(folded, [{ id: 1, owner: 0, kind: "farmstead" }])
assert("heir's family is one household", classes.units === 1, String(classes.units))
assert("that household is the only family", economy.familyAverage === 460, String(economy.familyAverage))

const buyers = people(2, (table, id) => {
  table.age[id] = 30
  table.sex[id] = 1
  table.wealth[id] = id === 0 ? 10_000 : 0
})
const owned = new Set<number>()
assert("both landless men may ask for a plot", propertySeekers(buyers, owned).length === 2, propertySeekers(buyers, owned).join(","))
const workshop: Structure = { ...farm, id: 2, kind: "workshop", tiles: [0, 1, 2, 3] }
const small: Structure = { ...farm, id: 3, kind: "farmstead", tiles: [0] }
const offered = settleHoldings(
  { opened: true, rows: [
    { structureId: 2, owner: -1, lease: 0, leaseMonth: 0, paid: 0 },
    { structureId: 3, owner: -1, lease: 0, leaseMonth: 0, paid: 0 },
  ] },
  [workshop, small],
  buyers,
  terrain,
  feature,
  4,
  schedule,
  4,
  3,
  "kin-land",
  100,
)
const shopOwner = offered.holdings.rows.find((row) => row.structureId === 2)?.owner
const farmOwner = offered.holdings.rows.find((row) => row.structureId === 3)?.owner
assert("the rich man takes the workshop", shopOwner === 0, String(shopOwner))
assert("the empty purse takes the free farm", farmOwner === 1, String(farmOwner))

const widow = people(3, (table, id) => {
  const rows = [
    { age: 50, sex: 1, birth: 1, wealth: 0, spouse: 1, alive: 0 },
    { age: 40, sex: 0, birth: 2, wealth: 800, spouse: 0, alive: 1 },
    { age: 17, sex: 1, birth: 5, wealth: 0, father: 0, mother: 1, alive: 1 },
  ][id]
  table.age[id] = rows.age
  table.sex[id] = rows.sex
  table.birthMonth[id] = rows.birth
  table.wealth[id] = rows.wealth
  table.spouse[id] = rows.spouse ?? -1
  table.father[id] = rows.father ?? -1
  table.mother[id] = rows.mother ?? -1
  table.alive[id] = rows.alive
})
const passed = advancePeople(widow, 4, 5, "kin-widow", emptyEpidemic(), undefined, {
  holdings: plot(1),
  adultCost: 100,
  salePrice: () => 50,
})
assert("widow hands the purse to the son at 18", passed.people.wealth[2] === 800, String(passed.people.wealth[2]))
assert("widow retires", passed.people.retired[1] === 1 && passed.people.livesWith[1] === 2, `${passed.people.retired[1]}`)
assert("son takes her plot", passed.holdings?.rows[0].owner === 2, String(passed.holdings?.rows[0].owner))

const modest = people(1, (table) => {
  table.age[0] = 30
  table.sex[0] = 1
  table.wealth[0] = 400
})
const blocked = settleHoldings(
  { opened: true, rows: [{ structureId: 2, owner: -1, lease: 0, leaseMonth: 0, paid: 0 }] },
  [workshop],
  modest,
  terrain,
  feature,
  4,
  schedule,
  4,
  3,
  "kin-floor",
  100,
)
assert("400 dollars cannot take a workshop", blocked.holdings.rows[0].owner === -1, String(blocked.holdings.rows[0].owner))
