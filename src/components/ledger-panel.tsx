"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LAND_LABEL, LAND_TYPES, type LandRate, type LandSchedule, type LandType } from "@/lib/land"
import type { CitizenCensus, ClassCensus, EconomyCensus, EducationCensus } from "@/lib/people"
import { cn } from "@/lib/utils"

export type LedgerId = "population" | "treasury" | "education" | "economy"

const BLANK = "—"

const TITLES: Record<LedgerId, string> = {
  population: "Population",
  education: "Education",
  treasury: "Treasury",
  economy: "Economy",
}

type Row = {
  label: string
  value: string
  note?: string
  sub?: string
  detail?: boolean
}

export function LedgerPanel({
  kind,
  population,
  citizens,
  cash,
  lastBirths,
  lastDeaths,
  lastRate,
  schooling,
  economy,
  prices,
  living,
  classes,
  homelessFamilies,
  homelessSingles,
  landIncome,
  land,
  onLand,
  onClose,
}: {
  kind: LedgerId
  population: number
  citizens: CitizenCensus | null
  cash: string
  lastBirths: number | null
  lastDeaths: number | null
  lastRate: number | null
  schooling: EducationCensus | null
  economy: EconomyCensus | null
  prices: { label: string; value: string; note?: string; sub?: string }[]
  /** One adult's yearly cost of living, in whole dollars. */
  living: number | null
  classes: ClassCensus | null
  homelessFamilies: number | null
  homelessSingles: number | null
  /** Land payments collected last month, or null before the first month. */
  landIncome: number | null
  land: LandSchedule
  onLand: (type: LandType, patch: Partial<LandRate>) => void
  onClose: () => void
}) {
  const rows =
    kind === "population"
      ? populationRows(population, citizens, lastBirths, lastDeaths, lastRate, homelessFamilies, homelessSingles)
      : kind === "education"
        ? educationRows(schooling)
        : kind === "economy"
          ? economyRows(economy, living, classes)
          : treasuryRows(cash, landIncome)
  if (kind === "treasury") {
    return (
      <TreasuryPanel rows={rows} land={land} onLand={onLand} onClose={onClose} />
    )
  }
  if (kind === "economy") {
    return <EconomyPanel rows={rows} prices={prices} classes={classes} onClose={onClose} />
  }
  return (
    <Card className="w-full shadow-md">
      <CardHeader>
        <CardTitle>{TITLES[kind]}</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-label="Close" onClick={onClose}>
            X
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2.5 text-sm">
          {rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3",
                row.detail && "text-xs text-muted-foreground",
              )}
            >
              <dt className={row.detail ? "pl-3" : undefined}>
                <div>{row.label}</div>
                {row.note ? <div className="text-xs leading-snug text-muted-foreground">{row.note}</div> : null}
              </dt>
              <dd className={cn("tabular-nums", !row.detail && "font-medium")}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

function populationRows(
  population: number,
  citizens: CitizenCensus | null,
  lastBirths: number | null,
  lastDeaths: number | null,
  lastRate: number | null,
  homelessFamilies: number | null,
  homelessSingles: number | null,
): Row[] {
  const age =
    citizens === null
      ? BLANK
      : citizens.averageAge.toLocaleString("en-US", {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
  return [
    {
      label: "Citizens",
      note: `Average age ${age}`,
      value: population.toLocaleString("en-US"),
    },
    { label: "Children (0–17)", value: band(citizens?.children, population) },
    { label: "Infants (0–5)", value: band(citizens?.infants, population), detail: true },
    { label: "Kids (6–12)", value: band(citizens?.kids, population), detail: true },
    { label: "Teens (13–17)", value: band(citizens?.teens, population), detail: true },
    { label: "Adults (18–64)", value: band(citizens?.adults, population) },
    { label: "Youth (18–26)", value: band(citizens?.youth, population), detail: true },
    { label: "Young adults (27–40)", value: band(citizens?.youngAdults, population), detail: true },
    { label: "Mature adults (41–64)", value: band(citizens?.matureAdults, population), detail: true },
    { label: "Elderly (65+)", value: band(citizens?.elderly, population) },
    {
      label: "Homeless families",
      note: "Couples who do not own a house.",
      value: countOf(homelessFamilies),
    },
    {
      label: "Homeless single adults",
      note: "Unmarried people 18 and older with no house of their own. Students are not counted.",
      value: countOf(homelessSingles),
    },
    { label: "Average vigor", value: score(citizens?.averageVigor) },
    { label: "Average intellect", value: score(citizens?.averageIntellect) },
    { label: "Average willpower", value: score(citizens?.averageWillpower) },
    { label: "Foreign workers", value: BLANK },
    { label: "Foreign visitors", value: BLANK },
    {
      label: "Last year's fertility rate",
      note: "Children per woman at those rates.",
      value: lastRate === null ? BLANK : score(lastRate),
    },
    {
      label: "Last year's births",
      value: lastBirths === null ? BLANK : lastBirths.toLocaleString("en-US"),
    },
    {
      label: "Last year's deaths",
      value: lastDeaths === null ? BLANK : lastDeaths.toLocaleString("en-US"),
    },
    { label: "Last year's emigrants", value: BLANK },
    { label: "Last year's immigrants", value: BLANK },
  ]
}

function economyRows(economy: EconomyCensus | null, living: number | null, classes: ClassCensus | null): Row[] {
  return [
    { label: "Total Household Wealth", value: money(economy?.total ?? null, true) },
    {
      label: "Avg. Family Wealth",
      note: "A living couple and their children under 18.",
      value: money(economy?.familyAverage ?? null),
    },
    { label: "Median", value: money(economy?.familyMedian ?? null), detail: true },
    {
      label: "Avg. Single Wealth",
      note: "People 18 and older with no living spouse.",
      value: money(economy?.singleAverage ?? null),
    },
    { label: "Median", value: money(economy?.singleMedian ?? null), detail: true },
    {
      label: "Avg. Income",
      note: "Trailing year for each family and each single adult. Sales and fees, minus goods bought and leases. The first year is the year so far.",
      value: money(classes?.incomeAverage ?? null),
    },
    { label: "Median", value: money(classes?.incomeMedian ?? null), detail: true },
    { label: "Unemployed", value: economy ? economy.unemployed.toLocaleString("en-US") : BLANK },
    {
      label: "Unemployment rate",
      note: "Share of people 18 and older who are not students.",
      value: unemployment(economy),
    },
    {
      label: "Cost of living",
      note: "One adult's food, clothing, and leather for a year, plus half a household's fuel.",
      value: money(living, true),
    },
  ]
}

function countOf(value: number | null): string {
  return value === null ? BLANK : value.toLocaleString("en-US")
}

function unemployment(economy: EconomyCensus | null): string {
  if (economy === null || economy.unemploymentRate === null) return BLANK
  return (
    (economy.unemploymentRate * 100).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + "%"
  )
}

function money(value: number | null, whole = false): string {
  if (value === null) return BLANK
  const digits = whole || Number.isInteger(value) ? 0 : 1
  return (
    "$" +
    value.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  )
}

function educationRows(schooling: EducationCensus | null): Row[] {
  const primary = schooling?.primaryStudents ?? 0
  const secondary = schooling?.secondaryStudents ?? 0
  const enrolled = primary + secondary
  return [
    { label: "Students enrolled", value: enrolled.toLocaleString("en-US") },
    { label: "Primary", value: primary.toLocaleString("en-US"), detail: true },
    { label: "Secondary", value: secondary.toLocaleString("en-US"), detail: true },
    {
      label: "Adult literacy",
      note: "Share of people 18 and older with at least basic schooling.",
      value: literacy(schooling),
    },
    {
      label: "Adults with at least secondary",
      value: band(schooling?.secondaryAdults, schooling?.adults ?? 0),
    },
  ]
}

function literacy(schooling: EducationCensus | null): string {
  if (schooling === null || schooling.adults <= 0) return BLANK
  const share = (schooling.literateAdults / schooling.adults) * 100
  return share.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%"
}

function score(value: number | undefined): string {
  if (value === undefined) return BLANK
  return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function band(count: number | undefined, total: number): string {
  if (count === undefined || total <= 0) return BLANK
  const share = (count / total) * 100
  const percent = share.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  return `${count.toLocaleString("en-US")} (${percent}%)`
}

function treasuryRows(cash: string, landIncome: number | null): Row[] {
  return [
    { label: "Cash", value: cash },
    {
      label: "Ongoing expenses",
      note: "Last month. Maintenance, salaries, and the like.",
      value: BLANK,
    },
    {
      label: "Capital expenses",
      note: "Last month. Infrastructure, equipment, and other contracts.",
      value: BLANK,
    },
    { label: "Tax income", note: "Last month.", value: BLANK },
    {
      label: "Capital income",
      note: "Last month. Sales of land, resources, and the like.",
      value: landIncome === null ? BLANK : `$${landIncome.toLocaleString("en-US")}`,
    },
    { label: "Debt", value: BLANK },
    { label: "Interest rate", value: BLANK },
  ]
}

function EconomyPanel({
  rows,
  prices,
  classes,
  onClose,
}: {
  rows: Row[]
  prices: { label: string; value: string; note?: string; sub?: string }[]
  classes: ClassCensus | null
  onClose: () => void
}) {
  const [tab, setTab] = useState("overview")
  const resources: Row[] = prices.map((row) => ({ label: row.label, value: row.value, note: row.note, sub: row.sub }))
  return (
    <Card className="w-full shadow-md">
      <CardHeader>
        <CardTitle>Economy</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-label="Close" onClick={onClose}>
            X
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") setTab(value)
          }}
        >
          <TabsList className="h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="overview" className="px-1.5 text-xs">Overview</TabsTrigger>
            <TabsTrigger value="resources" className="px-1.5 text-xs">Resources</TabsTrigger>
            <TabsTrigger value="classes" className="px-1.5 text-xs">Classes</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <RowList rows={rows} />
          </TabsContent>
          <TabsContent value="resources">
            <RowList rows={resources} />
          </TabsContent>
          <TabsContent value="classes">
            <RowList rows={classRows(classes)} />
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              A couple needs twice an adult's cost of living, plus half again for each child at home. A single adult needs one, plus half for each child. A higher band wins when income or wealth reaches it. Savings alone can hold the working class.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function classRows(classes: ClassCensus | null): Row[] {
  const total = classes?.units ?? 0
  return [
    { label: "Poor", note: "Income and wealth are both below the household cost.", value: band(classes?.poor, total) },
    { label: "Working class", note: "Income or wealth covers the household cost.", value: band(classes?.working, total) },
    { label: "Middle class", note: "Income is at least half again the cost, or wealth is at least 5 times.", value: band(classes?.middle, total) },
    { label: "Upper-middle class", note: "Income is over 3 times the cost, or wealth is at least 15 times.", value: band(classes?.upper, total) },
    { label: "Wealthy", note: "Income is over 20 times the cost, or wealth is over 100 times.", value: band(classes?.wealthy, total) },
  ]
}

function TreasuryPanel({
  rows,
  land,
  onLand,
  onClose,
}: {
  rows: Row[]
  land: LandSchedule
  onLand: (type: LandType, patch: Partial<LandRate>) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState("overview")
  return (
    <Card className="w-full shadow-md">
      <CardHeader>
        <CardTitle>Treasury</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-label="Close" onClick={onClose}>
            X
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") setTab(value)
          }}
        >
          <TabsList className="h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="overview" className="px-1.5 text-xs">Overview</TabsTrigger>
            <TabsTrigger value="taxation" className="px-1.5 text-xs">Taxation</TabsTrigger>
            <TabsTrigger value="land" className="px-1.5 text-xs">Land</TabsTrigger>
            <TabsTrigger value="expenses" className="px-1.5 text-xs">Expenses</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <RowList rows={rows} />
          </TabsContent>
          <TabsContent value="taxation">
            <RowList rows={rows.filter((row) => row.label === "Tax income")} />
          </TabsContent>
          <TabsContent value="expenses">
            <RowList rows={rows.filter((row) => row.label.endsWith("expenses"))} />
          </TabsContent>
          <TabsContent value="land">
            <LandTable land={land} onLand={onLand} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function LandTable({
  land,
  onLand,
}: {
  land: LandSchedule
  onLand: (type: LandType, patch: Partial<LandRate>) => void
}) {
  return (
    <div className="grid gap-3">
      {LAND_TYPES.map((type) => {
        const rate = land[type]
        return (
          <div key={type} className="grid gap-1">
            <div className="text-sm font-medium">{LAND_LABEL[type]}</div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant={rate.tenure === "sale" ? "secondary" : "outline"}
                aria-pressed={rate.tenure === "sale"}
                onClick={() => onLand(type, { tenure: "sale" })}
              >
                Sell
              </Button>
              <Button
                type="button"
                size="sm"
                variant={rate.tenure === "lease" ? "secondary" : "outline"}
                aria-pressed={rate.tenure === "lease"}
                onClick={() => onLand(type, { tenure: "lease" })}
              >
                Lease
              </Button>
              <Input
                type="number"
                min={0}
                step={1}
                aria-label={`${LAND_LABEL[type]} dollars per tile`}
                className="h-7 w-20 tabular-nums"
                value={rate.price}
                onChange={(event) => {
                  const next = Math.floor(Number(event.target.value))
                  onLand(type, { price: Number.isFinite(next) ? Math.max(0, next) : 0 })
                }}
              />
            </div>
          </div>
        )
      })}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Dollars per tile. A farmstead follows the farmland switch. A tile set the other way converts at 20 to 1.
        Businesses use urban land.
      </p>
    </div>
  )
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid gap-2.5 text-sm">
      {rows.map((row, index) => (
        <div
          key={`${row.label}-${index}`}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3",
            row.detail && "text-xs text-muted-foreground",
          )}
        >
          <dt className={row.detail ? "pl-3" : undefined}>
            <div>{row.label}</div>
            {row.note ? <div className="text-xs leading-snug text-muted-foreground">{row.note}</div> : null}
          </dt>
          <dd className="text-right tabular-nums">
            <div className={cn(!row.detail && "font-medium")}>{row.value}</div>
            {row.sub ? <div className="text-xs text-muted-foreground">{row.sub}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
