"use client"

import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { legendFor, paintLayer } from "@/lib/colors"
import { LAYERS, type LayerId, type World } from "@/lib/types"

type MapPaneProps = {
  world: World | null
  layer: LayerId
  cell: { x: number; y: number } | null
  generation: number
  onLayer: (layer: LayerId) => void
  onSelect: (cell: { x: number; y: number }) => void
}

export function MapPane({ world, layer, cell, generation, onLayer, onSelect }: MapPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef({ x: 0, y: 0, zoom: 1 })
  const fitZoomRef = useRef(1)
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const worldRef = useRef(world)
  const cellRef = useRef(cell)

  useEffect(() => {
    worldRef.current = world
    cellRef.current = cell
  }, [world, cell])

  const draw = () => {
    const canvas = canvasRef.current
    const bitmap = bitmapRef.current
    const current = worldRef.current
    if (!canvas || !bitmap || !current) return
    const context = canvas.getContext("2d")
    if (!context) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width < 2 || height < 2) return
    const ratio = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.floor(width * ratio))
    const pixelHeight = Math.max(1, Math.floor(height * ratio))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.imageSmoothingEnabled = false
    context.fillStyle = "#d9d2c3"
    context.fillRect(0, 0, width, height)
    const view = viewRef.current
    context.drawImage(bitmap, view.x, view.y, current.size * view.zoom, current.size * view.zoom)
    const selected = cellRef.current
    if (!selected) return
    const sx = view.x + selected.x * view.zoom
    const sy = view.y + selected.y * view.zoom
    context.strokeStyle = "#1c1915"
    context.lineWidth = 1
    context.strokeRect(sx - 1, sy - 1, Math.max(view.zoom, 1) + 2, Math.max(view.zoom, 1) + 2)
    context.strokeStyle = "#fff8e7"
    context.strokeRect(sx, sy, Math.max(view.zoom, 1), Math.max(view.zoom, 1))
  }

  const fit = () => {
    const canvas = canvasRef.current
    const current = worldRef.current
    if (!canvas || !current) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width < 8 || height < 8) return
    const zoom = Math.min(width / current.size, height / current.size) * 0.94
    fitZoomRef.current = zoom
    viewRef.current = {
      zoom,
      x: (width - current.size * zoom) / 2,
      y: (height - current.size * zoom) / 2,
    }
    draw()
  }

  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const view = viewRef.current
    const cx = canvas.clientWidth / 2
    const cy = canvas.clientHeight / 2
    const next = Math.min(48, Math.max(fitZoomRef.current * 0.6, view.zoom * factor))
    const worldX = (cx - view.x) / view.zoom
    const worldY = (cy - view.y) / view.zoom
    viewRef.current = { zoom: next, x: cx - worldX * next, y: cy - worldY * next }
    draw()
  }

  useEffect(() => {
    if (!world) {
      bitmapRef.current = null
      return
    }
    const bitmap = document.createElement("canvas")
    bitmap.width = world.size
    bitmap.height = world.size
    const context = bitmap.getContext("2d")
    if (!context) return
    const image = context.createImageData(world.size, world.size)
    paintLayer(world, layer, image.data)
    context.putImageData(image, 0, 0)
    bitmapRef.current = bitmap
    draw()
  }, [world, layer])

  useEffect(() => {
    fit()
    // Fit only when a new grid is ready, not when the layer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      if (viewRef.current.zoom === 1 && worldRef.current) fit()
      else draw()
    })
    observer.observe(canvas)
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      observer.disconnect()
      canvas.removeEventListener("wheel", onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world])

  useEffect(() => {
    draw()
  }, [cell])

  const legend = legendFor(layer)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs
          value={layer}
          onValueChange={(value) => {
            if (typeof value === "string") onLayer(value as LayerId)
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
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => zoomBy(1 / 1.2)} disabled={!world}>
            −
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => zoomBy(1.2)} disabled={!world}>
            +
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={fit} disabled={!world}>
            Fit
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {world ? (
          <canvas
            ref={canvasRef}
            aria-label="Planning map"
            className="h-full w-full touch-none"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = { x: event.clientX, y: event.clientY, moved: false }
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag) return
              const dx = event.clientX - drag.x
              const dy = event.clientY - drag.y
              if (Math.hypot(dx, dy) > 3) drag.moved = true
              viewRef.current = {
                ...viewRef.current,
                x: viewRef.current.x + dx,
                y: viewRef.current.y + dy,
              }
              drag.x = event.clientX
              drag.y = event.clientY
              draw()
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current
              dragRef.current = null
              if (!drag || drag.moved || !world) return
              const rect = event.currentTarget.getBoundingClientRect()
              const view = viewRef.current
              const x = Math.floor((event.clientX - rect.left - view.x) / view.zoom)
              const y = Math.floor((event.clientY - rect.top - view.y) / view.zoom)
              if (x < 0 || y < 0 || x >= world.size || y >= world.size) return
              onSelect({ x, y })
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <Card className="max-w-md">
              <CardHeader>
                <CardTitle>No grid yet</CardTitle>
                <CardDescription>
                  Set the climate and generate a map. This is the ground a city-state would be
                  planned on: terrain, rivers, lakes, cover, fertility, groundwater, and mineral
                  deposits. The same seed rebuilds the same land.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        )}
        {world ? (
          <div className="pointer-events-none absolute top-2 left-2 rounded-md bg-card/90 px-2 py-1 text-xs font-medium shadow-sm ring-1 ring-foreground/10">
            North
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        {legend.swatches.map((swatch) => (
          <span key={swatch.label} className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded-sm ring-1 ring-foreground/15" style={{ background: swatch.hex }} />
            {swatch.label}
          </span>
        ))}
        <span className="basis-full leading-relaxed sm:basis-auto">
          {cell
            ? `Cell ${cell.x}, ${cell.y}. `
            : ""}
          {legend.note ?? "Drag to pan. Scroll to zoom. One pixel is one 10 m cell."}
        </span>
      </div>
    </div>
  )
}
