/** #2920: GitHub priority classification and durable FIFO / aging semantics. */
import { expect, it } from 'vitest'
import { githubPriority } from '../src/sources/github-priority.ts'
import { PRIORITY_AGE_STEP_MS, rankLaunchRows } from '../src/app/launch-ranking.ts'

const NOW = Date.parse('2026-11-06T00:00:00Z')
const row = (seq: number, level: number, ageMs = 0) =>
  ({ seq, level, since: new Date(NOW - ageMs).toISOString() })

it('maps exactly one priority label, with default P2 and a visible conflict', () => {
  expect(githubPriority([{ name: 'priority/P0' }])).toEqual({ level: 0, conflict: false })
  expect(githubPriority(['priority/P4'])).toEqual({ level: 4, conflict: false })
  expect(githubPriority([{ name: 'priority/P2' }, { name: 'docs' }])).toEqual({ level: 2, conflict: false })
  expect(githubPriority([])).toEqual({ level: 2, conflict: false })
  expect(githubPriority([{ name: 'priority/P0' }, { name: 'priority/P4' }])).toEqual({ level: 2, conflict: true })
  expect(githubPriority([{ name: 'priority/P5' }])).toEqual({ level: 2, conflict: false })
  expect(githubPriority(undefined)).toBeUndefined()
})

it('prioritizes P0 to P4, then uses original durable sequence as FIFO', () => {
  const entries = [row(1, 3), row(2, 1), row(3, 1), row(4, 0), row(5, 4), row(6, 2)]
  expect(rankLaunchRows(entries, item => item.level, NOW).map(item => item.seq)).toEqual([4, 2, 3, 6, 1, 5])
  expect(entries.map(item => item.seq)).toEqual([1, 2, 3, 4, 5, 6])
})

it('recomputes queued labels without changing sequence or running work', () => {
  const entries = [row(1, 3), row(2, 2)]
  expect(rankLaunchRows(entries, item => item.level, NOW).map(item => item.seq)).toEqual([2, 1])
  entries[0]!.level = 0
  expect(rankLaunchRows(entries, item => item.level, NOW).map(item => item.seq)).toEqual([1, 2])
})

it('ages waiting tasks one priority every 24 hours and avoids starvation', () => {
  const entries = [row(1, 4, 4 * PRIORITY_AGE_STEP_MS), row(2, 0), row(3, 3)]
  expect(rankLaunchRows(entries, item => item.level, NOW).map(item => item.seq)).toEqual([1, 2, 3])
})

it('maps invalid priority, timestamps, and future dates safely to P2 behavior', () => {
  const entries = [
    { seq: 1, level: Number.NaN, since: 'bad-date' },
    { seq: 2, level: 1, since: 'bad-date' },
    { seq: 3, level: -1, since: new Date(NOW + PRIORITY_AGE_STEP_MS).toISOString() },
  ]
  expect(rankLaunchRows(entries, item => item.level, NOW).map(item => item.seq)).toEqual([2, 1, 3])
})
