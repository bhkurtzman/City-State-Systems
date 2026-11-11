"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { BuildInfoBar, BuildingMenu, CategoryBar, type BuildCategory, type FarmDraw } from "@/components/building-bars"
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
  beginStarvation,
  noteMonth,
  noteStarvation,
  starvationCensus,
  type DifficultyId,
  type Epidemic,
  type FertilityLedger,
  type People,
  type StarvationLedger,
} from "@/lib/people"
import { applyBuild, canBuild, commitSettlement, emptySettlement, structureAt, structureLabel, type BuildTool, type Structure } from "@/lib/buildings"
import { LINEAGES, type Lineage } from "@/lib/surname-banks"
import { applyBought, caravanLines, emptyCaravans, isOpen, laborBill, materialOrders, moveInCash, openCaps, roadLinked, staffCaravans, teamsterIds, wayTons, workCaravans, type CaravanHouse } from "@/lib/caravan"
import { applyWorkshopBought, closedWorkshops, emptyWorkshops, materialReserve, trackWorkshops, workshopCash, workshopLabor, workshopLines, workshopOrders, type WorkshopSite } from "@/lib/workshop"
import { defaultLandSchedule, emptyHoldings, plotSalePrice, propertyLines, settleHoldings, yearlyUrbanTile, type Holding, type LandSchedule } from "@/lib/land"
import { emptyFarms, productionLines, workFarms } from "@/lib/produce"
import { assignOffices, emptyRoads, eraseRoad, idleOffices, paintRoad, projectAt, projectLines, projectOfOffice, roadCells, runRoads, supplyOrders, type RoadBook } from "@/lib/roads"
import { caravanFee, emptyTown, familyAllowance, householdSupplyBill, livingCosts, marketLines, marketSale, operatingSupplies, rollTradingFee, townPriceRows, tradeLines, tradeMonth, tradingBill, workshopOpening, type ShipHouse } from "@/lib/trade"
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

type TreasuryBooks = {
  salaries: number[]
  capitalExpenses: number[]
  capitalIncome: number[]
}

const EMPTY_TREASURY_BOOKS: TreasuryBooks = { salaries: [], capitalExpenses: [], capitalIncome: [] }

function rememberTreasury(
  books: TreasuryBooks,
  month: { salaries: number; capitalExpenses: number; capitalIncome: number },
): TreasuryBooks {
  const keep = (list: number[], value: number) => [...list, value].slice(-12)
  return {
    salaries: keep(books.salaries, month.salaries),
    capitalExpenses: keep(books.capitalExpenses, month.capitalExpenses),
    capitalIncome: keep(books.capitalIncome, month.capitalIncome),
  }
}

