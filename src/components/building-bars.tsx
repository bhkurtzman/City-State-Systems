"use client"

import { Button } from "@/components/ui/button"
import { BASIC_BUILDINGS, type BuildTool } from "@/lib/buildings"
import { cn } from "@/lib/utils"

export type BuildCategory = "basic" | "infrastructure"

const INFRASTRUCTURE: readonly { id: BuildTool; label: string; enabled: boolean }[] = [
  { id: "cart-path", label: "Cart Path", enabled: true },
]

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
  onTool,
}: {
  category: BuildCategory
  tool: BuildTool | null
  onTool: (tool: BuildTool) => void
}) {
  const buildings = category === "infrastructure" ? INFRASTRUCTURE : BASIC_BUILDINGS
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {buildings.map((building) => (
        <Button
          key={building.id}
          type="button"
          size="sm"
          variant={tool === building.id ? "secondary" : "outline"}
          aria-pressed={tool === building.id}
          disabled={!building.enabled}
          title={building.enabled ? undefined : "Not available yet"}
          className={cn("shrink-0", !building.enabled && "opacity-50")}
          onClick={() => onTool(building.id)}
        >
          {building.label}
        </Button>
      ))}
    </div>
  )
}
