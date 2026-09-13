/**
 * Graceful shutdown for the agent-service (A8), as confirmed by spike T3b:
 *
 *   1. mark not-ready, so /readyz returns 503 and the edge stops routing;
 *   2. stop accepting internal API commands (Fastify close waits for requests already running);
 *   3. wait until no DIDComm message is being processed, with a deadline;
 *   4. call agent.shutdown() exactly once. It stops Credo's transports and closes the store.
 *
 * Never stop Credo transports separately: DidCommHttpInboundTransport.stop() is not idempotent,
 * and the second call (inside agent.shutdown) throws before the store is closed.
 */

/** The part of Credo's event emitter this module needs, so it can be tested without an agent. */
export interface EventSource {
  observable(type: string): { subscribe(listener: (event: unknown) => void): { unsubscribe(): void } }
}

/** Credo 0.7 `DidCommEventTypes` values. Kept as literals so this module has no Credo import. */
export const DIDCOMM_MESSAGE_RECEIVED = 'DidCommMessageReceived'
export const DIDCOMM_MESSAGE_PROCESSED = 'DidCommMessageProcessed'

/**
 * Counts DIDComm messages between "received" and "processed" across all tenants (events for
 * every tenant arrive on the root emitter, T1). A message whose processing throws never emits
 * "processed", which is why waiting always has a deadline.
 */
export class InFlightTracker {
  private count = 0
  private readonly subscriptions: Array<{ unsubscribe(): void }> = []
  private readonly idleWaiters = new Set<() => void>()

  public constructor(events: EventSource) {
    this.subscriptions.push(
      events.observable(DIDCOMM_MESSAGE_RECEIVED).subscribe(() => {
        this.count++
      }),
      events.observable(DIDCOMM_MESSAGE_PROCESSED).subscribe(() => {
        this.count = Math.max(0, this.count - 1)
        if (this.count === 0) for (const wake of this.idleWaiters) wake()
      })
    )
  }

  public get inFlight(): number {
    return this.count
  }

  /** Resolves `true` once idle, or `false` when the deadline passes first. */
  public waitUntilIdle(deadlineMs: number): Promise<boolean> {
    if (this.count === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.idleWaiters.delete(wake)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.idleWaiters.delete(wake)
        resolve(false)
      }, deadlineMs)
      this.idleWaiters.add(wake)
    })
  }

  public stop() {
    for (const subscription of this.subscriptions) subscription.unsubscribe()
  }
}

export interface DrainSteps {
  markDraining(): void
  closeInternalApi(): Promise<void>
  shutdownAgent(): Promise<void>
  log(message: string, fields?: Record<string, unknown>): void
}

export interface DrainReport {
  idle: boolean
  inFlightAtSignal: number
  inFlightAtShutdown: number
  durationMs: number
  error?: unknown
}

/**
 * Returns a signal handler that runs the drain once; later signals get the same promise.
 * The container stop grace period must be longer than `deadlineMs` plus shutdown time.
 */
export function createDrain(tracker: InFlightTracker, steps: DrainSteps, deadlineMs: number) {
  let running: Promise<DrainReport> | undefined

  return function drain(signal: string): Promise<DrainReport> {
    if (running) {
      steps.log('drain already running; ignoring signal', { signal })
      return running
    }
    running = (async () => {
      const started = Date.now()
      const inFlightAtSignal = tracker.inFlight
      steps.log('drain started', { signal, inFlight: inFlightAtSignal, deadlineMs })
      steps.markDraining()

      let error: unknown
      try {
        await steps.closeInternalApi()
      } catch (closeError) {
        error = closeError
        steps.log('internal API close failed; continuing drain', { error: closeError })
      }

      const idle = await tracker.waitUntilIdle(deadlineMs)
      const inFlightAtShutdown = tracker.inFlight
      if (!idle) steps.log('drain deadline passed with messages still in flight', { inFlight: inFlightAtShutdown })

      tracker.stop()
      try {
        await steps.shutdownAgent()
      } catch (shutdownError) {
        error = shutdownError
        steps.log('agent shutdown failed', { error: shutdownError })
      }

      const report: DrainReport = { idle, inFlightAtSignal, inFlightAtShutdown, durationMs: Date.now() - started, error }
      steps.log('drain finished', { ...report, error: error ? String(error) : undefined })
      return report
    })()
    return running
  }
}
