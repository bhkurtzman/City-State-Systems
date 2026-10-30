"use client"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { structureKindName, type Structure } from "@/lib/buildings"
import type { OfficeCrew } from "@/lib/construction"
import { MONTHLY_HOURS } from "@/lib/roads"
import type { PropertyLine } from "@/lib/land"
import { legendFor } from "@/lib/colors"
import { CELL_M, FEATURE_NAME, RESOURCE_NAME, TERRAIN_NAME, type FeatureId, type LayerId, type ResourceId, type TerrainId, type World } from "@/lib/types"

type InspectorPanelProps = {
  world: World | null
  cell: { x: number; y: number } | null
  layer: LayerId
  structure: string | null
  open: boolean
  onToggle: () => void
}

export function InspectorPanel({ world, cell, layer, structure, open, onToggle }: InspectorPanelProps) {
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={onToggle}>
        Cell inspector
      </Button>
    )
  }

  return (
    <Card className="max-h-full w-72 overflow-auto shadow-md">
      <CardHeader>
        <CardTitle>Cell inspector</CardTitle>
        <CardDescription>Choose a cell on the map.</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={onToggle}>
            Minimize
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {world && cell ? <CellReadout world={world} x={cell.x} y={cell.y} structure={structure} /> : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            The readout lists terrain, cover, fertility, groundwater, and any mineral under
            the pointer. It does not list people. Those records are not on this grid.
          </p>
        )}
        <Legend layer={layer} />
      </CardContent>
    </Card>
  )
}

function CellReadout({ world, x, y, structure }: { world: World; x: number; y: number; structure: string | null }) {
  const index = y * world.size + x
  const terrain = world.terrain[index] as TerrainId
  const feature = world.feature[index] as FeatureId
  const resource = world.resourceType[index] as ResourceId
  const amount = world.resourceAmount[index]
  return (
    <dl className="grid gap-2 text-sm">
      <Row label="Cell" value={`${x}, ${y}`} />
      <Row label="Position" value={`${x * CELL_M} m east, ${y * CELL_M} m south`} />
      <Row label="Terrain" value={TERRAIN_NAME[terrain]} />
      <Row label="Feature" value={feature === 0 ? "—" : FEATURE_NAME[feature]} />
      <Row label="Fertility" value={`${world.fertility[index]}`} />
      <Row label="Groundwater" value={`${world.groundwater[index]}`} />
      <Row
        label="Resource"
        value={resource === 0 ? "None" : `${RESOURCE_NAME[resource]} · ${amount}%`}
      />
      {structure ? <Row label="Structure" value={structure} /> : null}
    </dl>
  )
}

function Legend({ layer }: { layer: LayerId }) {
  const legend = legendFor(layer)
  return (
    <div className="mt-3 grid gap-2 border-t pt-3">
      <div className="text-xs font-medium">Legend</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {legend.swatches.map((swatch) => (
          <span key={swatch.label} className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-sm ring-1 ring-foreground/15" style={{ background: swatch.hex }} />
            {swatch.label}
          </span>
        ))}
      </div>
      {legend.note ? <p className="text-xs leading-relaxed text-muted-foreground">{legend.note}</p> : null}
    </div>
  )
}

type BuildingInspectorProps = {
  structure: Structure | null
  size: number
  chosen: boolean
  lines: readonly PropertyLine[]
  office: OfficeCrew | null
  /** E1 yearly wage, in whole dollars. */
  wage: number
  road: readonly PropertyLine[] | null
  open: boolean
  onToggle: () => void
  onWorkers: (structureId: number, target: number) => void
}

export function BuildingInspector({ structure, size, chosen, lines, office, wage, road, open, onToggle, onWorkers }: BuildingInspectorProps) {
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={onToggle}>
        Building inspector
      </Button>
    )
  }

  return (
    <Card className="max-h-full w-72 overflow-auto shadow-md">
      <CardHeader>
        <CardTitle>Building inspector</CardTitle>
        <CardDescription>{road && !structure ? "The road on the selected cell." : "The farmstead or building on the selected cell."}</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={onToggle}>
            Minimize
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {structure ? (
          <BuildingReadout structure={structure} size={size} lines={lines} office={office} wage={wage} onWorkers={onWorkers} />
        ) : road && road.length > 0 ? (
          <dl className="grid gap-2 text-sm">
            {road.map((line) => (
              <Row key={line.label} label={line.label} value={line.value} />
            ))}
          </dl>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {chosen
              ? "No farmstead or building on this cell."
              : "Choose a cell on the map."}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function BuildingReadout({
  structure,
  size,
  lines,
  office,
  wage,
  onWorkers,
}: {
  structure: Structure
  size: number
  lines: readonly PropertyLine[]
  office: OfficeCrew | null
  wage: number
  onWorkers: (structureId: number, target: number) => void
}) {
  const status = structure.removing ? "Removing" : structure.pending ? "Planned" : "In place"
  const fresh = !structure.pending && structure.fresh.length > 0 ? structure.fresh.length : 0
  const target = office?.target ?? 0
  const crew = office?.crew.length ?? 0
  const leaving = Math.max(0, crew - target)
  return (
    <dl className="grid gap-2 text-sm">
      <Row label="Kind" value={structureKindName(structure.kind)} />
      <Row label="Status" value={status} />
      <Row label="Tiles" value={`${structure.tiles.length}`} />
      <Row label="Area" value={`${(structure.tiles.length * CELL_M * CELL_M).toLocaleString("en-US")} m²`} />
      <Row label="Extent" value={formatExtent(structure.tiles, size)} />
      {structure.kind === "farmstead" || structure.kind === "shack" ? (
        <Row label="House" value={structure.home ? `${formatCell(structure.home[0], size)} and ${formatCell(structure.home[1], size)}` : "None"} />
      ) : null}
      {fresh > 0 ? <Row label="Planned tiles" value={`${fresh}`} /> : null}
      {lines.map((line) => (
        <Row key={line.label} label={line.label} value={line.value} />
      ))}
      {structure.kind === "construction-office" ? (
        <div className="grid gap-2 pt-1">
          <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">Workers</dt>
            <dd className="font-medium">{crew} of {target}</dd>
          </div>
          <Row label="Man-hours" value={`${crew * MONTHLY_HOURS}`} />
          <Slider
            aria-label="Laborers"
            min={0}
            max={10}
            step={2}
            value={[target]}
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value
              if (typeof next === "number") onWorkers(structure.id, next)
            }}
          />
          <p className="text-xs leading-snug text-muted-foreground">
            {leaving > 0 ? `${leaving} leave in January.` : structure.pending ? "Hiring starts when the office opens." : crew < target ? "Open jobs are filled each month." : `E1 wage $${wage.toLocaleString("en-US")} a year.`}
          </p>
          {leaving > 0 || structure.pending || crew < target ? (
            <p className="text-xs leading-snug text-muted-foreground">E1 wage ${wage.toLocaleString("en-US")} a year.</p>
          ) : null}
        </div>
      ) : null}
    </dl>
  )
}

function formatCell(index: number, size: number) {
  const x = index % size
  const y = (index - x) / size
  return `${x}, ${y}`
}

function formatExtent(tiles: readonly number[], size: number) {
  let minX = size
  let minY = size
  let maxX = 0
  let maxY = 0
  for (const index of tiles) {
    const x = index % size
    const y = (index - x) / size
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (minX === maxX && minY === maxY) return formatCell(minY * size + minX, size)
  return `${minX}, ${minY} to ${maxX}, ${maxY}`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
