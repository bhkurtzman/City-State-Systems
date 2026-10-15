"use client"

import { useMemo, useState } from "react"
import { InspectorPanel } from "@/components/inspector-panel"
import { MapPane } from "@/components/map-pane"
import { SetupPanel } from "@/components/setup-panel"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  cloneMonths,
  deriveClimate,
  presetById,
  sanitizeMonth,
  temperaturesForLatitude,
  type PresetId,
} from "@/lib/climate"
import { runGeneration } from "@/lib/run-generation"
import type { Coast, LayerId, MapSize, MonthClimate, World } from "@/lib/types"
import { cn } from "@/lib/utils"

const INITIAL = presetById("mediterranean")

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
  const [panel, setPanel] = useState("setup")
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState("Preparing the grid")
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  const indices = useMemo(() => deriveClimate(latitude, months), [latitude, months])

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
      if (window.matchMedia("(max-width: 767px)").matches) setPanel("map")
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The generator failed."
      setError(`The map could not be generated. ${message}`)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="shrink-0 border-b px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">City-state planning map</h1>
        <p className="text-sm text-muted-foreground">
          A 10 m grid for the ground under a city that does not exist yet.
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_minmax(240px,320px)] md:grid-rows-1">
        <section className={cn("min-h-0", panel === "setup" ? "block" : "hidden", "md:block")}>
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
            generating={generating}
            progress={progress}
            stage={stage}
            error={error}
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
            onGenerate={() => {
              void generate()
            }}
          />
        </section>
        <section
          className={cn(
            "min-h-0",
            panel === "map" ? "flex flex-col" : "hidden",
            "md:flex md:flex-col",
          )}
        >
          <MapPane
            world={world}
            layer={layer}
            cell={cell}
            generation={generation}
            onLayer={setLayer}
            onSelect={setCell}
          />
        </section>
        <section className={cn("min-h-0", panel === "cell" ? "block" : "hidden", "md:block")}>
          <InspectorPanel world={world} cell={cell} />
        </section>
      </div>
      <div className="shrink-0 border-t p-2 md:hidden">
        <Tabs
          value={panel}
          onValueChange={(value) => {
            if (typeof value === "string") setPanel(value)
          }}
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="cell">Cell</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  )
}
