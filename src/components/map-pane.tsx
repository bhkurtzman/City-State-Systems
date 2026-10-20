"use client"

import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from "react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HOME_STYLE, isPlop, isWater, PLOP_STYLE, type BuildTool, type Structure } from "@/lib/buildings"
import { paintLayer } from "@/lib/colors"
import type { LayerId, World } from "@/lib/types"

export type MapPaneHandle = {
  zoomBy: (factor: number) => void
  fit: () => void
}

type Cell = { x: number; y: number }

type MapPaneProps = {
  world: World | null
  layer: LayerId
  cell: Cell | null
  generation: number
  structures: Structure[]
  tool: BuildTool | null
  onSelect: (cell: Cell) => void
  onBuild: (cells: Cell[], mode: "tap" | "stroke" | "place", latch: Set<number>, allowNew: boolean) => void
  handle: Ref<MapPaneHandle>
}

type View = { x: number; y: number; zoom: number }

export function MapPane({ world, layer, cell, generation, structures, tool, onSelect, onBuild, handle }: MapPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, zoom: 1 })
  const fitZoomRef = useRef(1)
  const dragRef = useRef<{
    x: number
    y: number
    originX: number
    originY: number
    moved: boolean
    painting: boolean
    last: Cell | null
    startedStroke: boolean
    latch: Set<number>
  } | null>(null)
  const worldRef = useRef(world)
  const cellRef = useRef(cell)
  const structuresRef = useRef(structures)
  const toolRef = useRef(tool)
  const hoverRef = useRef<Cell | null>(null)
  const [hover, setHover] = useState<Cell | null>(null)

  worldRef.current = world
  cellRef.current = cell
  structuresRef.current = structures
  toolRef.current = tool
  hoverRef.current = hover

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
    drawStructures(context, structuresRef.current, current.size, view)
    drawGhost(context, hoverRef.current, toolRef.current, structuresRef.current, current, view)
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

  useImperativeHandle(handle, () => ({ zoomBy, fit }))

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
  }, [cell, structures, tool, hover])

  const cellAt = (event: ReactPointerEvent<HTMLCanvasElement>): Cell | null => {
    const current = worldRef.current
    if (!current) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const view = viewRef.current
    const x = Math.floor((event.clientX - rect.left - view.x) / view.zoom)
    const y = Math.floor((event.clientY - rect.top - view.y) / view.zoom)
    if (x < 0 || y < 0 || x >= current.size || y >= current.size) return null
    return { x, y }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        {world ? (
          <canvas
            ref={canvasRef}
            aria-label="Planning map"
            className={tool ? "h-full w-full touch-none cursor-crosshair" : "h-full w-full touch-none"}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              } catch {
                // A pointer the browser is no longer tracking cannot be captured.
              }
              const active = toolRef.current
              const painting = event.button === 0 && (active === "farmstead" || active === "delete")
              dragRef.current = {
                x: event.clientX,
                y: event.clientY,
                originX: event.clientX,
                originY: event.clientY,
                moved: false,
                painting,
                last: cellAt(event),
                startedStroke: false,
                latch: new Set(),
              }
            }}
            onPointerMove={(event) => {
              const active = toolRef.current
              const drag = dragRef.current
              if (!drag && isPlop(active)) {
                const next = cellAt(event)
                setHover((current) => (sameCell(current, next) ? current : next))
              }
              if (!drag) return
              if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) > 3) drag.moved = true
              if (drag.painting) {
                const next = cellAt(event)
                if (drag.moved && next && drag.last) {
                  const allowNew = !drag.startedStroke
                  drag.startedStroke = true
                  onBuild(orthogonalLine(drag.last, next), "stroke", drag.latch, allowNew)
                  drag.last = next
                } else if (next) {
                  drag.last = next
                }
                drag.x = event.clientX
                drag.y = event.clientY
                return
              }
              const dx = event.clientX - drag.x
              const dy = event.clientY - drag.y
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
              if (!drag || !world) return
              if (drag.painting) {
                if (!drag.moved && drag.last) onBuild([drag.last], "tap", drag.latch, true)
                return
              }
              if (drag.moved) return
              const picked = cellAt(event)
              if (!picked) return
              if (isPlop(toolRef.current)) onBuild([picked], "place", drag.latch, false)
              else onSelect(picked)
            }}
            onPointerLeave={() => setHover(null)}
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
    </div>
  )
}

function sameCell(a: Cell | null, b: Cell | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y
}

/** Walk the columns first, then the rows, so a fast drag stays edge-connected. */
function orthogonalLine(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = []
  let x = from.x
  let y = from.y
  const stepX = Math.sign(to.x - x)
  const stepY = Math.sign(to.y - y)
  while (x !== to.x) {
    cells.push({ x, y })
    x += stepX
  }
  while (y !== to.y) {
    cells.push({ x, y })
    y += stepY
  }
  cells.push({ x, y })
  return cells
}

