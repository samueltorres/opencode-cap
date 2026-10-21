# opencode-cap

An [OpenCode V2](https://opencode.ai/v2/docs/build/plugins/) plugin that caps how much a session may spend. It adds up the
cost of a session and every subagent it spawns. Once the total goes over your limit, it stops all of them.

- **Tracks** each session's cost from OpenCode's own usage accounting, including model calls, title generation and
  compaction, and sums it across the whole subagent tree.
- **Warns** the session when spend reaches a configurable fraction of the limit, so the agent can wrap up.
- **Stops** the session and all of its subagents, including background ones, as soon as the limit is exceeded. Any later
  attempt to continue that session is stopped before it calls a model.
- **`/budget`** shows a session's spend, or raises its limit so the work can continue.

## Install

Add the plugin to `opencode.json(c)`, globally in `~/.config/opencode/` or per project:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-cap",
      "options": { "limit": 5 },
    },
  ],
}
```

For a local checkout, use its path as `package`, for example `"/path/to/opencode-cap"`.

## Options

| Option  | Default | Description                                                                                       |
| ------- | ------- | ------------------------------------------------------------------------------------------------- |
| `limit` | none    | Maximum spend in USD for a session and its subagents combined. Without it, spend is only tracked. |
| `warn`  | `0.8`   | Fraction of `limit` at which the session gets a warning, or `false` to disable warnings.          |
| `report` | none   | File that gets one JSON line with the session's total cost each time its execution ends.          |

Unknown or invalid options stop the plugin from loading, and the error names the problem.

## Cost report

Set `report` to a file path and the plugin appends one JSON line each time a root session's execution succeeds, fails or
is interrupted. It is written whether or not a limit is set or hit, so you always know what a run cost:

```json
{"time":"2026-10-21T10:00:00.000Z","sessionID":"ses_1","status":"succeeded","cost":0.75,"limit":10,"exceeded":false,"sessions":{"ses_1":0.5,"ses_2":0.25}}
```

`cost` is the total in USD across the session and its subagents; `sessions` breaks it down. Each execution adds a line
with the running total, so the last line for a session is its final cost.

## Headless runs

`opencode run` loads plugins like the TUI does. To choose a budget per run, read the option from an environment
variable with OpenCode's config substitution:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-cap",
      "options": { "limit": "{env:OPENCODE_CAP_LIMIT}" },
    },
  ],
}
```

```sh
OPENCODE_CAP_LIMIT=2 opencode run --standalone "Refactor the auth module"
```

- Pass `--standalone`. Without it, `opencode run` sends the prompt to the background service, which has its own
  environment, so your variable never reaches it.
- Leave the variable unset to run without a limit.
- When the budget stops the session, `opencode run` exits with a non-zero status.
- `/budget` is not available here because `opencode run` sends it as a plain prompt. Raise the variable instead.

## `/budget`

```text
/budget        Budget: this session and its 2 subagents spent $3.12 of its $5.00 limit (62%).
/budget 10     Sets this session's limit to $10.00 and shows its spend.
```

Running `/budget` in a subagent's session applies to its root session. A limit set with `/budget` is stored by the plugin
and survives restarts.

## How it works

The plugin subscribes to OpenCode's event stream. `session.created` gives the parent of each subagent session, and
`session.usage.updated` gives each session's running cost, so the plugin can total spend per root session. Over the
limit, it calls `session.interrupt` on every session in the tree. It then records the reason as a synthetic message,
which does not start another model turn.

Things to know:

- Cost comes from model pricing in OpenCode's catalog or your provider config. Models without pricing count as $0.
- The model call that crosses the limit has already been billed, and calls that are in flight when the limit is crossed
  are billed too. The final total can therefore end slightly above the limit.
- Subagents created before the plugin was installed are not counted.

## Development

```sh
bun install
bun test
bun run typecheck
```