function yearTotal(list: number[]): number | null {
  if (list.length === 0) return null
  return list.reduce((sum, value) => sum + value, 0)
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
  const [size, setSize] = useState<MapSize>(512)
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
  const [starvation, setStarvation] = useState<StarvationLedger>({ year: 1, deaths: 0, lastDeaths: null })
  const [epidemic, setEpidemic] = useState<Epidemic>(emptyEpidemic())
  const [epidemicDismissed, setEpidemicDismissed] = useState<string | null>(null)
  const [charterOpen, setCharterOpen] = useState(false)
  const [ledger, setLedger] = useState<LedgerId | null>(null)
  const [tool, setTool] = useState<BuildTool | null>(null)
  const [farmDraw, setFarmDraw] = useState<FarmDraw>("draw")
  const [farmNorthText, setFarmNorthText] = useState("4")
  const [farmEastText, setFarmEastText] = useState("4")
  const [category, setCategory] = useState<BuildCategory>("basic")
  const [roads, setRoads] = useState(emptyRoads)
  const [settlement, setSettlement] = useState(emptySettlement)
  const [landSchedule, setLandSchedule] = useState<LandSchedule>(defaultLandSchedule)
  const [holdings, setHoldings] = useState(emptyHoldings)
  const [offices, setOffices] = useState<OfficeCrew[]>(emptyOffices)
  const [caravans, setCaravans] = useState<CaravanHouse[]>(emptyCaravans)
  const [workshops, setWorkshops] = useState<WorkshopSite[]>(emptyWorkshops)
  const activeTool = canBuild(settlement.structures, tool) ? tool : null
  useEffect(() => {
    if (tool && tool !== activeTool) setTool(null)
  }, [tool, activeTool])
  const [wages, setWages] = useState<PublicWages>(DEFAULT_WAGES)
  const [farms, setFarms] = useState(emptyFarms)
  const [town, setTown] = useState(emptyTown)
  const [treasuryBooks, setTreasuryBooks] = useState<TreasuryBooks>(EMPTY_TREASURY_BOOKS)
  const [foundingYear, setFoundingYear] = useState(1550)
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
  const costs = useMemo(() => {
    if (!world) return { full: 0, member: 0, keep: 0, supplies: 0, tile: 0 }
    const shelves = settlement.structures
      .filter((structure) => structure.kind === "market" && !structure.pending && !structure.removing)
      .filter((structure) => holdings.rows.some((row) => row.structureId === structure.id && row.owner >= 0))
      .map((structure) => structure.id)
    const lows = world.months.map((item) => item.low)
    const tile = yearlyUrbanTile(landSchedule)
    const asking = marketSale(farms, shelves)
    return { ...livingCosts(town.prices, lows, tile, asking), keep: familyAllowance(town.prices, lows, tile, asking), supplies: operatingSupplies(town.prices, asking), tile }
  }, [town, world, landSchedule, settlement.structures, holdings.rows, farms])
  const classes = useMemo(() => (housed ? classCensus(housed, costs.full, costs.member, homes) : null), [housed, costs, homes])
  const wellbeing = useMemo(() => (housed ? starvationCensus(housed, homes) : null), [housed, homes])
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
        lineages,
      )
      setPeople(assignOccupations(founded.people, []))
      setEpidemic(founded.epidemic)
      setEpidemicDismissed(null)
      setFertility(beginFertility(foundingYear, OPENING_MONTH, founded.people))
      setStarvation(beginStarvation(foundingYear))
      setLedger(null)
      setTool(null)
      setCategory("basic")
      setRoads(emptyRoads())
      setSettlement(emptySettlement())
      setLandSchedule(defaultLandSchedule())
      setHoldings(emptyHoldings())
      setOffices(emptyOffices())
      setCaravans(emptyCaravans())
      setWorkshops(emptyWorkshops())
      setWages(DEFAULT_WAGES)
      setFarms(emptyFarms())
      setTown(emptyTown())
      setTreasuryBooks(EMPTY_TREASURY_BOOKS)
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
      ? projectLines(roads, selectedRoad, offices, wages.e1, town.prices.wood ?? 0, roadOffice?.store.wood ?? 0, {
          lumber: roadOffice?.store.lumber ?? 0,
          parts: roadOffice?.store["steel-parts"] ?? 0,
          lumberPrice: town.prices.lumber ?? 0,
          partsPrice: town.prices["steel-parts"] ?? 0,
        })
      : null
    const officeJob = selected?.kind === "construction-office" ? projectOfOffice(roads, selected.id) : null
    const caravan = selected?.kind === "caravan-house" ? caravans.find((house) => house.structureId === selected.id) ?? null : null
    const workshop = selected?.kind === "workshop" ? workshops.find((site) => site.structureId === selected.id) ?? null : null
    const caravanLink = selected?.kind === "caravan-house" ? roadLinked(selected, roads, world.size) : false
    const caravanRow = caravan ? holdings.rows.find((row) => row.structureId === caravan.structureId && row.owner >= 0) : undefined
    const feeBill = tradingBill(town, world.months.map((item) => item.low), yearlyUrbanTile(landSchedule), wages.e1)
    const caravanQuote = caravan && caravanRow && isOpen(caravan)
      ? caravanFee(caravan.crew.length, wayTons(caravan.crew.length, caravanLink), feeBill.wage, feeBill.allowance, feeBill.supplies * 2, feeBill.tile)
      : undefined
    const shipHouses = shipHousesNow(caravans, settlement.structures, holdings.rows, roads, world.size, feeBill.wage, feeBill.allowance, feeBill.supplies, feeBill.tile)
    const buildNeeds = [
      ...supplyOrders(roads, farms, settlement.structures, calendarMonth, new Set(offices.filter((office) => office.crew.length > 0).map((office) => office.structureId))),
      ...materialOrders(caravans, holdings.rows),
      ...workshopOrders(workshops, holdings.rows),
    ]
    const property =
      selected && people
        ? [
            ...propertyLines(selected, holdings, people, world.terrain, world.feature, world.size, landSchedule),
            ...productionLines(selected, farms, people),
            ...(selected.kind === "caravan-house" ? caravanLines(selected, caravan, caravanLink, wages.e1, town.prices, world.feature) : []),
            ...(selected.kind === "workshop" ? workshopLines(selected, workshop, wages.e1, town.prices, world.feature) : []),
            ...tradeLines(selected, holdings, town, caravanQuote, feeBill.allowance, feeBill.supplies, feeBill.tile, calendarYear, foundedYear),
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
            tool={activeTool}
            farmDraw={farmDraw}
            farmNorth={/^\d+$/.test(farmNorthText) ? Number(farmNorthText) : 0}
            farmEast={/^\d+$/.test(farmEastText) ? Number(farmEastText) : 0}
            onSelect={setCell}
            onBuild={(cells, mode, latch, allowNew) => {
              const blocked = (index: number) => settlement.structures.some((structure) => structure.tiles.includes(index))
              if (tool === "cart-path" || tool === "wooden-bridge") {
                setRoads((current) => paintRoad(current, cells, world.size, world.terrain, world.feature, blocked, offices, settlement.structures, tool === "wooden-bridge" ? "bridge" : "path"))
                return
              }
              const paved = new Set(roads.tiles.map((tile) => tile.index))
              setSettlement((current) =>
                applyBuild(current, tool, cells, world.terrain, world.feature, world.size, mode, latch, allowNew, paved),
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
                  prices={townPriceRows(town, farms, settlement.structures, holdings, people, world.months[calendarMonth].low, world.terrain, world.feature, world.months.map((item) => item.low), seed.trim() || "0", calendarYear, yearlyUrbanTile(landSchedule), shipHouses, closedWorkshops(workshops), buildNeeds, foundedYear)}
                  living={costs.full}
                  classes={classes}
                  homelessFamilies={residence?.homelessFamilies ?? null}
                  homelessSingles={residence?.homelessSingles ?? null}
                  ongoingExpenses={yearTotal(treasuryBooks.salaries)}
                  capitalExpenses={yearTotal(treasuryBooks.capitalExpenses)}
                  capitalIncome={yearTotal(treasuryBooks.capitalIncome)}
                  land={landSchedule}
                  onLand={(type, patch) =>
                    setLandSchedule((current) => ({ ...current, [type]: { ...current[type], ...patch } }))
                  }
                  wages={wages}
                  onWage={(grade, amount) => setWages((current) => ({ ...current, [grade]: amount }))}
                  offices={offices}
                  structures={settlement.structures}
                  wellbeing={wellbeing}
                  lastStarvationDeaths={starvation.lastDeaths}
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
        <BuildInfoBar
          tool={activeTool}
          farmDraw={farmDraw}
          onFarmDraw={setFarmDraw}
          northSouth={farmNorthText}
          eastWest={farmEastText}
          onNorthSouth={setFarmNorthText}
          onEastWest={setFarmEastText}
        />
        <CategoryBar
          category={category}
          onCategory={(next) => {
            setCategory(next)
            setTool((current) => {
              if (!current || current === "delete") return current
              if (next === "basic" && current !== "cart-path" && current !== "wooden-bridge" && current !== "caravan-house" && current !== "workshop") return current
              if (next === "infrastructure" && (current === "cart-path" || current === "wooden-bridge")) return current
              if (next === "production" && (current === "caravan-house" || current === "workshop")) return current
              return null
            })
          }}
          tool={tool}
          onTool={(next) => setTool((current) => (current === next ? null : next))}
        />
        <footer className="flex h-16 shrink-0 items-center gap-2 border-t px-3">
          <BuildingMenu category={category} tool={activeTool} structures={settlement.structures} onTool={(next) => setTool((current) => (current === next ? null : next))} />
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
                keep: (payer) =>
                  householdSupplyBill(
                    people,
                    payer,
                    settlement.structures,
                    holdings,
                    farms,
                    town.prices,
                    world.months.map((item) => item.low),
                    costs.full,
                    costs.member,
                  ),
              })
              const committed = commitSettlement(settlement, world.terrain, world.feature, world.size)
              const feeTown = rollTradingFee(town, nextMonth, yearlyUrbanTile(landSchedule), wages.e1)
              const feeBillNow = tradingBill(feeTown, world.months.map((item) => item.low), yearlyUrbanTile(landSchedule), wages.e1)
              const openingNeeds = [
                ...supplyOrders(roads, farms, committed.structures, nextMonth, new Set(offices.filter((office) => office.crew.length > 0).map((office) => office.structureId))),
                ...materialOrders(caravans, holdings.rows),
                ...workshopOrders(workshops, holdings.rows),
              ]
              const openingHouses = shipHousesNow(caravans, committed.structures, (step.holdings ?? holdings).rows, roads, world.size, feeBillNow.wage, feeBillNow.allowance, feeBillNow.supplies, feeBillNow.tile)
              const opening = workshopOpening(
                feeTown,
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
                openingHouses,
                closedWorkshops(workshops),
                openingNeeds,
                foundedYear,
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
                {
                  extra: (structure) => {
                    if (structure.kind === "caravan-house") return moveInCash(town.prices, wages.e1, world.feature, structure.tiles)
                    if (structure.kind === "workshop") return workshopCash(town.prices, wages.e1, workshops.find((site) => site.structureId === structure.id) ?? null, world.feature, structure.tiles)
                    return 0
                  },
                  linked: (structure) => roadLinked(structure, roads, world.size),
                  labor: (structure) => {
                    if (structure.kind === "caravan-house") return laborBill(wages.e1, world.feature, structure.tiles)
                    if (structure.kind === "workshop" && !workshops.some((site) => site.structureId === structure.id)) return workshopLabor(wages.e1, world.feature, structure.tiles)
                    return 0
                  },
                },
              )
              const vacated = new Set(landStep.vacated)
              const placed = vacated.size === 0 ? committed : { ...committed, structures: committed.structures.map((structure) => vacated.has(structure.id) ? { ...structure, removing: true } : structure) }
              const tracked = trackWorkshops(workshops, placed.structures, landStep.holdings.rows, world.feature)
              setCalendarMonth(nextMonth)
              setCalendarYear(nextYear)
              setEpidemic(step.epidemic)
              setSettlement(placed)
              const housedNow = assignOccupations(landStep.people, householdHomes(placed.structures, landStep.holdings.rows), undefined, laborerIds(offices), teamsterIds(caravans))
              const staffed = runConstruction(housedNow, offices, placed.structures, nextMonth, nextYear, step.idMap, wages.e1)
              const crewed = staffCaravans(staffed.people, caravans, placed.structures, landStep.holdings.rows, laborerIds(staffed.offices), nextMonth, nextYear, step.idMap, wages.e1, world.feature)
              setTreasury((cash) => cash + step.toTreasury + landStep.toTreasury - staffed.paid)
              setOffices(staffed.offices)
              const worked = workFarms(
                farms,
                placed.structures,
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
                crewed.people.wealth,
                (structureId) => materialReserve(tracked.find((site) => site.structureId === structureId) ?? null, town.prices),
              )
              const claimed = assignOffices(roads, staffed.offices, placed.structures)
              const caps = shipHousesNow(crewed.houses, placed.structures, landStep.holdings.rows, roads, world.size, feeBillNow.wage, feeBillNow.allowance, feeBillNow.supplies, feeBillNow.tile)
              const traded = tradeMonth(
                crewed.people,
                worked.farms,
                placed.structures,
                landStep.holdings,
                feeTown,
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
                supplyOrders(claimed, worked.farms, placed.structures, nextMonth, new Set(staffed.offices.filter((office) => office.crew.length > 0).map((office) => office.structureId))),
                idleOffices(claimed, worked.farms),
                caps,
                [...materialOrders(crewed.houses, landStep.holdings.rows), ...workshopOrders(tracked, landStep.holdings.rows)],
                closedWorkshops(tracked),
                new Set(staffed.offices.filter((office) => office.crew.length > 0).map((office) => office.structureId)),
                roads,
                foundedYear,
              )
              const ground = worked.changedLand ? worked.feature : world.feature
              const built = runRoads(claimed, traded.farms, ground, staffed.offices, placed.structures, nextMonth, nextYear, gameSeed)
              const raised = workCaravans(applyBought(crewed.houses, traded.bought), placed.structures, staffed.offices, claimed, traded.town.shipments, new Set(caps.map((cap) => cap.structureId)), world.size, applyWorkshopBought(tracked, traded.bought), built.farms, built.changedLand ? built.feature : ground)
              setCaravans(raised.houses)
              setWorkshops(raised.sites)
              setPeople(assignOccupations(traded.people, householdHomes(placed.structures, landStep.holdings.rows), undefined, laborerIds(staffed.offices), teamsterIds(raised.houses)))
              setHoldings(landStep.holdings)
              setFarms(raised.farms)
              setTown(traded.town)
              setRoads(built.book)
              setTreasury((cash) => cash + traded.toTreasury)
              if (worked.changedLand || built.changedLand || raised.changedLand) {
                setWorld({ ...world, feature: raised.changedLand ? raised.feature : built.changedLand ? built.feature : ground, fertility: worked.changedLand ? worked.fertility : world.fertility })
              }
              setTreasuryBooks((books) =>
                rememberTreasury(books, {
                  salaries: staffed.paid,
                  capitalExpenses: traded.resourceSpent,
                  capitalIncome: landStep.toTreasury + traded.resourceReceived,
                }),
              )
              setFertility((current) =>
                current ? noteMonth(current, nextYear, nextMonth, step.people, step.deaths) : current,
              )
              setStarvation((current) => noteStarvation(current, nextYear, step.starvationDeaths))
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

function shipHousesNow(
  houses: readonly CaravanHouse[],
  structures: readonly Structure[],
  rows: readonly Holding[],
  book: RoadBook,
  size: number,
  wage: number,
  allowance: number,
  supplies: number,
  urbanTile: number,
): ShipHouse[] {
  return openCaps(houses, structures, book, size).flatMap((cap) => {
    const row = rows.find((item) => item.structureId === cap.structureId && item.owner >= 0)
    if (!row) return []
    return [{ structureId: cap.structureId, out: cap.eachWay, in: cap.eachWay, fee: caravanFee(cap.staff, cap.eachWay, wage, allowance, supplies * 2, urbanTile) }]
  })
}
