/** The priority of the work a ticket does: the order the launch queue takes its tickets in, and the labels that state it. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { priorityOfLabels } from '../src/sources/github-priority.ts'
import type { Priority, Trigger } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

describe('the durable launch queue', () => {
  let directory: string
  let store: Store
  let clock: number
  let effects: Effects
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'priority-'))
    store = new Store(join(directory, 'db.sqlite'))
    clock = Date.parse('2026-09-09T00:00:00Z')
    effects = new Effects(store, new HealthBoard(), () => clock)
    effects.start()
  })
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const launch = (key: string) => ({ ticketId: key, assignmentId: key })

  it('runs the rows of a kind in the order of their priority, and the oldest first among the rows of one priority', async () => {
    const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
    effects.handle('launch', run, { limit: () => 1 })
    // Queued in the order the tickets were accepted: P3, P1, P2, P1, P4.
    for (const [key, priority] of [['a', 3], ['b', 1], ['c', 2], ['d', 1], ['e', 4]] as [string, number][])
      effects.enqueue('launch', key, launch(key), priority)
    await effects.idle()
    expect(run.mock.calls.map(([, key]) => key)).toEqual(['b', 'd', 'c', 'a', 'e'])
  })

  it('keeps the rows of a kind that state no priority in the order they were queued', async () => {
    const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
    effects.handle('launch', run, { limit: () => 1 })
    effects.enqueue('launch', 'first', launch('first'))
    effects.enqueue('launch', 'second', launch('second'))
    await effects.idle()
    expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second'])
  })

  it('moves a waiting row to another priority, which changes the place it waits in', async () => {
    const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
    let room = 0
    effects.handle('launch', run, { limit: () => room })
    effects.enqueue('launch', 'first', launch('first'), 3)
    effects.enqueue('launch', 'second', launch('second'), 3)
    await effects.idle()
    expect(run).not.toHaveBeenCalled()
    // The row that moves to a more urgent priority waits before the one that was queued before it.
    effects.reprioritize('launch', 'second', 0)
    room = 1
    await effects.idle()
    expect(run.mock.calls.map(([, key]) => key)).toEqual(['second', 'first'])
  })

  it('makes a row that waits long enough more urgent, so the least urgent work does not starve', async () => {
    const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
    let room = 0
    effects.handle('launch', run, { limit: () => room, aged: true })
    effects.enqueue('launch', 'least', launch('least'), 4)
    await effects.idle()
    expect(run).not.toHaveBeenCalled()
    // Four days of waiting make the least urgent row as urgent as the most urgent one queued today.
    clock += 4 * 24 * 3600_000
    effects.enqueue('launch', 'urgent', launch('urgent'), 1)
    room = 1
    await effects.idle()
    expect(run.mock.calls.map(([, key]) => key)).toEqual(['least', 'urgent'])
  })

  it('keeps the waiting rows and their priorities across a restart', async () => {
    const run = vi.fn(async () => {})
    let room = 0
    effects.handle('launch', run, { limit: () => room })
    effects.enqueue('launch', 'first', launch('first'), 3)
    effects.enqueue('launch', 'second', launch('second'), 0)
    await effects.idle()
    expect(run).not.toHaveBeenCalled()
    await effects.drain()
    // A new queue on the same database keeps the rows, and the priority each waits with.
    const next = new Effects(store, new HealthBoard(), () => clock)
    next.start()
    const again = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
    room = 1
    next.handle('launch', again, { limit: () => room })
    await next.idle()
    expect(again.mock.calls.map(([, key]) => key)).toEqual(['second', 'first'])
  })
})

describe('the priority a GitHub issue states', () => {
  it('takes the default when no label states one', () => {
    expect(priorityOfLabels([])).toEqual({ priority: 2, stated: false })
    expect(priorityOfLabels(['bug', 'cat-tech-debt'])).toEqual({ priority: 2, stated: false })
  })

  it('takes the priority each label states', () => {
    expect(priorityOfLabels(['priority/P0']).priority).toBe(0)
    expect(priorityOfLabels(['priority/P1']).priority).toBe(1)
    expect(priorityOfLabels(['priority/P2']).priority).toBe(2)
    expect(priorityOfLabels(['priority/P3']).priority).toBe(3)
    expect(priorityOfLabels(['priority/P4']).priority).toBe(4)
    expect(priorityOfLabels(['bug', 'priority/P3']).priority).toBe(3)
    expect(priorityOfLabels(['priority/P1']).stated).toBe(true)
  })

  it('takes the most urgent of contradictory labels and reports the anomaly', () => {
    const { priority, anomaly } = priorityOfLabels(['priority/P0', 'priority/P3'])
    expect(priority).toBe(0)
    expect(anomaly).toContain('P0')
    expect(anomaly).toContain('P3')
  })
})

describe('the workers of a ticket queue', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })
  /** A request that states the priority of the work it starts. */
  const prioritized = (id: string, priority: Priority): Trigger => ({ ...feishu(id, `@bot 修${id}`), priority })
  /** The tickets whose worker holds a slot. */
  const running = (tickets: { ticket: { id: string; priority?: Priority }; sessionId: string }[]) =>
    tickets.filter(item => h.agents.get(item.sessionId)?.status === 'running')
  /** How many workers may run at once. */
  const workers = (count: number) => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: count } })
  }
  /** The worker's turn ends, and DSH says so. */
  const idle = (sessionId: string) => {
    const agent = h.agents.get(sessionId)!
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  }

  it('starts the most urgent tickets first when the workers are full', async () => {
    await h.runtime.settings.pause(true, 'panel')
    const tickets = []
    for (const [id, priority] of [['1', 3], ['2', 1], ['3', 4], ['4', 0], ['5', 2]] as [string, Priority][])
      tickets.push(await h.acceptedTicket(prioritized(id, priority)))
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.idle()
    // The three workers the queue holds go to P0, P1 and P2; the older P3 and P4 wait.
    expect(running(tickets).map(item => item.ticket.priority).sort()).toEqual([0, 1, 2])
  })

  it('starts the older ticket first among the tickets of one priority', async () => {
    await h.runtime.settings.pause(true, 'panel')
    const tickets = []
    for (const id of ['1', '2', '3', '4']) tickets.push(await h.acceptedTicket(prioritized(id, 2)))
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.idle()
    expect(running(tickets).map(item => item.ticket.id)).toEqual([tickets[0]!.ticket.id, tickets[1]!.ticket.id, tickets[2]!.ticket.id])
  })

  it('moves a waiting ticket when its priority changes, and never reorders a launch that started', async () => {
    workers(1)
    await h.runtime.settings.pause(true, 'panel')
    const first = await h.acceptedTicket(prioritized('1', 4))
    const second = await h.acceptedTicket(prioritized('2', 4))
    const third = await h.acceptedTicket(prioritized('3', 4))
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.idle()
    expect(h.agents.get(first.sessionId)?.status).toBe('running')
    expect(h.agents.get(second.sessionId)?.status).not.toBe('running')
    // The label of the waiting ticket changed: it takes its new place in the queue, and the worker that started is not reordered.
    h.runtime.engine.setPriority(second.ticket.id, 0)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(second.ticket.id)?.priority).toBe(0)
    expect(h.agents.get(first.sessionId)?.status).toBe('running')
    expect(h.agents.get(second.sessionId)?.status).not.toBe('running')
    // The slot the first worker held frees, and the more urgent ticket takes it before the older one.
    idle(first.sessionId)
    await vi.waitFor(() => expect(h.agents.get(second.sessionId)?.status).toBe('running'))
    expect(h.agents.get(third.sessionId)?.status).not.toBe('running')
  })

  it('keeps a ticket a person stopped out of the queue', async () => {
    await h.runtime.settings.pause(true, 'panel')
    const one = await h.acceptedTicket(prioritized('1', 0))
    h.runtime.engine.stopTicket(one.ticket.id)
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.idle()
    expect(h.agents.get(one.sessionId)?.status).not.toBe('running')
  })

  it('keeps the slot a person\'s message wakes in, ahead of the tickets that wait', async () => {
    workers(1)
    const one = await h.acceptedTicket(prioritized('1', 4))
    // Its turn ends, so its worker waits and holds no slot.
    idle(one.sessionId)
    await h.runtime.idle()
    // Another worker takes the only slot.
    const two = await h.acceptedTicket(prioritized('2', 4))
    expect(h.agents.get(two.sessionId)?.status).toBe('running')
    // A person's message reaches the first ticket, whose worker wakes in the slot kept for a person.
    h.runtime.receive(feishu('3', '补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_alice' }))
    await h.runtime.idle()
    expect(h.deliveries.mock.calls.map(([call]) => call.sessionId)).toContain(one.sessionId)
  })
})
