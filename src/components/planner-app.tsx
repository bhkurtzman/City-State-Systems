"use client"

import { useMemo, useRef, useState } from "react"
import { BuildingMenu, CategoryBar, type BuildCategory } from "@/components/building-bars"
import { BuildingInspector, InspectorPanel } from "@/components/inspector-panel"
import { LedgerPanel, type LedgerId } from "@/components/ledger-panel"
import { MapPane, type MapPaneHandle } from "@/components/map-pane"
import { SetupPanel } from "@/components/setup-panel"
import { WeatherIcon } from "@/components/weather-icon"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DEFAULT_WAGES, emptyOffices, laborerIds, runConstruction, setOfficeTarget, type OfficeCrew, type PublicWages } from "@/lib/construction"
import {
  cloneMonths,
  deriveClimate,
  monthAridity,
  presetById,
  sanitizeMonth,
  temperaturesForLatitude,
  type PresetId,
} from "@/lib/climate"
import {
  advancePeople,
  assignOccupations,
  beginFertility,
  citizenCensus,
  classCensus,
  economyCensus,
  educationCensus,
  householdHomes,
  residenceCensus,
  DIFFICULTIES,
  emptyEpidemic,
  epidemicNotice,
  foundPeople,
  livingCount,
  noteMonth,
  type DifficultyId,
  type Epidemic,
  type FertilityLedger,
  type People,
} from "@/lib/people"
import { applyBuild, commitSettlement, emptySettlement, structureAt, structureLabel, type BuildTool } from "@/lib/buildings"
import { defaultLandSchedule, emptyHoldings, plotSalePrice, propertyLines, settleHoldings, yearlyUrbanTile, type LandSchedule } from "@/lib/land"
import { emptyFarms, productionLines, workFarms } from "@/lib/produce"
import { assignOffices, emptyRoads, eraseRoad, idleOffices, paintRoad, projectAt, projectLines, projectOfOffice, roadCells, runRoads, supplyOrders } from "@/lib/roads"
import { emptyTown, livingCosts, marketLines, townPriceRows, tradeLines, tradeMonth, workshopOpening } from "@/lib/trade"
import { runGeneration } from "@/lib/run-generation"
import { monthWeather } from "@/lib/weather"
import { LAYERS, type Coast, type LayerId, type MapSize, type MonthClimate, type World } from "@/lib/types"
import { cn } from "@/lib/utils"

const INITIAL = presetById("mediterranean")
const CALENDAR_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const
const OPENING_MONTH = 6

const LINEAGES = [
  "Nordic",
  "Germanic",
  "Celtic",
  "Slavic",
  "Latin",
  "Turkic",
  "Steppe nomad",
  "Levantine",
  "Far-Eastern",
  "Bantu",
  "Nilotic",
  "Melanesian",
] as const

type Lineage = (typeof LINEAGES)[number]

const FOUNDERS = [
  { id: "warrior", label: "Warrior", treasury: 50_000, families: 20 },
  { id: "merchant", label: "Merchant", treasury: 200_000, families: 10 },
  { id: "explorer", label: "Explorer", treasury: 25_000, families: 30 },
] as const

type FounderId = (typeof FOUNDERS)[number]["id"]

const REGIONS = [
  "West Europe",
  "East Europe",
  "MENA",
  "South Asia",
  "East Asia",
  "North America",
  "South America",
  "Oceania",
  "Sub-Sahara",
] as const

type Region = (typeof REGIONS)[number]

function founderById(id: FounderId) {
  return FOUNDERS.find((founder) => founder.id === id) ?? FOUNDERS[0]
}

function lineagePhrase(groups: readonly string[]): string {
  if (groups.length === 0) return "many origins"
  if (groups.length === 1) return `the ${groups[0]}`
  return `the ${groups[0]} and the ${groups[1]}`
}

