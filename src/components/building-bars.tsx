"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BASIC_BUILDINGS, BUILD_CAP, FARMSTEAD_CAP, canBuild, type BuildTool, type Structure } from "@/lib/buildings"
import { cn } from "@/lib/utils"

export type FarmDraw = "draw" | "rect"

const BUILD_INFO: Partial<Record<BuildTool, { name: string; detail: string }>> = {
  farmstead: {
    name: "Farmstead",
    detail: "No materials. A dry 1×2 house is placed when the month advances. Up to 2,000 tiles. Crops, pasture, woods, and fish come from the tiles.",
  },
  shack: {
    name: "Shack",
    detail: "A 1×2 house on prairie, scrub, or barren. No mountain and no materials. One household.",
  },
  "construction-office": {
    name: "Construction Office",
    detail: "A 3×3 state building on dry ground. One per town. Each laborer gives 100 man-hours a month. A staffed office keeps lumber, steel parts, and textiles.",
  },
  "trading-post": {
    name: "Trading Post",
    detail: "A 2×2 post. Up to three. Moves 1 t each way per month. Takes 1 t of grain in November and may use leather, textiles, and steel tools in January.",
  },
  market: {
    name: "Market",
    detail: "A 2×2 shop. One per town. Sells from a shelf at 10% over cost. The family lives in the market.",
  },
  sawpit: {
    name: "Sawpit",
    detail: "A 2×2 pit. One per town. No materials. Runs the sawmill recipe and opens with a household pantry.",
  },
  "cart-path": {
    name: "Cart Path",
    detail: "A straight cardinal line. Hill is 15 man-hours, scrub adds 10, woodland 20, forest 50, and wetland 30. Woodland yields 2 t and forest 5 t. Wetland takes 1 t of wood.",
  },
  "wooden-bridge": {
    name: "Wooden Bridge",
    detail: "A straight line on sea or fresh water. Each tile must touch land, so a crossing wider than two tiles is refused. 300 man-hours, 5 t of lumber, and 0.1 t of steel parts per tile.",
  },
  workshop: {
    name: "Workshop",
    detail: "800 man-hours, 20 t of lumber, and 0.3 t of steel parts. Woods add clearing time. Sawmill, blacksmith, smokehouse, creamery, or cooper.",
  },
  shop: {
    name: "Shop",
    detail: "500 man-hours, 12 t of lumber, and 0.1 t of steel parts. Woods add clearing time. Baker, grocer, butcher, hardware, or draper.",
  },
  "caravan-house": {
    name: "Caravan House",
    detail: "A 2×3 house. 1,500 man-hours, 40 t of lumber, 0.4 t of steel parts, and 0.1 t of textiles. Hauls goods once a finished road reaches the map edge.",
  },
}

export type BuildCategory = "basic" | "infrastructure" | "production" | "residential"

const INFRASTRUCTURE: readonly { id: BuildTool; label: string; enabled: boolean }[] = [
  { id: "cart-path", label: "Cart Path", enabled: true },
  { id: "wooden-bridge", label: "Wooden Bridge", enabled: true },
]

const PRODUCTION: readonly { id: BuildTool; label: string; enabled: boolean }[] = [
  { id: "workshop", label: "Workshop", enabled: true },
  { id: "caravan-house", label: "Caravan House", enabled: true },
]

const RESIDENTIAL: readonly { id: BuildTool; label: string; enabled: boolean }[] = [
  { id: "shop", label: "Shop", enabled: true },
]

