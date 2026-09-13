import '../src/bindings.ts'

import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'

import { LogLevel } from '@credo-ts/core'
import { pino, stdSerializers } from 'pino'

import { PinoCredoLogger, createServiceLogger } from '../src/logger.ts'

function capture(level: string) {
  const lines: Array<Record<string, unknown>> = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(JSON.parse(line))
      callback()
    },
  })
  return { lines, logger: pino({ level, serializers: { err: stdSerializers.err } }, stream) }
}

describe('PinoCredoLogger', () => {
  it('follows the pino level so Credo skips work for dropped levels', () => {
    const { logger } = capture('warn')
    const credo = new PinoCredoLogger(logger)
    assert.equal(credo.logLevel, LogLevel.Warn)
    logger.level = 'debug'
    assert.equal(credo.logLevel, LogLevel.Debug)
  })

  it('maps Credo `{ error }` to pino `err` so the stack is serialised', () => {
    const { lines, logger } = capture('info')
    new PinoCredoLogger(logger).error('Failed to process message', { error: new Error('Invalid resource handle'), tenant: 't1' })
    assert.equal(lines.length, 1)
    const err = lines[0].err as { message: string; stack: string }
    assert.equal(err.message, 'Invalid resource handle')
    assert.match(err.stack, /Error: Invalid resource handle/)
    assert.equal(lines[0].tenant, 't1')
    assert.equal(lines[0].error, undefined)
  })

  it('drops messages below the configured level', () => {
    const { lines, logger } = capture('warn')
    const credo = new PinoCredoLogger(logger)
    credo.debug('noise')
    credo.info('noise')
    credo.warn('kept')
    assert.deepEqual(lines.map((line) => line.msg), ['kept'])
  })
})

describe('createServiceLogger', () => {
  it('redacts store keys and passwords at the top level and nested', () => {
    const chunks: string[] = []
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    })
    const logger = createServiceLogger({ name: 'test', level: 'info', destination })
    logger.info({ key: 'top-secret', store: { id: 'root', key: 'nested-secret' }, db: { password: 'pw' } }, 'config')

    const output = chunks.join('')
    assert.match(output, /"msg":"config"/)
    assert.doesNotMatch(output, /top-secret|nested-secret|"pw"/)
    const line = JSON.parse(output) as { key: string; store: { id: string; key: string }; db: { password: string } }
    assert.equal(line.key, '[redacted]')
    assert.equal(line.store.key, '[redacted]')
    assert.equal(line.store.id, 'root')
    assert.equal(line.db.password, '[redacted]')
  })
})
