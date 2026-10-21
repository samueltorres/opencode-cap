import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../index"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Command = { name: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }

/** A fake OpenCode host: an event stream, a session store, and plugin storage. */
function host(sessions: Record<string, { parentID?: string; cost: number }> = {}, storage = new Map<string, unknown>()) {
  const queue: { event: unknown; done: () => void }[] = []
  let wake: (() => void) | undefined
  const interrupted: string[] = []
  // Sessions whose interrupt fails, e.g. a transient host error.
  const failing = new Set<string>()
  let subscriptions = 0
  let disconnecting = false
  const notes: { sessionID: string; text: string; resume?: boolean }[] = []
  const commands: Command[] = []

  const context = {
    options: {},
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        subscriptions++
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          if (disconnecting) {
            disconnecting = false
            return
          }
          const next = queue.shift()
          if (!next) continue
          yield next.event
          // Resumes once the plugin asks for the next event, i.e. finished handling this one.
          next.done()
        }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions[sessionID]
        if (!session) throw new Error(`Session not found: ${sessionID}`)
        return { id: sessionID, ...session }
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        if (failing.has(sessionID)) throw new Error(`Interrupt failed: ${sessionID}`)
        interrupted.push(sessionID)
        return true
      },
      synthetic: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        notes.push(input)
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
    },
    command: {
      transform: async (callback: (editor: { add: (command: Command) => void }) => void) => {
        callback({ add: (command) => commands.push(command) })
        return { dispose: async () => {} }
      },
    },
  }

  const emit = (type: string, data: Record<string, unknown>) =>
    new Promise<void>((done) => {
      queue.push({ event: { id: "evt_test", type, created: Date.now(), data }, done })
      wake?.()
    })

  return {
    sessions,
    storage,
    interrupted,
    failing,
    notes,
    emit,
    /** Ends the current event subscription and resolves once the plugin has subscribed again. */
    async reconnect() {
      const before = subscriptions
      disconnecting = true
      wake?.()
      while (subscriptions === before) await Bun.sleep(25)
    },
    created: (sessionID: string, parentID?: string) => {
      sessions[sessionID] = { parentID, cost: 0 }
      return emit("session.created", { sessionID, parentID })
    },
    usage: (sessionID: string, cost: number) => {
      sessions[sessionID]!.cost = cost
      return emit("session.usage.updated", { sessionID, cost })
    },
    started: (sessionID: string) => emit("session.execution.started", { sessionID }),
    budget: (sessionID: string, text = "") => {
      const command = commands.find((command) => command.name === "budget")!
      return command.execute({ sessionID, prompt: { text } })
    },
    async load(options: Record<string, unknown>) {
      const cleanup = await plugin.setup({ ...context, options } as unknown as Context)
      if (cleanup) cleanups.push(cleanup)
    },
  }
}