function foundingStory(founderId: FounderId, year: number, groups: readonly string[], nationality: string): string {
  const founder = founderById(founderId)
  const people = nationality.trim() || "a people as yet unnamed"
  const descent = `Your people descend from ${lineagePhrase(groups)} but together will form a new people known as ${people}.`
  const close = "The future of your lands and people is in your hands."
  const opening = `The year is ${year}.`
  if (founder.id === "merchant") {
    return `${opening} After years of trade, you have founded a small merchant republic on marginal lands. You are joined by ${founder.families} of your most trusted employees and their families who have sworn loyalty to you. ${descent} ${close}`
  }
  if (founder.id === "explorer") {
    return `${opening} After years of exploration, you have settled a new colony in these newly discovered lands. You are joined by ${founder.families} pioneers and their families who have sworn loyalty to you. ${descent} ${close}`
  }
  return `${opening} After years of warfare, you have been granted a small principality from among the conquered lands as compensation for your leadership in battle. You are joined by ${founder.families} of your most trusted men and their families who have sworn loyalty to you. ${descent} ${close}`
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US")}`
}

function literacyLabel(schooling: { adults: number; literateAdults: number } | null): string {
  if (schooling === null || schooling.adults <= 0) return "—"
  const share = (schooling.literateAdults / schooling.adults) * 100
  return share.toLocaleString("en-US", { maximumFractionDigits: 0 }) + "%"
}

function BarStat({
  label,
  value,
  pressed,
  onClick,
}: {
  label: string
  value: string
  pressed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-md px-1.5 py-0.5 text-left leading-tight hover:bg-muted",
        pressed && "bg-muted",
      )}
    >
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </button>
  )
}

function readYear(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null
  const year = Number(raw)
  if (!Number.isSafeInteger(year) || year < -9999 || year > 9999) return null
  return year
}

