"use client"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { CitizenCensus } from "@/lib/people"
import { cn } from "@/lib/utils"

export type LedgerId = "population" | "treasury"

const BLANK = "—"

type Row = {
  label: string
  value: string
  note?: string
  detail?: boolean
}

export function LedgerPanel({
  kind,
  population,
  citizens,
  cash,
  lastBirths,
  lastRate,
  onClose,
}: {
  kind: LedgerId
  population: number
  citizens: CitizenCensus | null
  cash: string
  lastBirths: number | null
  lastRate: number | null
  onClose: () => void
}) {
  const rows = kind === "population" ? populationRows(population, citizens, lastBirths, lastRate) : treasuryRows(cash)
  return (
    <Card className="w-full shadow-md">
      <CardHeader>
        <CardTitle>{kind === "population" ? "Population" : "Treasury"}</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-label="Close" onClick={onClose}>
            X
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2.5 text-sm">
          {rows.map((row) => (
            <div
              key={row.label}
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
  lastRate: number | null,
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
    { label: "Last year's deaths", value: BLANK },
    { label: "Last year's emigrants", value: BLANK },
    { label: "Last year's immigrants", value: BLANK },
  ]
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

function treasuryRows(cash: string): Row[] {
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
      value: BLANK,
    },
    { label: "Debt", value: BLANK },
    { label: "Interest rate", value: BLANK },
  ]
}
