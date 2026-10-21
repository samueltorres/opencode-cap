import { Plugin } from "@opencode/plugin"
import { assess, formatUSD, Ledger } from "./src/ledger.js"
import { parseAmount, parseOptions } from "./src/options.js"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Event = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

interface Budget {
  limit?: number
  warned: boolean
  exceeded: boolean
}

/** A subagent as persisted in `tree/<rootID>`. */
type StoredChild = { parentID: string; cost: number }

const RESUBSCRIBE_DELAY_MS = 1_000

export default Plugin.define({
  id: "opencode-cap",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const ledger = new Ledger()
    // Budgets are kept per root session; subagent sessions share their root's budget.
    const budgets = new Map<string, Budget>()
    const loading = new Map<string, Promise<void>>()
    // Persisted per root session so they survive restarts: the limit set with /budget, and the
    // subagent tree with each subagent's last known cost, so its spend still counts once deleted.
    const limitKey = (rootID: string) => `limit/${rootID}`
    const treeKey = (rootID: string) => `tree/${rootID}`

    const saveTree = (rootID: string) =>
      ctx.storage.set(
        treeKey(rootID),
        Object.fromEntries(
          ledger
            .tree(rootID)
            .slice(1)
            .map((id) => [id, { parentID: ledger.parent(id) ?? rootID, cost: ledger.cost(id) }]),
        ),
      )

    const addChild = async (sessionID: string, parentID: string, cost = 0) => {
      if (ledger.has(sessionID)) return
      ledger.track(sessionID, parentID, cost)
      await saveTree(ledger.root(sessionID))
    }

    // Loads a session the plugin has not seen yet, e.g. one created before OpenCode restarted.
    const ensure = (sessionID: string): Promise<void> => {
      if (ledger.has(sessionID)) return Promise.resolve()
      let pending = loading.get(sessionID)
      if (!pending) {
        pending = load(sessionID).finally(() => loading.delete(sessionID))
        loading.set(sessionID, pending)
      }
      return pending
    }

    const load = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID !== undefined) {
        await ensure(session.parentID)
        await addChild(sessionID, session.parentID, session.cost)
        return
      }
      const [limit, tree] = await Promise.all([
        ctx.storage.get(limitKey(sessionID)),
        ctx.storage.get(treeKey(sessionID)),
      ])
      const stored = Object.entries(typeof tree === "object" && tree !== null ? tree : {}).filter(
        (entry): entry is [string, StoredChild] => isStoredChild(entry[1]),
      )
      // Prefer the live cost; a deleted or unreadable subagent keeps its last known spend.
      const children = await Promise.all(
        stored.map(async ([childID, child]) => {
          const live = await ctx.session.get({ sessionID: childID }).then(
            (info) => info.cost,
            () => 0,
          )
          return [childID, { ...child, cost: Math.max(live, child.cost) }] as const
        }),
      )

      // Track the root and its subagents together, so callers never see a partially loaded tree.
      ledger.track(sessionID, undefined, session.cost)
      budgets.set(sessionID, { limit: typeof limit === "number" ? limit : options.limit, warned: false, exceeded: false })
      // Place children whose parent is tracked until no more fit, independent of storage key order.
      let remaining = children
      for (;;) {
        const placeable = remaining.filter(([, child]) => ledger.has(child.parentID))
        if (placeable.length === 0) break
        placeable.forEach(([childID, child]) => ledger.track(childID, child.parentID, child.cost))
        remaining = remaining.filter(([childID]) => !ledger.has(childID))
      }
    }

    const note = (sessionID: string, text: string) =>
      // `resume: false` records the note without starting another (billed) model turn.
      ctx.session.synthetic({ sessionID, text, resume: false })

    const stop = (sessionIDs: string[]) =>
      Promise.allSettled(sessionIDs.map((sessionID) => ctx.session.interrupt({ sessionID, resume: false })))

    const spent = (rootID: string) => {
      const subagents = ledger.tree(rootID).length - 1
      return `this session${subagents > 0 ? ` and its ${subagents} subagent${subagents === 1 ? "" : "s"}` : ""} spent ${formatUSD(ledger.total(rootID))}`
    }

    const exceededMessage = (rootID: string, limit: number) =>
      `Budget exceeded: ${spent(rootID)}, over the ${formatUSD(limit)} limit, so opencode-cap stopped it. ` +
      `Run /budget <amount> to raise this session's limit.`

    /** Checks a session tree's spend; `started` marks a new execution that must not run over budget. */
    const enforce = async (sessionID: string, started: boolean) => {
      await ensure(sessionID)
      const rootID = ledger.root(sessionID)
      const budget = budgets.get(rootID)
      if (budget?.limit === undefined) return

      const verdict = assess(ledger.total(rootID), budget.limit, options.warn)
      if (verdict === "exceeded") {
        const first = !budget.exceeded
        budget.exceeded = true
        // First interrupt every session: background subagents keep running when their parent stops.
        // After that, any session that still spends or starts is interrupted again, which also
        // retries an interrupt that failed. Interrupting an idle session is a no-op.
        await stop(first ? ledger.tree(rootID) : [sessionID])
        if (first || started) await note(rootID, exceededMessage(rootID, budget.limit))
        return
      }
      budget.exceeded = false
      if (verdict === "warn" && !budget.warned) {
        budget.warned = true
        await note(
          rootID,
          `Budget warning: ${spent(rootID)} of its ${formatUSD(budget.limit)} limit. ` +
            `Wrap up soon; work stops when the limit is exceeded.`,
        )
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "budget",
        description: "Show this session's spend including subagents, or set its limit: /budget [amount]",
        execute: async ({ sessionID, prompt }) => {
          await ensure(sessionID)
          const rootID = ledger.root(sessionID)
          const budget = budgets.get(rootID)
          if (!budget) return

          if (prompt.text.trim() !== "") {
            const amount = parseAmount(prompt.text)
            if (amount === undefined) {
              await note(sessionID, `Usage: /budget [amount], e.g. /budget 10 for a $10.00 limit.`)
              return
            }
            await ctx.storage.set(limitKey(rootID), amount)
            budget.limit = amount
            // Re-evaluated at the next execution, which is stopped if still over the new limit.
            budget.exceeded = false
            budget.warned = assess(ledger.total(rootID), amount, options.warn) !== "ok"
          }

          const total = ledger.total(rootID)
          const status =
            budget.limit === undefined
              ? `${spent(rootID)}. No limit is set.`
              : `${spent(rootID)} of its ${formatUSD(budget.limit)} limit (${Math.round((total / budget.limit) * 100)}%).`
          await note(sessionID, `Budget: ${status}`)
        },
      })
    })

    const handle = async (event: Event) => {
      switch (event.type) {
        case "session.created": {
          const { sessionID, parentID } = event.data
          if (parentID === undefined) {
            if (!ledger.has(sessionID)) {
              ledger.track(sessionID)
              budgets.set(sessionID, { limit: options.limit, warned: false, exceeded: false })
            }
            return
          }
          await ensure(parentID)
          await addChild(sessionID, parentID)
          return
        }
        case "session.usage.updated": {
          const { sessionID, cost } = event.data
          await ensure(sessionID)
          ledger.setCost(sessionID, cost)
          if (ledger.parent(sessionID) !== undefined) await saveTree(ledger.root(sessionID))
          await enforce(sessionID, false)
          return
        }
        case "session.execution.started":
          await enforce(event.data.sessionID, true)
          return
        case "session.deleted": {
          const { sessionID } = event.data
          // A deleted subagent's spend still counts against its root.
          if (ledger.has(sessionID) && ledger.root(sessionID) !== sessionID) return
          // Roots are cleaned up even when never loaded since a restart.
          ledger.forget(sessionID)
          budgets.delete(sessionID)
          await Promise.all([ctx.storage.remove(limitKey(sessionID)), ctx.storage.remove(treeKey(sessionID))])
          return
        }
      }
    }

    const controller = new AbortController()
    const { signal } = controller
    // Resubscribes if the stream ends or fails while loaded. Usage events carry cumulative costs and
    // unknown sessions are loaded on sight, so spend from any missed events is caught up later.
    void (async () => {
      while (!signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal })) {
            await handle(event).catch((error) => console.error(`opencode-cap: failed to handle ${event.type}`, error))
          }
        } catch (error) {
          if (!signal.aborted) console.error("opencode-cap: event subscription failed", error)
        }
        if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY_MS))
      }
    })()

    return () => controller.abort()
  },
})

function isStoredChild(value: unknown): value is StoredChild {
  if (typeof value !== "object" || value === null) return false
  const { parentID, cost } = value as Record<string, unknown>
  return typeof parentID === "string" && typeof cost === "number" && Number.isFinite(cost)
}
