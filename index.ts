import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Plugin } from "@opencode/plugin"
import { assess, countTokens, formatTokens, formatUSD, Ledger } from "./src/ledger.js"
import { parseAmount, parseOptions, parseTokens } from "./src/options.js"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Event = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

type Kind = "cost" | "tokens"

interface Budget {
  limit?: number
  tokenLimit?: number
  /** The limits the session has been warned about. */
  warned: Set<Kind>
  exceeded: boolean
}

/** One limit of a budget with the session tree's spend against it, phrased for messages. */
interface Measure {
  kind: Kind
  used: number
  limit: number
  /** The spend, e.g. "$1.10" or "120,000 tokens". */
  spent: string
  /** The limit, e.g. "$1.00 limit" or "100,000 token limit". */
  cap: string
  /** The command that raises the limit. */
  raise: string
}

/** A subagent as persisted in `tree/<rootID>`. Entries saved before token tracking have no `tokens`. */
type StoredChild = { parentID: string; cost: number; tokens?: number }

const RESUBSCRIBE_DELAY_MS = 1_000

export default Plugin.define({
  id: "opencode-cap",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const ledger = new Ledger()
    // Budgets are kept per root session; subagent sessions share their root's budget.
    const budgets = new Map<string, Budget>()
    const loading = new Map<string, Promise<void>>()
    // Persisted per root session so they survive restarts: the limits set with /budget, and the
    // subagent tree with each subagent's last known usage, so its spend still counts once deleted.
    const limitKey = (rootID: string) => `limit/${rootID}`
    const tokenLimitKey = (rootID: string) => `tokenLimit/${rootID}`
    const treeKey = (rootID: string) => `tree/${rootID}`

    const saveTree = (rootID: string) =>
      ctx.storage.set(
        treeKey(rootID),
        Object.fromEntries(
          ledger
            .tree(rootID)
            .slice(1)
            .map((id) => [
              id,
              { parentID: ledger.parent(id) ?? rootID, cost: ledger.cost(id), tokens: ledger.tokens(id) },
            ]),
        ),
      )

    const addChild = async (sessionID: string, parentID: string, cost = 0, tokens = 0) => {
      if (ledger.has(sessionID)) return
      ledger.track(sessionID, parentID, cost, tokens)
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

    const newBudget = (limit = options.limit, tokenLimit = options.tokenLimit): Budget => ({
      limit,
      tokenLimit,
      warned: new Set(),
      exceeded: false,
    })

    const load = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID !== undefined) {
        await ensure(session.parentID)
        await addChild(sessionID, session.parentID, session.cost, countTokens(session.tokens))
        return
      }
      const [limit, tokenLimit, tree] = await Promise.all([
        ctx.storage.get(limitKey(sessionID)),
        ctx.storage.get(tokenLimitKey(sessionID)),
        ctx.storage.get(treeKey(sessionID)),
      ])
      const stored = Object.entries(typeof tree === "object" && tree !== null ? tree : {}).filter(
        (entry): entry is [string, StoredChild] => isStoredChild(entry[1]),
      )
      // Prefer the live usage; a deleted or unreadable subagent keeps its last known spend.
      const children = await Promise.all(
        stored.map(async ([childID, child]) => {
          const live = await ctx.session.get({ sessionID: childID }).then(
            (info) => ({ cost: info.cost, tokens: countTokens(info.tokens) }),
            () => ({ cost: 0, tokens: 0 }),
          )
          const usage = { cost: Math.max(live.cost, child.cost), tokens: Math.max(live.tokens, child.tokens ?? 0) }
          return [childID, { ...child, ...usage }] as const
        }),
      )

      // Track the root and its subagents together, so callers never see a partially loaded tree.
      ledger.track(sessionID, undefined, session.cost, countTokens(session.tokens))
      budgets.set(
        sessionID,
        newBudget(
          typeof limit === "number" ? limit : options.limit,
          typeof tokenLimit === "number" ? tokenLimit : options.tokenLimit,
        ),
      )
      // Place children whose parent is tracked until no more fit, independent of storage key order.
      let remaining = children
      for (;;) {
        const placeable = remaining.filter(([, child]) => ledger.has(child.parentID))
        if (placeable.length === 0) break
        placeable.forEach(([childID, child]) => ledger.track(childID, child.parentID, child.cost, child.tokens))
        remaining = remaining.filter(([childID]) => !ledger.has(childID))
      }
    }

    const note = (sessionID: string, text: string) =>
      // `resume: false` records the note without starting another (billed) model turn.
      ctx.session.synthetic({ sessionID, text, resume: false })

    const stop = (sessionIDs: string[]) =>
      Promise.allSettled(sessionIDs.map((sessionID) => ctx.session.interrupt({ sessionID, resume: false })))

    const spent = (rootID: string, amounts: string[]) => {
      const subagents = ledger.tree(rootID).length - 1
      return `this session${subagents > 0 ? ` and its ${subagents} subagent${subagents === 1 ? "" : "s"}` : ""} spent ${amounts.join(" and ")}`
    }

    /** The limits set on a budget, each with the session tree's spend against it. */
    const measures = (rootID: string, budget: Budget): Measure[] => {
      const result: Measure[] = []
      if (budget.limit !== undefined) {
        const used = ledger.total(rootID)
        const cap = `${formatUSD(budget.limit)} limit`
        result.push({ kind: "cost", used, limit: budget.limit, spent: formatUSD(used), cap, raise: "/budget <amount>" })
      }
      if (budget.tokenLimit !== undefined) {
        const used = ledger.totalTokens(rootID)
        result.push({
          kind: "tokens",
          used,
          limit: budget.tokenLimit,
          spent: `${formatTokens(used)} tokens`,
          cap: `${formatTokens(budget.tokenLimit)} token limit`,
          raise: "/budget tokens <amount>",
        })
      }
      return result
    }

    const exceededMessage = (rootID: string, over: Measure[]) =>
      `Budget exceeded: ${spent(rootID, over.map((m) => m.spent))}, over the ${over.map((m) => m.cap).join(" and the ")}, ` +
      `so opencode-cap stopped it. Run ${over.map((m) => m.raise).join(" or ")} to raise this session's limit.`

    /** Appends the root session's total cost to the report file, whether or not a limit was hit. */
    const report = async (sessionID: string, status: string) => {
      if (options.report === undefined) return
      await ensure(sessionID)
      if (ledger.root(sessionID) !== sessionID) return
      const budget = budgets.get(sessionID)
      const record = {
        time: new Date().toISOString(),
        sessionID,
        status,
        cost: ledger.total(sessionID),
        tokens: ledger.totalTokens(sessionID),
        limit: budget?.limit ?? null,
        tokenLimit: budget?.tokenLimit ?? null,
        exceeded: budget?.exceeded ?? false,
        sessions: Object.fromEntries(ledger.tree(sessionID).map((id) => [id, ledger.cost(id)])),
      }
      await mkdir(dirname(options.report), { recursive: true })
      await appendFile(options.report, `${JSON.stringify(record)}\n`)
    }

    /** Checks a session tree's spend; `started` marks a new execution that must not run over budget. */
    const enforce = async (sessionID: string, started: boolean) => {
      await ensure(sessionID)
      const rootID = ledger.root(sessionID)
      const budget = budgets.get(rootID)
      if (!budget) return

      const measured = measures(rootID, budget).map((m) => ({ ...m, verdict: assess(m.used, m.limit, options.warn) }))
      const over = measured.filter((m) => m.verdict === "exceeded")
      if (over.length > 0) {
        const first = !budget.exceeded
        budget.exceeded = true
        // First interrupt every session: background subagents keep running when their parent stops.
        // After that, any session that still spends or starts is interrupted again, which also
        // retries an interrupt that failed. Interrupting an idle session is a no-op.
        await stop(first ? ledger.tree(rootID) : [sessionID])
        if (first || started) await note(rootID, exceededMessage(rootID, over))
        return
      }
      budget.exceeded = false
      const near = measured.filter((m) => m.verdict === "warn" && !budget.warned.has(m.kind))
      if (near.length > 0) {
        near.forEach((m) => budget.warned.add(m.kind))
        await note(
          rootID,
          `Budget warning: ${spent(rootID, near.map((m) => m.spent))} of its ${near.map((m) => m.cap).join(" and ")}. ` +
            `Wrap up soon; work stops when the limit is exceeded.`,
        )
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "budget",
        description:
          "Show this session's spend including subagents, or set its limit: /budget [amount] or /budget tokens <amount>",
        execute: async ({ sessionID, prompt }) => {
          await ensure(sessionID)
          const rootID = ledger.root(sessionID)
          const budget = budgets.get(rootID)
          if (!budget) return

          const text = prompt.text.trim()
          if (text !== "") {
            const kind: Kind = /^tokens\b/i.test(text) ? "tokens" : "cost"
            const amount = kind === "tokens" ? parseTokens(text.slice("tokens".length)) : parseAmount(text)
            if (amount === undefined) {
              await note(
                sessionID,
                `Usage: /budget [amount] or /budget tokens <amount>, e.g. /budget 10 for a $10.00 limit ` +
                  `or /budget tokens 500000 for a 500,000 token limit.`,
              )
              return
            }
            if (kind === "tokens") {
              await ctx.storage.set(tokenLimitKey(rootID), amount)
              budget.tokenLimit = amount
            } else {
              await ctx.storage.set(limitKey(rootID), amount)
              budget.limit = amount
            }
            // Re-evaluated at the next execution, which is stopped if still over any limit.
            budget.exceeded = false
            const changed = measures(rootID, budget).find((m) => m.kind === kind)!
            if (assess(changed.used, changed.limit, options.warn) === "ok") budget.warned.delete(kind)
            else budget.warned.add(kind)
          }

          const measured = measures(rootID, budget)
          const parts = measured.map((m) => `${m.spent} of its ${m.cap} (${Math.round((m.used / m.limit) * 100)}%)`)
          if (budget.limit === undefined) parts.unshift(formatUSD(ledger.total(rootID)))
          await note(sessionID, `Budget: ${spent(rootID, parts)}.${measured.length === 0 ? " No limit is set." : ""}`)
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
              budgets.set(sessionID, newBudget())
            }
            return
          }
          await ensure(parentID)
          await addChild(sessionID, parentID)
          return
        }
        case "session.usage.updated": {
          const { sessionID, cost, tokens } = event.data
          await ensure(sessionID)
          ledger.setUsage(sessionID, cost, countTokens(tokens))
          if (ledger.parent(sessionID) !== undefined) await saveTree(ledger.root(sessionID))
          await enforce(sessionID, false)
          return
        }
        case "session.execution.started":
          await enforce(event.data.sessionID, true)
          return
        case "session.execution.succeeded":
          await report(event.data.sessionID, "succeeded")
          return
        case "session.execution.failed":
          await report(event.data.sessionID, "failed")
          return
        case "session.execution.interrupted":
          await report(event.data.sessionID, "interrupted")
          return
        case "session.deleted": {
          const { sessionID } = event.data
          // A deleted subagent's spend still counts against its root.
          if (ledger.has(sessionID) && ledger.root(sessionID) !== sessionID) return
          // Roots are cleaned up even when never loaded since a restart.
          ledger.forget(sessionID)
          budgets.delete(sessionID)
          await Promise.all(
            [limitKey, tokenLimitKey, treeKey].map((key) => ctx.storage.remove(key(sessionID))),
          )
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
  const { parentID, cost, tokens } = value as Record<string, unknown>
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n)
  return typeof parentID === "string" && finite(cost) && (tokens === undefined || finite(tokens))
}
