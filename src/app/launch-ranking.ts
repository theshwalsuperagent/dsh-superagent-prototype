/** A FIFO-preserving rank for the launch effects only (other effects remain FIFO). */
export const PRIORITY_AGE_STEP_MS = 24 * 60 * 60 * 1000

export interface LaunchRow { seq: number; since: string }

/** Lower numbers go first: P0 = 0 through P4 = 4; missing/invalid => P2. */
export function effectiveLaunchPriority(priority: number, since: string, at: number): number {
  const baseline = Number.isInteger(priority) && priority >= 0 && priority <= 4 ? priority : 2
  const queuedAt = Date.parse(since)
  const age = Number.isFinite(queuedAt) ? Math.max(0, at - queuedAt) : 0
  // Gradual aging prevents indefinite starvation under a sustained high-priority load.
  return Math.max(0, baseline - Math.floor(age / PRIORITY_AGE_STEP_MS))
}

/** Stable, pure priority ordering for already-due effect rows. */
export function rankLaunchRows<T extends LaunchRow>(rows: readonly T[], priority: (row: T) => number, at: number): T[] {
  return rows.map(row => ({ row, rank: effectiveLaunchPriority(priority(row), row.since, at) }))
    .sort((a, b) => a.rank - b.rank || a.row.seq - b.row.seq)
    .map(({ row }) => row)
}
