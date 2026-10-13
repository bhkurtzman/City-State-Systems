import { generateWorld } from "@/lib/generate"
import type { GenerateRequest, World } from "@/lib/types"

export type WorkerProgress = { fraction: number; stage: string }

type WorkerMessage =
  | { type: "progress"; fraction: number; stage: string }
  | { type: "done"; world: World }
  | { type: "error"; message: string }

export function runGeneration(
  request: GenerateRequest,
  onProgress: (progress: WorkerProgress) => void,
): Promise<World> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL("../workers/map.worker.ts", import.meta.url))
    } catch {
      try {
        resolve(generateWorld(request, (fraction, stage) => onProgress({ fraction, stage })))
      } catch (error) {
        reject(error instanceof Error ? error : new Error("The generator failed."))
      }
      return
    }

    let settled = false
    let heard = false
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("Generation took too long.")))
    }, 120_000)

    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      worker.terminate()
      done()
    }

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      heard = true
      const message = event.data
      if (message.type === "progress") {
        onProgress({ fraction: message.fraction, stage: message.stage })
        return
      }
      if (message.type === "done") {
        finish(() => resolve(message.world))
        return
      }
      finish(() => reject(new Error(message.message)))
    }

    worker.onerror = () => {
      if (heard) {
        finish(() => reject(new Error("The map worker stopped.")))
        return
      }
      finish(() => {
        try {
          resolve(generateWorld(request, (fraction, stage) => onProgress({ fraction, stage })))
        } catch (error) {
          reject(error instanceof Error ? error : new Error("The generator failed."))
        }
      })
    }

    worker.postMessage(request)
  })
}
