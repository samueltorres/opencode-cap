import { expect, test } from "bun:test"
import { parseAmount, parseOptions } from "../src/options"

test("defaults to tracking only, warning at 80%", () => {
  expect(parseOptions({})).toEqual({ limit: undefined, warn: 0.8 })
})

test("accepts a limit and warning fraction", () => {
  expect(parseOptions({ limit: 5, warn: 0.5 })).toEqual({ limit: 5, warn: 0.5 })
  expect(parseOptions({ limit: 5, warn: false })).toEqual({ limit: 5, warn: false })
})

test("accepts values substituted from environment variables", () => {
  expect(parseOptions({ limit: "5", warn: "0.5" })).toEqual({ limit: 5, warn: 0.5 })
  expect(parseOptions({ limit: " 2.5 ", warn: "false" })).toEqual({ limit: 2.5, warn: false })
  expect(parseOptions({ limit: "", warn: "" })).toEqual({ limit: undefined, warn: 0.8 })
})

test("rejects invalid options", () => {
  expect(() => parseOptions({ limit: 0 })).toThrow(/limit/)
  expect(() => parseOptions({ limit: "five" })).toThrow(/limit/)
  expect(() => parseOptions({ limit: "-1" })).toThrow(/limit/)
  expect(() => parseOptions({ warn: 1 })).toThrow(/warn/)
  expect(() => parseOptions({ warn: true })).toThrow(/warn/)
  expect(() => parseOptions({ limt: 5 })).toThrow(/limt/)
})

test("parses /budget amounts", () => {
  expect(parseAmount("10")).toBe(10)
  expect(parseAmount(" $2.50 ")).toBe(2.5)
  expect(parseAmount("")).toBeUndefined()
  expect(parseAmount("ten")).toBeUndefined()
  expect(parseAmount("-1")).toBeUndefined()
})
