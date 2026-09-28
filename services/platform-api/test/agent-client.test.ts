/**
 * The agent client's catalogue cache (review L14): one agent round trip per tenant per TTL, cleared
 * by the catalogue writes that go through the client, and never keeping a failed read.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AgentError, createAgentClient } from '../src/agent-client.ts'

function recordingFetch(answer: (url: URL, method: string) => Response = () => Response.json([])) {
  const calls: string[] = []
  const fetch = (async (input: URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${input.pathname}`)
    return answer(input, method)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const token = 'x'.repeat(40)

describe('agent client catalogue cache', () => {
  it('reads each tenant catalogue once per TTL and shares a read in flight', async () => {
    const { calls, fetch } = recordingFetch()
    const agent = createAgentClient({ baseUrl: 'http://agent.test', token, fetch, catalogueTtlMs: 60_000 })
    await Promise.all([agent.listCatalogue('t1'), agent.listCatalogue('t1')])
    await agent.listCatalogue('t1')
    await agent.listCatalogue('t2')
    assert.deepEqual(calls, ['GET /tenants/t1/catalogue', 'GET /tenants/t2/catalogue'])
  })

  it('clears the tenant after a publish or deprecation, even a failed one', async () => {
    const { calls, fetch } = recordingFetch((url, method) =>
      method === 'POST' && url.pathname.endsWith('/schemas') ? Response.json({ error: 'conflict', reason: 'exists' }, { status: 409 }) : Response.json(method === 'GET' ? [] : { status: 'deprecated' })
    )
    const agent = createAgentClient({ baseUrl: 'http://agent.test', token, fetch, catalogueTtlMs: 60_000 })
    await agent.listCatalogue('t1')
    await agent.listCatalogue('t2')
    await agent.setSchemaDeprecated('t1', 's1', true)
    await agent.listCatalogue('t1')
    await agent.listCatalogue('t2')
    await assert.rejects(agent.publishSchema('t1', { name: 'n', version: '1.0', attributes: ['a'] }), AgentError)
    await agent.listCatalogue('t1')
    assert.deepEqual(calls, [
      'GET /tenants/t1/catalogue',
      'GET /tenants/t2/catalogue',
      'POST /tenants/t1/schemas/s1/deprecation',
      'GET /tenants/t1/catalogue',
      'POST /tenants/t1/schemas',
      'GET /tenants/t1/catalogue',
    ])
  })

  it('does not keep a failed read, and TTL 0 turns the cache off', async () => {
    let fail = true
    const { calls, fetch } = recordingFetch(() => (fail ? new Response('down', { status: 503 }) : Response.json([])))
    const agent = createAgentClient({ baseUrl: 'http://agent.test', token, fetch, catalogueTtlMs: 60_000 })
    await assert.rejects(agent.listCatalogue('t1'), AgentError)
    fail = false
    await agent.listCatalogue('t1')
    await agent.listCatalogue('t1')
    assert.equal(calls.length, 2)

    const uncached = recordingFetch()
    const plain = createAgentClient({ baseUrl: 'http://agent.test', token, fetch: uncached.fetch, catalogueTtlMs: 0 })
    await plain.listCatalogue('t1')
    await plain.listCatalogue('t1')
    assert.equal(uncached.calls.length, 2)
  })
})