export function PlannerApp() {
  const [presetId, setPresetId] = useState<PresetId>(INITIAL.id)
  const [latitude, setLatitude] = useState(INITIAL.latitude)
  const [latitudeDrivesTemp, setLatitudeDrivesTemp] = useState(false)
  const [months, setMonths] = useState<MonthClimate[]>(cloneMonths(INITIAL.months))
  const [seed, setSeed] = useState("cistern-4")
  const [size, setSize] = useState<MapSize>(256)
  const [relief, setRelief] = useState(48)
  const [coast, setCoast] = useState<Coast>("none")
  const [world, setWorld] = useState<World | null>(null)
  const [layer, setLayer] = useState<LayerId>("terrain")
  const [cell, setCell] = useState<{ x: number; y: number } | null>(null)
  const [screen, setScreen] = useState<"start" | "play">("start")
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [buildingOpen, setBuildingOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState("Preparing the grid")
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [stateName, setStateName] = useState("")
  const [foundedName, setFoundedName] = useState("")
  const [nationalityName, setNationalityName] = useState("")
  const [lineages, setLineages] = useState<Lineage[]>([])
  const [founderId, setFounderId] = useState<FounderId>("warrior")
  const [difficulty, setDifficulty] = useState<DifficultyId>("medium")
  const [region, setRegion] = useState<Region>("West Europe")
  const [treasury, setTreasury] = useState(FOUNDERS[0].treasury)
  const [people, setPeople] = useState<People | null>(null)
  const [fertility, setFertility] = useState<FertilityLedger | null>(null)
  const [epidemic, setEpidemic] = useState<Epidemic>(emptyEpidemic())
  const [epidemicDismissed, setEpidemicDismissed] = useState<string | null>(null)
  const [charterOpen, setCharterOpen] = useState(false)
  const [ledger, setLedger] = useState<LedgerId | null>(null)
  const [tool, setTool] = useState<BuildTool | null>(null)
  const [category, setCategory] = useState<BuildCategory>("basic")
  const [roads, setRoads] = useState(emptyRoads)
  const [settlement, setSettlement] = useState(emptySettlement)
  const [landSchedule, setLandSchedule] = useState<LandSchedule>(defaultLandSchedule)
  const [holdings, setHoldings] = useState(emptyHoldings)
  const [offices, setOffices] = useState<OfficeCrew[]>(emptyOffices)
  const [wages, setWages] = useState<PublicWages>(DEFAULT_WAGES)
  const [farms, setFarms] = useState(emptyFarms)
  const [town, setTown] = useState(emptyTown)
  const [landIncome, setLandIncome] = useState<number | null>(null)
  const [foundingYear, setFoundingYear] = useState(1)
  const [foundedYear, setFoundedYear] = useState(1)
  const [calendarMonth, setCalendarMonth] = useState(OPENING_MONTH)
  const [calendarYear, setCalendarYear] = useState(1)
  const mapRef = useRef<MapPaneHandle>(null)

  const homes = useMemo(
    () => householdHomes(settlement.structures, holdings.rows),
    [settlement.structures, holdings.rows],
  )
  const laborers = useMemo(() => laborerIds(offices), [offices])
  const housed = useMemo(() => (people ? assignOccupations(people, homes, undefined, laborers) : null), [people, homes, laborers])
  const population = housed ? livingCount(housed) : 0
  const citizens = useMemo(() => (housed ? citizenCensus(housed) : null), [housed])
  const schooling = useMemo(() => (housed ? educationCensus(housed) : null), [housed])
  const economy = useMemo(() => (housed ? economyCensus(housed, homes) : null), [housed, homes])
  const residence = useMemo(() => (housed ? residenceCensus(housed, homes) : null), [housed, homes])
  const costs = useMemo(
    () => (world ? livingCosts(town.prices, world.months.map((item) => item.low), yearlyUrbanTile(landSchedule)) : { full: 0, member: 0 }),
    [town, world, landSchedule],
  )
  const classes = useMemo(() => (housed ? classCensus(housed, costs.full, costs.member, homes) : null), [housed, costs, homes])
  const indices = useMemo(() => deriveClimate(latitude, months), [latitude, months])
  const weather = useMemo(
    () => monthWeather(seed.trim() || "0", calendarYear, calendarMonth, months[calendarMonth]),
    [seed, calendarYear, calendarMonth, months],
  )

  async function generate() {
    setGenerating(true)
    setError(null)
    setProgress(0.02)
    setStage("Reading the climate")
    try {
      const next = await runGeneration(
        {
          seed: seed.trim() || "0",
          size,
          relief,
          coast,
          latitude,
          months: months.map(sanitizeMonth),
        },
        (update) => {
          setProgress(update.fraction)
          setStage(update.stage)
        },
      )
      setWorld(next)
      setGeneration((value) => value + 1)
      setCell((current) =>
        current && current.x < next.size && current.y < next.size ? current : null,
      )
      const founder = founderById(founderId)
      setFoundedName(stateName.trim())
      setTreasury(founder.treasury)
      const founded = foundPeople(
        seed.trim() || "0",
        founder.id,
        founder.families,
        foundingYear,
        OPENING_MONTH,
        difficulty,
      )
      setPeople(assignOccupations(founded.people, []))
      setEpidemic(founded.epidemic)
      setEpidemicDismissed(null)
      setFertility(beginFertility(foundingYear, OPENING_MONTH, founded.people))
      setLedger(null)
      setTool(null)
      setCategory("basic")
      setRoads(emptyRoads())
      setSettlement(emptySettlement())
      setLandSchedule(defaultLandSchedule())
      setHoldings(emptyHoldings())
      setOffices(emptyOffices())
      setWages(DEFAULT_WAGES)
      setFarms(emptyFarms())
      setTown(emptyTown())
      setLandIncome(null)
      setFoundedYear(foundingYear)
      setCalendarMonth(OPENING_MONTH)
      setCalendarYear(foundingYear)
      setCharterOpen(true)
      setScreen("play")
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The generator failed."
      setError(`The map could not be generated. ${message}`)
    } finally {
      setGenerating(false)
    }
  }

  if (screen === "play" && world) {
    const notice = epidemicNotice(epidemic)
    const epidemicKey = `${calendarYear}-${calendarMonth}`
    const showEpidemic = notice !== null && epidemicDismissed !== epidemicKey
    const selected = cell ? structureAt(settlement, cell.y * world.size + cell.x) : null
    const selectedRoad = cell && !selected ? projectAt(roads, cell.y * world.size + cell.x) : null
    const roadOffice = selectedRoad?.officeId == null ? null : farms.rows.find((row) => row.structureId === selectedRoad.officeId) ?? null
    const roadReport = selectedRoad
      ? projectLines(roads, selectedRoad, offices, wages.e1, town.prices.wood ?? 0, roadOffice?.store.wood ?? 0)
      : null
    const officeJob = selected?.kind === "construction-office" ? projectOfOffice(roads, selected.id) : null
    const property =
      selected && people
        ? [
            ...propertyLines(selected, holdings, people, world.terrain, world.feature, world.size, landSchedule),
            ...productionLines(selected, farms, people),
            ...tradeLines(selected, holdings, town),
            ...marketLines(selected, farms),
            ...(officeJob ? [{ label: "Project", value: `Cart path ${officeJob.id}` }] : []),
          ]
        : []
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => setScreen("start")}>
            Menu
          </Button>
          <Tabs
            value={layer}
            onValueChange={(value) => {
              if (typeof value === "string") setLayer(value as LayerId)
            }}
          >
            <TabsList className="h-auto flex-wrap">
              {LAYERS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2 border-r pr-3">
              <BarStat
                label="Population"
                value={population.toLocaleString("en-US")}
                pressed={ledger === "population"}
                onClick={() => setLedger((current) => (current === "population" ? null : "population"))}
              />
              <BarStat
                label="Education"
                value={literacyLabel(schooling)}
                pressed={ledger === "education"}
                onClick={() => setLedger((current) => (current === "education" ? null : "education"))}
              />
              <BarStat
                label="Economy"
                value={economy ? formatMoney(economy.total) : "—"}
                pressed={ledger === "economy"}
                onClick={() => setLedger((current) => (current === "economy" ? null : "economy"))}
              />
              <BarStat
                label="Treasury"
                value={formatMoney(treasury)}
                pressed={ledger === "treasury"}
                onClick={() => setLedger((current) => (current === "treasury" ? null : "treasury"))}
              />
              <BarStat
                label="Government"
                value={laborers.size.toLocaleString("en-US")}
                pressed={ledger === "government"}
                onClick={() => setLedger((current) => (current === "government" ? null : "government"))}
              />
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="sm" onClick={() => mapRef.current?.zoomBy(1 / 1.2)}>
                −
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => mapRef.current?.zoomBy(1.2)}>
                +
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => mapRef.current?.fit()}>
                Fit
              </Button>
            </div>
            <div className="flex items-start gap-3">
              {foundedName ? (
                <div className="max-w-40 truncate pt-px text-sm font-medium" title={foundedName}>
                  {foundedName}
                </div>
              ) : null}
              <div className="w-40 shrink-0 text-right text-sm leading-tight whitespace-nowrap">
                <div className="font-medium">Founded {foundedYear}</div>
                <div>
                  {CALENDAR_MONTHS[calendarMonth]} {calendarYear}
                </div>
                <div className="mt-0.5 flex items-center justify-end gap-1">
                  <WeatherIcon sky={weather.sky} />
                  <span>
                    {weather.high}° / {weather.low}°
                  </span>
                </div>
              </div>
            </div>
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
          <MapPane
            handle={mapRef}
            world={world}
            layer={layer}
            cell={cell}
            generation={generation}
            structures={settlement.structures}
            roads={roadCells(roads)}
            tool={tool}
            onSelect={setCell}
            onBuild={(cells, mode, latch, allowNew) => {
              const blocked = (index: number) => settlement.structures.some((structure) => structure.tiles.includes(index))
              if (tool === "cart-path") {
                setRoads((current) => paintRoad(current, cells, world.size, world.terrain, world.feature, blocked, offices, settlement.structures))
                return
              }
              setSettlement((current) =>
                applyBuild(current, tool, cells, world.terrain, world.feature, world.size, mode, latch, allowNew),
              )
              if (tool === "delete") {
                setRoads((current) => eraseRoad(current, cells, world.size, offices, settlement.structures))
              }
            }}
          />
          <div className="absolute top-2 right-2 bottom-2 z-10 flex w-72 flex-col items-end gap-2">
            {!inspectorOpen || !buildingOpen ? (
              <div className="flex justify-end gap-2">
                {!inspectorOpen ? (
                  <InspectorPanel
                    world={world}
                    cell={cell}
                    layer={layer}
                    structure={null}
                    open={false}
                    onToggle={() => setInspectorOpen(true)}
                  />
                ) : null}
                {!buildingOpen ? (
                  <BuildingInspector
                    structure={null}
                    size={world.size}
                    chosen={false}
                    lines={[]}
                    office={null}
                    wage={wages.e1}
                    road={null}
                    open={false}
                    onToggle={() => setBuildingOpen(true)}
                    onWorkers={() => undefined}
                  />
                ) : null}
              </div>
            ) : null}
            <div
              className={cn(
                "flex w-full min-h-0 flex-col gap-2 overflow-auto",
                ledger ? "max-h-[46%]" : "max-h-full",
              )}
            >
              {inspectorOpen ? (
                <InspectorPanel
                  world={world}
                  cell={cell}
                  layer={layer}
                  structure={cell ? structureLabel(settlement, cell.y * world.size + cell.x) ?? (selectedRoad ? "Cart path" : null) : null}
                  open
                  onToggle={() => setInspectorOpen(false)}
                />
              ) : null}
              {buildingOpen ? (
                <BuildingInspector
                  structure={selected}
                  size={world.size}
                  chosen={cell !== null}
                  lines={property}
                  office={selected ? offices.find((item) => item.structureId === selected.id) ?? null : null}
                  wage={wages.e1}
                  road={roadReport}
                  open
                  onToggle={() => setBuildingOpen(false)}
                  onWorkers={(structureId, target) => setOffices((current) => setOfficeTarget(current, structureId, target))}
                />
              ) : null}
            </div>
            {ledger ? (
              <div className="min-h-0 w-full flex-1 overflow-auto">
                <LedgerPanel
                  kind={ledger}
                  population={population}
                  citizens={citizens}
                  cash={formatMoney(treasury)}
                  lastBirths={fertility?.lastBirths ?? null}
                  lastDeaths={fertility?.lastDeaths ?? null}
                  lastRate={fertility?.lastRate ?? null}
                  schooling={schooling}
                  economy={economy}
                  prices={townPriceRows(town, farms, settlement.structures, holdings, people, world.months[calendarMonth].low, world.terrain, world.feature, world.months.map((item) => item.low), seed.trim() || "0", calendarYear, yearlyUrbanTile(landSchedule))}
                  living={costs.full}
                  classes={classes}
                  homelessFamilies={residence?.homelessFamilies ?? null}
                  homelessSingles={residence?.homelessSingles ?? null}
                  landIncome={landIncome}
                  land={landSchedule}
                  onLand={(type, patch) =>
                    setLandSchedule((current) => ({ ...current, [type]: { ...current[type], ...patch } }))
                  }
                  wages={wages}
                  onWage={(grade, amount) => setWages((current) => ({ ...current, [grade]: amount }))}
                  offices={offices}
                  structures={settlement.structures}
                  onClose={() => setLedger(null)}
                />
              </div>
            ) : null}
          </div>
          {charterOpen ? (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
              <Card className="w-full max-w-lg shadow-lg">
                <CardHeader>
                  <CardTitle>{founderById(founderId).label}</CardTitle>
                  <CardAction>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Close founding"
                      onClick={() => setCharterOpen(false)}
                    >
                      X
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <p className="leading-relaxed">
                    {foundingStory(founderId, foundedYear, lineages, nationalityName)}
                  </p>
                  <div className="flex justify-end">
                    <Button type="button" onClick={() => setCharterOpen(false)}>
                      Begin
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
          {showEpidemic && notice ? (
            <div className="absolute bottom-3 left-3 z-20 w-72">
              <Card size="sm" className="shadow-md">
                <CardHeader>
                  <CardTitle>Epidemic</CardTitle>
                  <CardAction>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Dismiss epidemic notice"
                      onClick={() => setEpidemicDismissed(epidemicKey)}
                    >
                      X
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <p>{notice}</p>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
        <CategoryBar
          category={category}
          onCategory={(next) => {
            setCategory(next)
            setTool((current) => {
              if (next === "basic" && current === "cart-path") return null
              if (next === "infrastructure" && current && current !== "delete" && current !== "cart-path") return null
              return current
            })
          }}
          tool={tool}
          onTool={(next) => setTool((current) => (current === next ? null : next))}
        />
        <footer className="flex h-16 shrink-0 items-center gap-2 border-t px-3">
          <BuildingMenu category={category} tool={tool} onTool={(next) => setTool((current) => (current === next ? null : next))} />
          <Button
            type="button"
            className="shrink-0"
            onClick={() => {
              if (!people) return
              const nextMonth = calendarMonth === 11 ? 0 : calendarMonth + 1
              const nextYear = calendarMonth === 11 ? calendarYear + 1 : calendarYear
              const gameSeed = seed.trim() || "0"
              const step = advancePeople(people, nextYear, nextMonth, gameSeed, epidemic, undefined, {
                holdings,
                adultCost: costs.full,
                memberCost: costs.member,
                salePrice: (structureId) => {
                  const structure = settlement.structures.find((item) => item.id === structureId)
                  if (!structure) return 0
                  return plotSalePrice(structure, world.terrain, world.feature, world.size, landSchedule)
                },
              })
              const committed = commitSettlement(settlement, world.terrain, world.feature, world.size)
              const opening = workshopOpening(
                town,
                farms,
                committed.structures,
                step.holdings ?? holdings,
                step.people,
                world.months[nextMonth].low,
                world.terrain,
                world.feature,
                world.months.map((item) => item.low),
                gameSeed,
                nextYear,
                yearlyUrbanTile(landSchedule),
              )
              const landStep = settleHoldings(
                step.holdings ?? holdings,
                committed.structures,
                step.people,
                world.terrain,
                world.feature,
                world.size,
                landSchedule,
                nextMonth,
                nextYear,
                gameSeed,
                costs.full,
                step.idMap,
                opening.length > 0,
                foundedYear,
              )
              setCalendarMonth(nextMonth)
              setCalendarYear(nextYear)
              setEpidemic(step.epidemic)
              setSettlement(committed)
              const housedNow = assignOccupations(landStep.people, householdHomes(committed.structures, landStep.holdings.rows))
              const staffed = runConstruction(housedNow, offices, committed.structures, nextMonth, nextYear, step.idMap, wages.e1)
              setTreasury((cash) => cash + step.toTreasury + landStep.toTreasury - staffed.paid)
              setOffices(staffed.offices)
              const worked = workFarms(
                farms,
                committed.structures,
                landStep.holdings.rows,
                world.terrain,
                world.feature,
                world.fertility,
                presetId,
                nextMonth,
                nextYear,
                gameSeed,
                step.idMap,
                monthAridity(world.latitude, world.months, nextMonth),
                opening,
                staffed.people.wealth,
              )
              const claimed = assignOffices(roads, staffed.offices, committed.structures)
              const traded = tradeMonth(
                staffed.people,
                worked.farms,
                committed.structures,
                landStep.holdings,
                town,
                nextMonth,
                nextYear,
                world.months[nextMonth].low,
                gameSeed,
                world.months.map((item) => item.low),
                world.terrain,
                worked.changedLand ? worked.feature : world.feature,
                world.months[nextMonth].high,
                world.months[nextMonth].precip,
                yearlyUrbanTile(landSchedule),
                supplyOrders(claimed, worked.farms, committed.structures, nextMonth),
                idleOffices(claimed, worked.farms),
              )
              const ground = worked.changedLand ? worked.feature : world.feature
              const built = runRoads(claimed, traded.farms, ground, staffed.offices, committed.structures, nextMonth, nextYear, gameSeed)
              setPeople(assignOccupations(traded.people, householdHomes(committed.structures, landStep.holdings.rows), undefined, laborerIds(staffed.offices)))
              setHoldings(landStep.holdings)
              setFarms(built.farms)
              setTown(traded.town)
              setRoads(built.book)
              setTreasury((cash) => cash + traded.toTreasury)
              if (worked.changedLand || built.changedLand) {
                setWorld({ ...world, feature: built.changedLand ? built.feature : ground, fertility: worked.changedLand ? worked.fertility : world.fertility })
              }
              setLandIncome(landStep.toTreasury)
              setFertility((current) =>
                current ? noteMonth(current, nextYear, nextMonth, step.people, step.deaths) : current,
              )
            }}
          >
            Advance Month
          </Button>
        </footer>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="shrink-0 border-b px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Found a city-state</h1>
        <p className="text-sm text-muted-foreground">
          Set the ground, the people, and the terms you start under.
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden lg:grid-cols-3 lg:grid-rows-[minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden border-b lg:border-r lg:border-b-0">
          <h2 className="shrink-0 px-4 pt-4 text-sm font-semibold">Climate and map</h2>
          <div className="min-h-0 flex-1">
            <SetupPanel
              presetId={presetId}
              latitude={latitude}
              latitudeDrivesTemp={latitudeDrivesTemp}
              months={months}
              indices={indices}
              seed={seed}
              size={size}
              relief={relief}
              coast={coast}
              onPreset={(id) => {
                const preset = presetById(id)
                setPresetId(preset.id)
                setLatitude(preset.latitude)
                setMonths(cloneMonths(preset.months))
              }}
              onLatitude={(next) => {
                setLatitude(next)
                if (!latitudeDrivesTemp) return
                setMonths((current) => temperaturesForLatitude(presetById(presetId), next, current))
              }}
              onLatitudeDrivesTemp={(drives) => {
                setLatitudeDrivesTemp(drives)
                if (!drives) return
                setMonths((current) => temperaturesForLatitude(presetById(presetId), latitude, current))
              }}
              onMonth={(index, key, value) => {
                setMonths((current) =>
                  current.map((month, monthIndex) =>
                    monthIndex === index ? sanitizeMonth({ ...month, [key]: value }) : month,
                  ),
                )
              }}
              onSeed={setSeed}
              onSize={setSize}
              onRelief={setRelief}
              onCoast={setCoast}
            />
          </div>
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden border-b lg:border-r lg:border-b-0">
          <h2 className="shrink-0 px-4 pt-4 text-sm font-semibold">Demographics</h2>
          <div className="grid max-w-xs gap-4 px-4 py-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nationality-name">Nationality name</Label>
              <Input
                id="nationality-name"
                value={nationalityName}
                maxLength={40}
                placeholder="Name your people"
                autoComplete="off"
                onChange={(event) => setNationalityName(event.target.value)}
              />
              <p className="text-sm leading-relaxed text-muted-foreground">
                The name associated with your people.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lineage">Lineage</Label>
              <Select
                multiple
                value={lineages}
                onValueChange={(value) => {
                  if (value.length > 2) return
                  setLineages(value)
                }}
              >
                <SelectTrigger id="lineage" className="w-full">
                  <SelectValue placeholder="Choose up to 2">
                    {(value: Lineage[]) => (value.length > 0 ? value.join(", ") : "Choose up to 2")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LINEAGES.map((lineage) => (
                    <SelectItem
                      key={lineage}
                      value={lineage}
                      disabled={lineages.length >= 2 && !lineages.includes(lineage)}
                    >
                      {lineage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Check up to two.
              </p>
            </div>
          </div>
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden">
          <h2 className="shrink-0 px-4 pt-4 text-sm font-semibold">Game options</h2>
          <div className="grid max-w-xs gap-4 px-4 py-3">
            <div className="grid gap-1.5">
              <Label htmlFor="state-name">State name</Label>
              <Input
                id="state-name"
                value={stateName}
                maxLength={40}
                placeholder="Name your state"
                autoComplete="off"
                onChange={(event) => setStateName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="founding-year">Founding year</Label>
            <Input
              id="founding-year"
              type="number"
              inputMode="numeric"
              step={1}
              min={-9999}
              max={9999}
              value={foundingYear}
              onChange={(event) => {
                const year = readYear(event.target.value)
                if (year !== null) setFoundingYear(year)
              }}
            />
            <p className="text-sm leading-relaxed text-muted-foreground">
              The calendar opens in July of this year.
            </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="founder-type">Founder type</Label>
              <Select
                value={founderId}
                onValueChange={(value) => {
                  if (value) setFounderId(value as FounderId)
                }}
              >
                <SelectTrigger id="founder-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOUNDERS.map((founder) => (
                    <SelectItem key={founder.id} value={founder.id}>
                      {founder.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Starts with {formatMoney(founderById(founderId).treasury)} and{" "}
                {founderById(founderId).families} families. Infrastructure and bonuses follow later.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="difficulty">Difficulty</Label>
              <Select
                value={DIFFICULTIES.find((option) => option.id === difficulty)?.label}
                onValueChange={(value) => {
                  const match = DIFFICULTIES.find((option) => option.label === value)
                  if (match) setDifficulty(match.id)
                }}
              >
                <SelectTrigger id="difficulty" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFFICULTIES.map((option) => (
                    <SelectItem key={option.id} value={option.label}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Most founders score 2. Easy shifts the rest toward 3, Hard toward 1.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="region">Region</Label>
              <Select
                value={region}
                onValueChange={(value) => {
                  if (value) setRegion(value as Region)
                }}
              >
                <SelectTrigger id="region" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>
      </div>
      <footer className="flex shrink-0 flex-col items-center gap-2 border-t px-4 py-3">
        <Button
          id="found-state"
          type="button"
          size="lg"
          disabled={generating}
          onClick={() => {
            void generate()
          }}
        >
          {generating ? "Founding…" : "Found New State"}
        </Button>
        {generating ? (
          <div className="grid w-full max-w-sm gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="text-center text-xs text-muted-foreground">{stage}</p>
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </footer>
    </div>
  )
}
