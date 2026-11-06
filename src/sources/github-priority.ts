/** The priority a GitHub issue or pull request states through its labels, and the anomaly contradictory labels make. */
import { DEFAULT_PRIORITY, type Priority } from '../core/index.ts'

/** The labels that state a priority, from the most urgent to the least. */
export const PRIORITY_LABELS = ['priority/P0', 'priority/P1', 'priority/P2', 'priority/P3', 'priority/P4'] as const

/** The priority a label states, or undefined when the label states none. */
const labelPriority = (label: string): Priority | undefined => {
  const match = /^priority\/p([0-4])$/i.exec(label.trim())
  return match ? Number(match[1]) as Priority : undefined
}

/**
 * The priority the labels of a GitHub issue or pull request state: the most urgent of them, the default when none states one,
 * and the anomaly when several of them contradict each other, which the most urgent label settles for the queue.
 * `stated` says whether a label states a priority at all, so a trigger carries none when the issue has no priority label.
 */
export function priorityOfLabels(labels: readonly string[]): { priority: Priority; stated: boolean; anomaly?: string } {
  const stated = labels.map(labelPriority).filter((value): value is Priority => value !== undefined)
  if (!stated.length) return { priority: DEFAULT_PRIORITY, stated: false }
  const priority = Math.min(...stated) as Priority
  const distinct = [...new Set(stated)].sort((a, b) => a - b)
  if (distinct.length < 2) return { priority, stated: true }
  const names = distinct.map(value => `P${value}`).join(', ')
  return { priority, stated: true, anomaly: `Contradictory priority labels: ${names}. The most urgent applies.` }
}
