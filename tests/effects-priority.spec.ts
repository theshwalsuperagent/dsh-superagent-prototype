/** #2920: real durable SQLite dispatcher orders only pending launches by dynamic priority. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'

it('orders pending launch rows by current priority without modifying their durable sequence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-priority-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const ranks = new Map([['low', 4], ['normal', 2], ['urgent', 0], ['urgent-2', 0]])
    const order: string[] = []
    const effects = new Effects(store, new HealthBoard())
    effects.handle('launch', async p => { order.push(p.ticketId) }, {
      limit: () => 1, priority: p => ranks.get(p.ticketId) ?? 2,
    })
    // The queue has not started yet: all rows retain their original, durable FIFO sequence.
    for (const id of ['low', 'normal', 'urgent', 'urgent-2'])
      effects.enqueue('launch', id, { ticketId: id, assignmentId: id })
    effects.start()
    await effects.idle()
    expect(order).toEqual(['urgent', 'urgent-2', 'normal', 'low'])
    expect(effects.pending('launch')).toBe(false)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('uses updated GitHub priorities at dispatch, preserving FIFO on ties', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-priority-updated-'))
  const store = new Store(join(dir, 'db.sqlite'))
  try {
    const rank = new Map([['first', 3], ['second', 2]])
    const order: string[] = []
    const effects = new Effects(store, new HealthBoard())
    effects.handle('launch', async p => { order.push(p.ticketId) }, { limit: () => 1,
      priority: p => rank.get(p.ticketId) ?? 2 })
    effects.enqueue('launch', 'first', { ticketId: 'first', assignmentId: 'first' })
    effects.enqueue('launch', 'second', { ticketId: 'second', assignmentId: 'second' })
    rank.set('first', 0)
    effects.start()
    await effects.idle()
    expect(order).toEqual(['first', 'second'])
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