const cleanups: (() => unknown)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe("opencode-cap", () => {
  test("stops the whole session tree once combined spend exceeds the limit", async () => {
    const oc = host()
    await oc.load({ limit: 1 })
    await oc.created("root")
    await oc.created("sub1", "root")
    await oc.created("sub2", "root")

    await oc.usage("root", 0.3)
    await oc.usage("sub1", 0.3)
    expect(oc.interrupted).toEqual([])

    await oc.usage("sub2", 0.5)
    expect(oc.interrupted.sort()).toEqual(["root", "sub1", "sub2"])
    expect(oc.notes.at(-1)).toMatchObject({ sessionID: "root", resume: false })
    expect(oc.notes.at(-1)!.text).toContain("Budget exceeded")
    expect(oc.notes.at(-1)!.text).toContain("$1.10")
  })

  test("warns once when spend crosses the warning threshold", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: 0.5 })
    await oc.created("root")
    await oc.usage("root", 0.6)
    await oc.usage("root", 0.7)

    expect(oc.notes).toHaveLength(1)
    expect(oc.notes[0]).toMatchObject({ sessionID: "root", resume: false })
    expect(oc.notes[0]!.text).toContain("Budget warning")
    expect(oc.interrupted).toEqual([])
  })

  test("stops work that starts after the limit was exceeded", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: false })
    await oc.created("root")
    await oc.usage("root", 2)
    oc.interrupted.length = 0

    // Spend recorded after the stop, e.g. a billed in-flight step, stops the session again.
    await oc.usage("root", 2.1)
    expect(oc.interrupted).toEqual(["root"])
    oc.interrupted.length = 0

    await oc.started("root")
    expect(oc.interrupted).toEqual(["root"])

    await oc.created("late", "root")
    await oc.started("late")
    expect(oc.interrupted).toEqual(["root", "late"])
  })

  test("/budget raises a session's limit so work can continue", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: false })
    await oc.created("root")
    await oc.created("sub", "root")
    await oc.usage("sub", 1.5)
    oc.interrupted.length = 0

    await oc.budget("sub", "$5")
    expect(oc.storage.get("limit/root")).toBe(5)
    expect(oc.notes.at(-1)!.text).toBe("Budget: this session and its 1 subagent spent $1.50 of its $5.00 limit (30%).")

    await oc.started("root")
    expect(oc.interrupted).toEqual([])

    await oc.budget("root", "1")
    await oc.started("root")
    expect(oc.interrupted.sort()).toEqual(["root", "sub"])
  })

  test("/budget rejects invalid amounts", async () => {
    const oc = host()
    await oc.load({})
    await oc.created("root")
    await oc.budget("root", "lots")
    expect(oc.notes.at(-1)!.text).toStartWith("Usage: /budget")
  })

  test("only tracks spend when no limit is configured", async () => {
    const oc = host()
    await oc.load({})
    await oc.created("root")
    await oc.usage("root", 1000)
    expect(oc.interrupted).toEqual([])

    await oc.budget("root")
    expect(oc.notes.at(-1)!.text).toBe("Budget: this session spent $1000.00. No limit is set.")
  })

  test("restores session trees and limits after a restart", async () => {
    const before = host()
    await before.load({ limit: 1 })
    await before.created("root")
    await before.created("sub", "root")
    await before.created("nested", "sub")
    await before.budget("root", "3")
    expect(before.storage.get("tree/root")).toEqual({
      sub: { parentID: "root", cost: 0 },
      nested: { parentID: "sub", cost: 0 },
    })

    const sessions = { root: { cost: 1 }, sub: { parentID: "root", cost: 1 }, nested: { parentID: "sub", cost: 0.5 } }
    const after = host(sessions, before.storage)
    await after.load({ limit: 1 })
    await after.usage("nested", 0.9)
    expect(after.interrupted).toEqual([])

    await after.usage("root", 1.5)
    expect(after.interrupted.sort()).toEqual(["nested", "root", "sub"])
  })

  test("loads sessions created before the plugin", async () => {
    const oc = host({ root: { cost: 0.4 }, sub: { parentID: "root", cost: 0.4 } })
    await oc.load({ limit: 1, warn: false })
    await oc.usage("sub", 0.7)
    expect(oc.interrupted.sort()).toEqual(["root", "sub"])
    expect(oc.storage.get("tree/root")).toEqual({ sub: { parentID: "root", cost: 0.7 } })
  })

  test("forgets a root session and its stored state when it is deleted", async () => {
    const oc = host()
    await oc.load({ limit: 1 })
    await oc.created("root")
    await oc.created("sub", "root")
    await oc.budget("root", "2")
    await oc.emit("session.deleted", { sessionID: "root" })
    expect([...oc.storage.keys()]).toEqual([])
  })

  test("keeps a deleted subagent's spend after a restart", async () => {
    const before = host()
    await before.load({ limit: 1, warn: false })
    await before.created("root")
    await before.created("sub", "root")
    await before.usage("sub", 0.8)
    await before.emit("session.deleted", { sessionID: "sub" })

    const after = host({ root: { cost: 0 } }, before.storage)
    await after.load({ limit: 1, warn: false })
    await after.usage("root", 0.3)
    expect(after.interrupted.sort()).toEqual(["root", "sub"])
  })

  test("restores subagents regardless of stored order", async () => {
    const storage = new Map<string, unknown>([
      ["tree/root", { nested: { parentID: "sub", cost: 0.5 }, sub: { parentID: "root", cost: 0.4 } }],
    ])
    const oc = host({ root: { cost: 0 } }, storage)
    await oc.load({ limit: 1, warn: false })
    await oc.usage("root", 0.2)
    expect(oc.interrupted.sort()).toEqual(["nested", "root", "sub"])
  })

  test("never shows a partially restored tree", async () => {
    const storage = new Map<string, unknown>([["tree/root", { sub: { parentID: "root", cost: 0.6 } }]])
    const oc = host({ root: { cost: 0.2 } }, storage)
    await oc.load({})
    await Promise.all([oc.started("root"), oc.budget("root")])
    expect(oc.notes.at(-1)!.text).toBe("Budget: this session and its 1 subagent spent $0.80. No limit is set.")
  })

  test("interrupts again a session that keeps spending after a failed stop", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: false })
    await oc.created("root")
    await oc.created("sub", "root")
    oc.failing.add("sub")
    await oc.usage("sub", 1.5)
    expect(oc.interrupted).toEqual(["root"])

    oc.failing.clear()
    await oc.usage("sub", 1.7)
    expect(oc.interrupted).toEqual(["root", "sub"])
    expect(oc.notes.filter((note) => note.text.startsWith("Budget exceeded"))).toHaveLength(1)
  })

  test("resubscribes when the event stream ends", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: false })
    await oc.created("root")
    await oc.reconnect()
    await oc.usage("root", 2)
    expect(oc.interrupted).toEqual(["root"])
  })

  test("clears stored state of a deleted root that was never loaded", async () => {
    const storage = new Map<string, unknown>([
      ["limit/root", 5],
      ["tree/root", { sub: { parentID: "root", cost: 1 } }],
    ])
    const oc = host({}, storage)
    await oc.load({})
    await oc.emit("session.deleted", { sessionID: "root" })
    expect([...storage.keys()]).toEqual([])
  })

  test("keeps handling events after a failure", async () => {
    const oc = host()
    await oc.load({ limit: 1, warn: false })
    const error = console.error
    console.error = () => {}
    try {
      await oc.emit("session.usage.updated", { sessionID: "unknown", cost: 5 })
    } finally {
      console.error = error
    }
    await oc.created("root")
    await oc.usage("root", 2)
    expect(oc.interrupted).toEqual(["root"])
  })
})
