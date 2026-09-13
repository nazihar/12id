import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DIDCOMM_MESSAGE_PROCESSED,
  DIDCOMM_MESSAGE_RECEIVED,
  type DrainSteps,
  type EventSource,
  InFlightTracker,
  createDrain,
} from '../src/lifecycle/drain.ts'

class FakeEvents implements EventSource {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public observable(type: string) {
    return {
      subscribe: (listener: (event: unknown) => void) => {
        const set = this.listeners.get(type) ?? new Set()
        set.add(listener)
        this.listeners.set(type, set)
        return { unsubscribe: () => set.delete(listener) }
      },
    }
  }

  public emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type })
  }
}

function recordingSteps(order: string[], overrides: Partial<DrainSteps> = {}): DrainSteps {
  return {
    markDraining: () => order.push('markDraining'),
    closeInternalApi: async () => {
      order.push('closeInternalApi')
    },
    shutdownAgent: async () => {
      order.push('shutdownAgent')
    },
    log: () => undefined,
    ...overrides,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('InFlightTracker', () => {
  it('counts messages between received and processed', () => {
    const events = new FakeEvents()
    const tracker = new InFlightTracker(events)
    events.emit(DIDCOMM_MESSAGE_RECEIVED)
    events.emit(DIDCOMM_MESSAGE_RECEIVED)
    events.emit(DIDCOMM_MESSAGE_PROCESSED)
    assert.equal(tracker.inFlight, 1)
    events.emit(DIDCOMM_MESSAGE_PROCESSED)
    events.emit(DIDCOMM_MESSAGE_PROCESSED) // a stray processed event never drives the count negative
    assert.equal(tracker.inFlight, 0)
  })

  it('waitUntilIdle resolves when the last message finishes', async () => {
    const events = new FakeEvents()
    const tracker = new InFlightTracker(events)
    events.emit(DIDCOMM_MESSAGE_RECEIVED)
    const idle = tracker.waitUntilIdle(1_000)
    setTimeout(() => events.emit(DIDCOMM_MESSAGE_PROCESSED), 20)
    assert.equal(await idle, true)
  })

  it('waitUntilIdle gives up at the deadline (a throwing message never emits processed)', async () => {
    const events = new FakeEvents()
    const tracker = new InFlightTracker(events)
    events.emit(DIDCOMM_MESSAGE_RECEIVED)
    assert.equal(await tracker.waitUntilIdle(30), false)
    assert.equal(tracker.inFlight, 1)
  })
})

describe('createDrain', () => {
  it('runs the steps in order and shuts the agent down only after in-flight work finishes', async () => {
    const events = new FakeEvents()
    const tracker = new InFlightTracker(events)
    const order: string[] = []
    events.emit(DIDCOMM_MESSAGE_RECEIVED)

    const drain = createDrain(tracker, recordingSteps(order), 1_000)
    const report = drain('SIGTERM')
    await sleep(20)
    assert.deepEqual(order, ['markDraining', 'closeInternalApi'], 'agent must not shut down while a message is in flight')

    events.emit(DIDCOMM_MESSAGE_PROCESSED)
    const result = await report
    assert.deepEqual(order, ['markDraining', 'closeInternalApi', 'shutdownAgent'])
    assert.equal(result.idle, true)
    assert.equal(result.inFlightAtSignal, 1)
    assert.equal(result.inFlightAtShutdown, 0)
  })

  it('shuts the agent down exactly once when signalled twice', async () => {
    const events = new FakeEvents()
    const order: string[] = []
    const drain = createDrain(new InFlightTracker(events), recordingSteps(order), 1_000)
    const [first, second] = await Promise.all([drain('SIGTERM'), drain('SIGINT')])
    assert.equal(first, second)
    assert.equal(order.filter((step) => step === 'shutdownAgent').length, 1)
  })

  it('still shuts down after the deadline, and reports it', async () => {
    const events = new FakeEvents()
    const tracker = new InFlightTracker(events)
    const order: string[] = []
    events.emit(DIDCOMM_MESSAGE_RECEIVED)
    const result = await createDrain(tracker, recordingSteps(order), 30)('SIGTERM')
    assert.equal(result.idle, false)
    assert.equal(result.inFlightAtShutdown, 1)
    assert.ok(order.includes('shutdownAgent'))
  })

  it('shuts the agent down even if closing the internal API fails', async () => {
    const order: string[] = []
    const steps = recordingSteps(order, {
      closeInternalApi: async () => {
        throw new Error('close failed')
      },
    })
    const result = await createDrain(new InFlightTracker(new FakeEvents()), steps, 1_000)('SIGTERM')
    assert.ok(order.includes('shutdownAgent'))
    assert.match(String(result.error), /close failed/)
  })
})
