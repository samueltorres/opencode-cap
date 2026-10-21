import { Plugin } from "@opencode/plugin"
import { assess, formatUSD, Ledger } from "./src/ledger.js"
import { parseAmount, parseOptions } from "./src/options.js"

interface Budget {
  limit?: number
  warned: boolean
  exceeded: boolean
}

export default Plugin.define({
  id: "opencode-cap",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const ledger = new Ledger()
    // Budgets are kept per root session; subagent sessions share their root's budget.
    const budgets = new Map<string, Budget>()
    const loading = new Map<string, Promise<void>>()
    // Persisted per root session so they survive restarts: the limit set with /budget, and the
    // subagent tree as { childID: parentID } so earlier subagent spend is still counted.
    const limitKey = (rootID: string) => `limit/${rootID}`
    const treeKey = (rootID: string) => `tree/${rootID}`

    const addRoot = (sessionID: string, cost: number, limit = options.limit) => {
      ledger.track(sessionID, undefined, cost)
      budgets.set(sessionID, { limit, warned: false, exceeded: false })
    }

    const addChild = async (sessionID: string, parentID: string, cost = 0) => {
      if (ledger.has(sessionID)) return
      ledger.track(sessionID, parentID, cost)
      const rootID = ledger.root(sessionID)
      const tree = ledger.tree(rootID).slice(1)
      await ctx.storage.set(treeKey(rootID), Object.fromEntries(tree.map((id) => [id, ledger.parent(id) ?? rootID])))
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
      addRoot(sessionID, session.cost, typeof limit === "number" ? limit : undefined)
      if (typeof tree !== "object" || tree === null || Array.isArray(tree)) return
      // Entries are in creation order, so parents are tracked before their children.
      const children = Object.entries(tree).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      const costs = await Promise.all(
        children.map(([childID]) =>
          ctx.session.get({ sessionID: childID }).then(
            (child) => child.cost,
            () => 0,
          ),
        ),
      )
      children.forEach(([childID, parentID], index) => {
        if (ledger.has(parentID)) ledger.track(childID, parentID, costs[index])
      })
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
        if (!budget.exceeded) {
          budget.exceeded = true
          // Interrupt every session: background subagents keep running when their parent stops.
          await stop(ledger.tree(rootID))
          await note(rootID, exceededMessage(rootID, budget.limit))
        } else if (started) {
          await stop([sessionID])
          await note(rootID, exceededMessage(rootID, budget.limit))
        }
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

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          switch (event.type) {
            case "session.created": {
              const { sessionID, parentID } = event.data
              if (parentID === undefined) {
                if (!ledger.has(sessionID)) addRoot(sessionID, 0)
                break
              }
              await ensure(parentID)
              await addChild(sessionID, parentID)
              break
            }
            case "session.usage.updated":
              await ensure(event.data.sessionID)
              ledger.setCost(event.data.sessionID, event.data.cost)
              await enforce(event.data.sessionID, false)
              break
            case "session.execution.started":
              await enforce(event.data.sessionID, true)
              break
            case "session.deleted": {
              const { sessionID } = event.data
              // A deleted subagent's spend still counts against its root.
              if (!ledger.has(sessionID) || ledger.root(sessionID) !== sessionID) break
              ledger.forget(sessionID)
              budgets.delete(sessionID)
              await Promise.all([ctx.storage.remove(limitKey(sessionID)), ctx.storage.remove(treeKey(sessionID))])
              break
            }
          }
        } catch (error) {
          console.error(`opencode-cap: failed to handle ${event.type}`, error)
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("opencode-cap: event subscription ended", error)
    })

    return () => controller.abort()
  },
})
