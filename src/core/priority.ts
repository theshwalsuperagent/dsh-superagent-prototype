/** The priority a Ticket waits in the launch queue with, and the order the queue takes the Tickets in. */

/**
 * The urgency of the work a Ticket does, from the most urgent (`P0`) to the least (`P4`).
 * A Source states it (such as a GitHub issue's `priority/P1` label); the queue starts the most urgent Ticket first.
 */
export type Priority = 0 | 1 | 2 | 3 | 4

/** The priority a Ticket has when its Source states none. */
export const DEFAULT_PRIORITY: Priority = 2
