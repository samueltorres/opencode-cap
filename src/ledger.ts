/**
 * Cost accounting for session trees.
 *
 * OpenCode reports each session's own running cost; a subagent's spend is recorded on its
 * child session, not on the parent. The ledger links sessions to their parents so spend can
 * be summed per root session, which is what a user experiences as "one session".
 */
export class Ledger {
  readonly #sessions = new Map<string, { parentID?: string; cost: number; children: Set<string> }>()

  has(sessionID: string): boolean {
    return this.#sessions.has(sessionID)
  }

  /** Records a session under its parent. The parent must already be tracked. */
  track(sessionID: string, parentID?: string, cost = 0): void {
    if (this.#sessions.has(sessionID)) return
    if (parentID !== undefined) {
      const parent = this.#sessions.get(parentID)
      if (!parent) throw new Error(`Parent session ${parentID} is not tracked`)
      parent.children.add(sessionID)
    }
    this.#sessions.set(sessionID, { parentID, cost, children: new Set() })
  }

  /** Sets a session's cumulative cost, as reported by `session.usage.updated`. */
  setCost(sessionID: string, cost: number): void {
    const session = this.#sessions.get(sessionID)
    if (session) session.cost = cost
  }

  cost(sessionID: string): number {
    return this.#sessions.get(sessionID)?.cost ?? 0
  }

  parent(sessionID: string): string | undefined {
    return this.#sessions.get(sessionID)?.parentID
  }

  root(sessionID: string): string {
    let current = sessionID
    for (;;) {
      const parentID = this.#sessions.get(current)?.parentID
      if (parentID === undefined) return current
      current = parentID
    }
  }

  /** The session and all of its descendants, parents before children. */
  tree(sessionID: string): string[] {
    const ids: string[] = []
    const visit = (id: string) => {
      const session = this.#sessions.get(id)
      if (!session) return
      ids.push(id)
      session.children.forEach(visit)
    }
    visit(sessionID)
    return ids
  }

  total(sessionID: string): number {
    return this.tree(sessionID).reduce((sum, id) => sum + (this.#sessions.get(id)?.cost ?? 0), 0)
  }

  /** Drops a session and its descendants. */
  forget(sessionID: string): void {
    const ids = this.tree(sessionID)
    const parentID = this.#sessions.get(sessionID)?.parentID
    if (parentID !== undefined) this.#sessions.get(parentID)?.children.delete(sessionID)
    ids.forEach((id) => this.#sessions.delete(id))
  }
}

export type Verdict = "ok" | "warn" | "exceeded"

/** Classifies spend against a limit. Spending exactly the limit is still within budget. */
export function assess(total: number, limit: number, warn: number | false): Verdict {
  if (total > limit) return "exceeded"
  if (warn !== false && total >= limit * warn) return "warn"
  return "ok"
}

export function formatUSD(amount: number): string {
  return `$${amount.toFixed(amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2)}`
}
