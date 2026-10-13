import { generateWorld } from "../lib/generate"
import type { GenerateRequest } from "../lib/types"

type WorkerScope = {
  onmessage: ((event: MessageEvent<GenerateRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event: MessageEvent<GenerateRequest>) => {
  try {
    const world = generateWorld(event.data, (fraction, stage) => {
      scope.postMessage({ type: "progress", fraction, stage })
    })
    const transfer = [
      world.terrain.buffer,
      world.feature.buffer,
      world.fertility.buffer,
      world.groundwater.buffer,
      world.resourceType.buffer,
      world.resourceAmount.buffer,
    ]
    scope.postMessage({ type: "done", world }, transfer)
  } catch (error) {
    const message = error instanceof Error ? error.message : "The generator failed."
    scope.postMessage({ type: "error", message })
  }
}