function drawStructures(context: CanvasRenderingContext2D, structures: readonly Structure[], size: number, view: View) {
  for (const structure of structures) {
    const alpha = structure.removing ? 0.38 : structure.pending ? 0.78 : 1
    if (structure.kind === "farmstead") {
      strokeFarm(context, structure, size, view, alpha)
      if (structure.home) drawLabelBox(context, structure.home, size, view, HOME_STYLE.fill, HOME_STYLE.label, alpha)
      continue
    }
    const style = PLOP_STYLE[structure.kind]
    drawLabelBox(context, structure.tiles, size, view, style.fill, style.label, alpha)
  }
}

function strokeFarm(
  context: CanvasRenderingContext2D,
  structure: Structure,
  size: number,
  view: View,
  alpha: number,
) {
  const tiles = new Set(structure.tiles)
  context.save()
  context.globalAlpha = alpha
  context.lineWidth = Math.max(1, Math.min(2.5, view.zoom * 0.22))
  context.beginPath()
  for (const index of structure.tiles) {
    const x = index % size
    const y = (index - x) / size
    const sx = view.x + x * view.zoom
    const sy = view.y + y * view.zoom
    const z = view.zoom
    if (x === 0 || !tiles.has(index - 1)) {
      context.moveTo(sx, sy)
      context.lineTo(sx, sy + z)
    }
    if (x + 1 === size || !tiles.has(index + 1)) {
      context.moveTo(sx + z, sy)
      context.lineTo(sx + z, sy + z)
    }
    if (y === 0 || !tiles.has(index - size)) {
      context.moveTo(sx, sy)
      context.lineTo(sx + z, sy)
    }
    if (y + 1 === size || !tiles.has(index + size)) {
      context.moveTo(sx, sy + z)
      context.lineTo(sx + z, sy + z)
    }
  }
  context.strokeStyle = structure.removing ? "rgba(176, 64, 48, 0.95)" : "rgba(236, 255, 242, 0.95)"
  context.stroke()
  context.strokeStyle = structure.removing ? "rgba(176, 64, 48, 0.55)" : "rgba(86, 168, 104, 0.7)"
  context.stroke()
  context.restore()
}

function drawGhost(
  context: CanvasRenderingContext2D,
  hover: Cell | null,
  tool: BuildTool | null,
  structures: readonly Structure[],
  world: World,
  view: View,
) {
  if (!hover || !isPlop(tool)) return
  const size = world.size
  const tiles = [hover.y * size + hover.x, hover.y * size + hover.x + 1, (hover.y + 1) * size + hover.x, (hover.y + 1) * size + hover.x + 1]
  const inside = hover.x + 1 < size && hover.y + 1 < size
  const blocked =
    !inside ||
    tiles.some(
      (index) =>
        isWater(world.terrain, world.feature, index) ||
        structures.some((structure) => structure.tiles.includes(index)),
    )
  const style = PLOP_STYLE[tool]
  const sx = view.x + hover.x * view.zoom
  const sy = view.y + hover.y * view.zoom
  const width = view.zoom * 2
  const height = view.zoom * 2
  context.save()
  context.globalAlpha = 0.45
  context.fillStyle = blocked ? "rgba(168, 48, 36, 0.9)" : style.fill
  context.fillRect(sx, sy, width, height)
  context.restore()
  if (blocked || width < 16 || height < 10) return
  context.save()
  context.globalAlpha = 0.9
  context.fillStyle = "#fff8e7"
  context.font = `600 ${Math.max(8, Math.floor(Math.min(width, height) * 0.42))}px sans-serif`
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText(style.label, sx + width / 2, sy + height / 2 + 0.5)
  context.restore()
}

function drawLabelBox(
  context: CanvasRenderingContext2D,
  tiles: readonly number[],
  size: number,
  view: View,
  fill: string,
  label: string,
  alpha: number,
) {
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
  const sx = view.x + minX * view.zoom
  const sy = view.y + minY * view.zoom
  const width = (maxX - minX + 1) * view.zoom
  const height = (maxY - minY + 1) * view.zoom
  context.save()
  context.globalAlpha = alpha
  context.fillStyle = fill
  context.fillRect(sx, sy, width, height)
  context.strokeStyle = "rgba(28, 22, 16, 0.4)"
  context.lineWidth = 1
  context.strokeRect(sx + 0.5, sy + 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
  context.restore()
  if (width < 16 || height < 10) return
  context.save()
  context.globalAlpha = 1
  context.fillStyle = "#fff8e7"
  context.font = `600 ${Math.max(8, Math.floor(Math.min(width, height) * 0.42))}px sans-serif`
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillText(label, sx + width / 2, sy + height / 2 + 0.5)
  context.restore()
}
