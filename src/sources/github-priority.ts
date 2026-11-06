/** Strict GitHub label interpretation: only priority/P0..P4 are priority labels. */
export interface GithubPriority { level: number; conflict: boolean }

export function githubPriority(labels: unknown): GithubPriority | undefined {
  // Missing labels are not a verified empty set: preserve the previous cached value.
  if (!Array.isArray(labels)) return undefined
  const levels = new Set<number>()
  for (const label of labels) {
    const name = typeof label === 'string' ? label
      : label && typeof label === 'object' && 'name' in label && typeof label.name === 'string' ? label.name : ''
    const match = /^priority\/P([0-4])$/.exec(name)
    if (match) levels.add(Number(match[1]))
  }
  // Multiple distinct labels are invalid: use safe default P2 and flag conflict.
  return { level: levels.size === 1 ? [...levels][0]! : 2, conflict: levels.size > 1 }
}
