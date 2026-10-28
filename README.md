# @pipeworx/msha-mines

Search US mines by operator or mine name, or look up a known MSHA Mine ID
for its status, recent inspections, violations (with assessed penalties),
and quarterly employment/production — from MSHA (Mine Safety and Health
Administration) records.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1877+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `msha_mine_search(query, state?, status?, limit?)` — search by operator,
  controller, or mine name. Returns matching mines with their MSHA Mine ID,
  status (Active, Abandoned, Intermittent, etc.), mine type
  (Surface/Underground/Facility), coal vs. metal/non-metal classification,
  commodity, state, and current operator/controller. Use this to find a
  company's Mine ID(s) before calling `msha_mine_detail`.
- `msha_mine_detail(mine_id, violations_limit?, inspections_limit?)` — a
  known MSHA Mine ID's current status, type, commodity, operator and
  controller, plus recent inspections, recent violations (with assessed
  penalties, S&S flag, and abatement/termination dates), and recent
  quarterly employment and coal production summed across subunits. A Mine ID
  with no match returns `found: false` with `data_as_of` — not an error.
- `msha_violation_counts(mine_id?, mine_name?, year?, year_from?, year_to?)` —
  count a mine's violations within a calendar year or year range in ONE
  call, with a total plus a breakdown by who it was issued to (Operator,
  Contractor, Agent, Miner) and by significant-and-substantial (S&S) status.
  `msha_mine_detail`'s `violations` list is capped at `violations_limit`
  (max 100) and carries no true count — this is the tool for "how many
  violations did mine X get in year Y". Counted by the calendar year of each
  violation's own issue date (`VIOLATION_ISSUE_DT`, via MSHA's own `CAL_YR`
  field). Accepts a Mine ID directly, or a mine/operator/controller name
  that resolves to exactly one mine (ambiguous or no-match names come back
  as a named error listing the candidates). A year outside the loaded
  5-year window is flagged in `coverage` as not loaded, never answered as a
  silent zero.

## Auth

Keyless.

## Data sources

- <https://arlweb.msha.gov/OpenGovernmentData/OGIMSHA.asp> — MSHA's own
  Open Government Data portal, listing downloadable pipe-delimited files
  refreshed roughly weekly. Four are loaded: `Mines.zip` (the master list of
  every mine ever assigned a Mine ID — status, type, commodity, current
  operator/controller), `Violations.zip` (citations/orders with assessed
  penalties), `Inspections.zip` (inspection events), and
  `MinesProdQuarterly.zip` (quarterly employment and coal production by
  subunit). US federal data, public domain. `ControllerOperatorHistory.zip`
  ships at the same URL but is out of scope for this pack's first
  capability — `Mines.zip` already carries each mine's *current*
  operator/controller, which covers search and detail.

## Why this is a local-copy pack, not a live proxy

MSHA's Mine Data Retrieval System (`msha.gov/mdrs`) is a MicroStrategy BI
application embedded in an iframe tag (confirmed 2026-10-08: the page's
`src` is `microstrategy.msha.gov/MicroStrategy/asp/Main.aspx`) — not a JSON
endpoint a Worker can call per request. The only queryable path is the bulk
pipe-delimited files. This pack reads a Supabase mirror (`msha_mines`,
`msha_violations`, `msha_inspections`, `msha_employment_production`; schema
in `supabase/migrations/237_msha_mines.sql`) loaded weekly by
`scripts/ingest-msha-mines.mjs`
(`.github/workflows/msha-mines-refresh.yml`). Every successful response
carries `data_as_of` from the backing table's own `loaded_at`.

**Fetched directly from MSHA, not routed through the gateway.** Unlike
`registry.faa.gov` (Akamai-fronted, blocks on header shape — see
`mcps/faa-aircraft-registry`'s README), `arlweb.msha.gov` answered a plain
`fetch()` from a throwaway `wrangler dev --remote` Worker on the prod
Cloudflare account the same clean HTTP 200 it gives a laptop `curl` —
verified 2026-10-08 against `Mines_Definition_File.txt` (byte-identical,
10,285 bytes) and the full 120,770,798-byte `Violations.zip`. No blocking to
work around, so the ingest script calls MSHA directly from wherever it runs.

## Bounded on purpose

`Violations.zip` unzips to 1.44 GB (~3.1M rows back to 2000); `Inspections.zip`
to 348 MB (~1.16M rows); `MinesProdQuarterly.zip` to 262 MB (~2.76M rows).
Loading the full history of any of them is not worth it for a lookup tool
whose job is "is this mine okay lately" — the ingest script keeps only the
most recent 5 calendar years of each (recomputed from the current date every
run, so the window slides forward on its own). `msha_mines` (the ~92k-row
master list) is loaded in full — it is the smallest file and the one every
other table joins against. Every response that touches the bounded tables
carries a `bound` field saying so, so a short violations/inspections list
never reads as "this mine has no older history" — it has history, it just
isn't loaded.

The DB load is `TRUNCATE` + `psql \copy` per table, all four in one
transaction, using the pooled connection string the ingest script reads from
its environment — a full weekly snapshot, not an incremental upsert. A parse
failure on any of the four files rolls the whole transaction back, so last
week's data stays live rather than a table going half-replaced.

## Natural keys are not unique

`VIOLATION_NO` has 51 duplicate values and `EVENT_NO` has at least 1, across
MSHA's full un-bounded files (verified 2026-10-08 with `sort | uniq -d` over
the extracted `.txt` files) — so `msha_violations` and `msha_inspections`
use a surrogate `bigserial` id, not the natural key, as primary key.
`msha_mines.mine_id` *is* a real primary key — MSHA's own definition file
calls it the unique join key across every other table.

## Empty-registry guard

If the weekly refresh has never completed a successful run, the backing
tables are empty but a query against them still succeeds — so a naive read
would answer a confident `found: false` for every mine, indistinguishable
from a genuine miss against good data. Both tools check for at least one
loaded row before answering and throw a loud `dataset_unavailable`-class
error naming that condition instead (same pattern as
`mcps/faa-aircraft-registry`, fleet #2790).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "msha-mines": {
      "url": "https://gateway.pipeworx.io/msha-mines/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/msha-mines/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1877+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/msha_mine_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Peabody"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/msha_mine_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "msha-mines": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-msha-mines"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-msha-mines
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Msha Mines data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
