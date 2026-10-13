"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CELL_M, FEATURE_NAME, RESOURCE_NAME, TERRAIN_NAME, type FeatureId, type ResourceId, type TerrainId, type World } from "@/lib/types"

type InspectorPanelProps = {
  world: World | null
  cell: { x: number; y: number } | null
}

export function InspectorPanel({ world, cell }: InspectorPanelProps) {
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <Card>
          <CardHeader>
            <CardTitle>Cell inspector</CardTitle>
            <CardDescription>
              {world
                ? "Choose a cell on the map."
                : "Generate a grid, then choose a cell."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {world && cell ? <CellReadout world={world} x={cell.x} y={cell.y} /> : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                The readout lists terrain, cover, fertility, groundwater, and any mineral under
                the pointer. It does not list people or ownership. Those records are not on this grid.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}

function CellReadout({ world, x, y }: { world: World; x: number; y: number }) {
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
    </dl>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
