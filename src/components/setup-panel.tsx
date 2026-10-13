"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  MAX_LATITUDE,
  MONTH_LABELS,
  PRESETS,
  aridityLabel,
  formatFrost,
  formatGrowing,
  type PresetId,
} from "@/lib/climate"
import type { ClimateIndices, Coast, MapSize, MonthClimate } from "@/lib/types"

const COASTS: { id: Coast; label: string }[] = [
  { id: "none", label: "No coast" },
  { id: "north", label: "North coast" },
  { id: "south", label: "South coast" },
  { id: "east", label: "East coast" },
  { id: "west", label: "West coast" },
]

const SIZES: { id: MapSize; label: string }[] = [
  { id: 256, label: "Small · 256×256 · 2.56 km" },
  { id: 512, label: "Medium · 512×512 · 5.12 km" },
  { id: 1024, label: "Large · 1024×1024 · 10.24 km" },
]

type SetupPanelProps = {
  presetId: PresetId
  latitude: number
  months: MonthClimate[]
  indices: ClimateIndices
  seed: string
  size: MapSize
  relief: number
  coast: Coast
  generating: boolean
  progress: number
  stage: string
  error: string | null
  onPreset: (id: PresetId) => void
  onLatitude: (value: number) => void
  onMonth: (index: number, key: keyof MonthClimate, value: number) => void
  onSeed: (value: string) => void
  onSize: (size: MapSize) => void
  onRelief: (value: number) => void
  onCoast: (coast: Coast) => void
  onGenerate: () => void
}

function randomSeed(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"
  let seed = ""
  for (let i = 0; i < 8; i++) {
    if (i === 4) seed += "-"
    seed += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return seed
}

function numberValue(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function SetupPanel(props: SetupPanelProps) {
  const indices = props.indices
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Ground before the city</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Choose a climate, then generate the 10 m grid the city-state would sit on.
            The same seed and settings always rebuild the same terrain, water, cover, and deposits.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="preset">Climate preset</Label>
            <Select
              value={props.presetId}
              onValueChange={(value) => {
                if (value) props.onPreset(value as PresetId)
              }}
            >
              <SelectTrigger id="preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="latitude">Latitude</Label>
              <span className="text-xs text-muted-foreground">{props.latitude.toFixed(1)}°</span>
            </div>
            <Slider
              id="latitude"
              min={-MAX_LATITUDE}
              max={MAX_LATITUDE}
              step={0.1}
              value={[props.latitude]}
              onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value
                props.onLatitude(next)
              }}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <div className="grid grid-cols-[2.4rem_repeat(4,minmax(0,1fr))] gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <span />
            <span>High</span>
            <span>Low</span>
            <span>Rain</span>
            <span>Humid</span>
          </div>
          <div className="grid gap-1">
            {props.months.map((month, index) => (
              <div
                key={MONTH_LABELS[index]}
                className="grid grid-cols-[2.4rem_repeat(4,minmax(0,1fr))] items-center gap-1"
              >
                <span className="text-xs text-muted-foreground">{MONTH_LABELS[index]}</span>
                <Input
                  aria-label={`${MONTH_LABELS[index]} high °C`}
                  className="h-7 px-1.5 text-xs"
                  type="number"
                  min={-45}
                  max={55}
                  value={month.high}
                  onChange={(event) =>
                    props.onMonth(index, "high", numberValue(event.target.value, month.high))
                  }
                />
                <Input
                  aria-label={`${MONTH_LABELS[index]} low °C`}
                  className="h-7 px-1.5 text-xs"
                  type="number"
                  min={-55}
                  max={45}
                  value={month.low}
                  onChange={(event) =>
                    props.onMonth(index, "low", numberValue(event.target.value, month.low))
                  }
                />
                <Input
                  aria-label={`${MONTH_LABELS[index]} rain mm`}
                  className="h-7 px-1.5 text-xs"
                  type="number"
                  min={0}
                  max={800}
                  value={month.precip}
                  onChange={(event) =>
                    props.onMonth(index, "precip", numberValue(event.target.value, month.precip))
                  }
                />
                <Input
                  aria-label={`${MONTH_LABELS[index]} humidity percent`}
                  className="h-7 px-1.5 text-xs"
                  type="number"
                  min={0}
                  max={100}
                  value={month.humidity}
                  onChange={(event) =>
                    props.onMonth(
                      index,
                      "humidity",
                      numberValue(event.target.value, month.humidity),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            High and low are °C. Rain is mm, from 0 to 800. Humidity is a percent.
          </p>
        </div>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Climate indices</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <Index label="Annual rain" value={`${Math.round(indices.annualPrecip)} mm`} />
            <Index label="Mean temperature" value={`${indices.meanTemp.toFixed(1)}°C`} />
            <Index label="Frost months" value={formatFrost(indices.frostMonths)} />
            <Index label="Growing season" value={formatGrowing(indices.growingMonths)} />
            <Index
              label="Aridity"
              value={`${indices.aridity.toFixed(2)} ${aridityLabel(indices.aridity)}`}
            />
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="seed">Seed</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={props.generating}
                onClick={() => props.onSeed(randomSeed())}
              >
                Randomize
              </Button>
            </div>
            <Input
              id="seed"
              value={props.seed}
              onChange={(event) => props.onSeed(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="size">Map size</Label>
            <Select
              value={String(props.size)}
              onValueChange={(value) => {
                if (value === "256" || value === "512" || value === "1024") {
                  props.onSize(Number(value) as MapSize)
                }
              }}
            >
              <SelectTrigger id="size" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZES.map((size) => (
                  <SelectItem key={size.id} value={String(size.id)}>
                    {size.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="relief">Relief</Label>
              <span className="text-xs text-muted-foreground">{Math.round(props.relief)}</span>
            </div>
            <Slider
              id="relief"
              min={0}
              max={100}
              step={1}
              value={[props.relief]}
              onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value
                props.onRelief(next)
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="coast">Coast</Label>
            <Select
              value={props.coast}
              onValueChange={(value) => {
                if (value) props.onCoast(value as Coast)
              }}
            >
              <SelectTrigger id="coast" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COASTS.map((coast) => (
                  <SelectItem key={coast.id} value={coast.id}>
                    {coast.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-2">
          <Button
            id="generate-map"
            type="button"
            className="w-full"
            size="lg"
            disabled={props.generating}
            onClick={props.onGenerate}
          >
            {props.generating ? "Generating…" : "Generate map"}
          </Button>
          {props.generating ? (
            <div className="grid gap-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${Math.round(props.progress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{props.stage}</p>
            </div>
          ) : null}
          {props.error ? (
            <p className="text-sm text-destructive" role="alert">
              {props.error}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Nothing is stored. The grid stays in this tab. Cover, fertility, and groundwater
            read the indices above, not the month table itself.
          </p>
        </div>
      </div>
    </ScrollArea>
  )
}

function Index({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="truncate">{value}</div>
    </div>
  )
}