export function BuildInfoBar({
  tool,
  farmDraw,
  onFarmDraw,
  northSouth,
  eastWest,
  onNorthSouth,
  onEastWest,
}: {
  tool: BuildTool | null
  farmDraw: FarmDraw
  onFarmDraw: (mode: FarmDraw) => void
  northSouth: string
  eastWest: string
  onNorthSouth: (value: string) => void
  onEastWest: (value: string) => void
}) {
  if (!tool || tool === "delete") return null
  const info = BUILD_INFO[tool]
  if (!info) return null
  const plot = farmPlot(northSouth, eastWest)
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-t px-3 py-1">
      <div className="min-w-0 flex-1 truncate text-sm" title={info.detail}>
        <span className="font-medium">{info.name}</span>
        <span className="text-muted-foreground"> — {info.detail}</span>
      </div>
      {tool === "farmstead" ? (
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant={farmDraw === "draw" ? "secondary" : "outline"} aria-pressed={farmDraw === "draw"} onClick={() => onFarmDraw("draw")}>
              Free draw
            </Button>
            <Button type="button" size="sm" variant={farmDraw === "rect" ? "secondary" : "outline"} aria-pressed={farmDraw === "rect"} onClick={() => onFarmDraw("rect")}>
              Rectangle
            </Button>
            {farmDraw === "rect" ? (
              <>
                <label className="ml-1 text-xs text-muted-foreground" htmlFor="farm-ns">
                  N-S
                </label>
                <Input id="farm-ns" inputMode="numeric" value={northSouth} onChange={(event) => onNorthSouth(event.target.value.replace(/[^\d]/g, "").slice(0, 4))} className="h-7 w-14 px-2 text-sm" />
                <label className="text-xs text-muted-foreground" htmlFor="farm-ew">
                  E-W
                </label>
                <Input id="farm-ew" inputMode="numeric" value={eastWest} onChange={(event) => onEastWest(event.target.value.replace(/[^\d]/g, "").slice(0, 4))} className="h-7 w-14 px-2 text-sm" />
              </>
            ) : null}
          </div>
          {farmDraw === "rect" && plot ? (
            <p className={cn("text-xs", plot.over ? "text-red-700" : "text-muted-foreground")}>{plot.label}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function farmPlot(northSouth: string, eastWest: string): { label: string; over: boolean } | null {
  if (!/^\d+$/.test(northSouth) || !/^\d+$/.test(eastWest)) return null
  const tiles = Number(northSouth) * Number(eastWest)
  if (tiles < 1) return null
  const hectares = tiles / 100
  const hectareText = hectares.toLocaleString("en-US", { maximumFractionDigits: 2 })
  return { label: `${tiles.toLocaleString("en-US")} tiles, ${hectareText} ha`, over: tiles > FARMSTEAD_CAP }
}

export function CategoryBar({
  category,
  onCategory,
  tool,
  onTool,
}: {
  category: BuildCategory
  onCategory: (category: BuildCategory) => void
  tool: BuildTool | null
  onTool: (tool: BuildTool) => void
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3">
      <Button
        type="button"
        size="sm"
        variant={category === "basic" ? "secondary" : "outline"}
        aria-pressed={category === "basic"}
        onClick={() => onCategory("basic")}
      >
        Basic
      </Button>
      <Button
        type="button"
        size="sm"
        variant={category === "infrastructure" ? "secondary" : "outline"}
        aria-pressed={category === "infrastructure"}
        onClick={() => onCategory("infrastructure")}
      >
        Infrastructure
      </Button>
      <Button
        type="button"
        size="sm"
        variant={category === "production" ? "secondary" : "outline"}
        aria-pressed={category === "production"}
        onClick={() => onCategory("production")}
      >
        Production/Trade
      </Button>
      <Button
        type="button"
        size="sm"
        variant={category === "residential" ? "secondary" : "outline"}
        aria-pressed={category === "residential"}
        onClick={() => onCategory("residential")}
      >
        Residential/Shops
      </Button>
      <Button
        type="button"
        size="sm"
        variant={tool === "delete" ? "secondary" : "outline"}
        aria-pressed={tool === "delete"}
        className="ml-auto"
        onClick={() => onTool("delete")}
      >
        Delete
      </Button>
    </div>
  )
}

export function BuildingMenu({
  category,
  tool,
  structures,
  onTool,
}: {
  category: BuildCategory
  tool: BuildTool | null
  structures: readonly Structure[]
  onTool: (tool: BuildTool) => void
}) {
  const buildings = category === "infrastructure" ? INFRASTRUCTURE : category === "production" ? PRODUCTION : category === "residential" ? RESIDENTIAL : BASIC_BUILDINGS
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {buildings.map((building) => {
        const room = canBuild(structures, building.id)
        const cap = BUILD_CAP[building.id]
        return (
          <Button
            key={building.id}
            type="button"
            size="sm"
            variant={tool === building.id ? "secondary" : "outline"}
            aria-pressed={tool === building.id}
            disabled={!building.enabled || !room}
            title={!building.enabled ? "Not available yet" : !room && cap !== undefined ? `Limit of ${cap}` : undefined}
            className={cn("shrink-0", (!building.enabled || !room) && "opacity-50")}
            onClick={() => onTool(building.id)}
          >
            {building.label}
          </Button>
        )
      })}
    </div>
  )
}
