import type { PluginOptions } from "@opencode/plugin"

export interface Options {
  /** Maximum spend in USD for a session including its subagents. Without it, spend is only tracked. */
  readonly limit?: number
  /** Fraction of the limit at which the session is warned, or `false` to disable warnings. */
  readonly warn: number | false
  /** File that receives one JSON line with the session's total cost each time its execution ends. */
  readonly report?: string
}

const KEYS = new Set(["limit", "warn", "report"])

export function parseOptions(input: PluginOptions): Options {
  const unknown = Object.keys(input).filter((key) => !KEYS.has(key))
  if (unknown.length > 0) throw new Error(`opencode-cap: unknown option(s): ${unknown.join(", ")}`)

  // Values substituted with "{env:VAR}" arrive as strings; an unset variable substitutes "".
  const limit = fromEnv(input.limit)
  const warn = fromEnv(input.warn) ?? 0.8
  if (limit !== undefined && !isPositive(limit))
    throw new Error(`opencode-cap: "limit" must be a positive number of USD, got ${JSON.stringify(limit)}`)
  if (warn !== false && !(isPositive(warn) && warn < 1))
    throw new Error(`opencode-cap: "warn" must be a fraction between 0 and 1, or false, got ${JSON.stringify(warn)}`)

  const report = typeof input.report === "string" && input.report.trim() !== "" ? input.report.trim() : undefined
  if (input.report !== undefined && typeof input.report !== "string")
    throw new Error(`opencode-cap: "report" must be a file path, got ${JSON.stringify(input.report)}`)

  return { limit, warn, report }
}

export function parseAmount(text: string): number | undefined {
  const amount = Number(text.trim().replace(/^\$/, ""))
  return text.trim() !== "" && isPositive(amount) ? amount : undefined
}

function fromEnv(value: unknown): unknown {
  if (typeof value !== "string") return value
  const text = value.trim()
  if (text === "") return undefined
  if (text === "false") return false
  return Number.isNaN(Number(text)) ? value : Number(text)
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}
