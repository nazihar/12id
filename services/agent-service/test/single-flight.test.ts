import assert from 'node:assert/strict'
import { test } from 'node:test'

import { singleFlight } from '../src/tenants/single-flight.ts'

test('concurrent calls for one key share a single run', async () => {
  const flight = singleFlight<number>()
  let runs = 0
  let release!: (value: number) => void
  const run = () => {
    runs += 1
    return new Promise<number>((resolve) => {
      release = resolve
    })
  }

  const first = flight('tenant-a', run)
  const second = flight('tenant-a', run)
  assert.equal(first, second)
  assert.equal(runs, 1)

  release(7)
  assert.deepEqual(await Promise.all([first, second]), [7, 7])
})

test('different keys run independently', async () => {
  const flight = singleFlight<string>()
  const results = await Promise.all([flight('a', async () => 'a'), flight('b', async () => 'b')])
  assert.deepEqual(results, ['a', 'b'])
})

test('a settled run, including a failure, lets the next call start again', async () => {
  const flight = singleFlight<string>()
  await assert.rejects(flight('a', async () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(await flight('a', async () => 'retried'), 'retried')
})
