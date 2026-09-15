/**
 * Joins concurrent calls for the same key onto one in-flight run. The next call after the run
 * settles (resolved or rejected) starts a new one.
 */
export function singleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>()
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(key)
    if (running) return running
    const started = run().finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }
}
