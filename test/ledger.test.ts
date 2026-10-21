import { describe, expect, test } from "bun:test"
import { assess, countTokens, formatTokens, formatUSD, Ledger } from "../src/ledger"

describe("Ledger", () => {
  const build = () => {
    const ledger = new Ledger()
    ledger.track("root", undefined, 1)
    ledger.track("a", "root", 2)
    ledger.track("b", "root", 3)
    ledger.track("a1", "a", 4)
    return ledger
  }

  test("sums spend across the whole session tree", () => {
    const ledger = build()
    expect(ledger.total("root")).toBe(10)
    expect(ledger.total("a")).toBe(6)
  })

  test("resolves any session to its root", () => {
    const ledger = build()
    expect(ledger.root("a1")).toBe("root")
    expect(ledger.root("root")).toBe("root")
  })

  test("lists the tree parents first", () => {
    expect(build().tree("root")).toEqual(["root", "a", "a1", "b"])
  })

  test("replaces a session's usage with the latest cumulative figures", () => {
    const ledger = build()
    ledger.setUsage("a1", 10, 500)
    ledger.setUsage("b", 3, 200)
    expect(ledger.total("root")).toBe(16)
    expect(ledger.totalTokens("root")).toBe(700)
    expect(ledger.totalTokens("a")).toBe(500)
  })

  test("does not re-track a known session", () => {
    const ledger = build()
    ledger.track("a", "b", 100)
    expect(ledger.parent("a")).toBe("root")
    expect(ledger.total("root")).toBe(10)
  })

  test("rejects children of unknown parents", () => {
    expect(() => new Ledger().track("child", "missing")).toThrow()
  })

  test("forgets a subtree", () => {
    const ledger = build()
    ledger.forget("a")
    expect(ledger.has("a1")).toBe(false)
    expect(ledger.tree("root")).toEqual(["root", "b"])
  })
})

describe("assess", () => {
  test("allows spend up to and including the limit", () => {
    expect(assess(5, 5, false)).toBe("ok")
    expect(assess(5.01, 5, false)).toBe("exceeded")
  })

  test("warns from the warning fraction", () => {
    expect(assess(3.99, 5, 0.8)).toBe("ok")
    expect(assess(4, 5, 0.8)).toBe("warn")
    expect(assess(6, 5, 0.8)).toBe("exceeded")
  })
})

test("counts every kind of token, as OpenCode does", () => {
  expect(countTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toBe(15)
})

test("formatTokens groups thousands", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(1234567)).toBe("1,234,567")
})

test("formatUSD shows cents, or more precision for tiny amounts", () => {
  expect(formatUSD(0)).toBe("$0.00")
  expect(formatUSD(1.5)).toBe("$1.50")
  expect(formatUSD(0.0042)).toBe("$0.0042")
})
