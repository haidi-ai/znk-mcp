# znk-mcp

A **zero-dependency Node.js MCP server** (stdio, JSON-RPC 2.0) that exposes
ZNKernel-II geometry through 10 tools. Any MCP client that can spawn a stdio
server can use it — including DeepSeek-based clients.

> **This is a tool layer, not a DeepSeek official plugin.**
> It is also **not** a DSH/Cordis plugin, **not** an official Anthropic MCP
> server, and (as of 2026-11-24) **not yet published** as an npm package. It is
> a single `server.cjs` that speaks the Model Context Protocol over
> stdin/stdout and shells out to the official `znk2_cli` executable. No license
> key is embedded; the license is read only from the environment.

- Runtime: Node.js >= 18 (validated with Node v24.19.0)
- Backend: ZNKernel-II 2.28.1 `znk2_cli`
- Dependencies: **none** (Node built-ins only: `child_process`, `fs`, `os`,
  `path`, `readline`, `crypto`)
- Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout
- Tools: **10** (`znk_create`, `znk_boolean`, `znk_describe`, `znk_import`,
  `znk_export`, `znk_adjudicate`, `znk_adjudicate_rules`, `znk_topology`,
  `znk_capabilities`, `znk_sketch_solve`)
- Local self-test: `SELFTEST PASS 28/28` on the validation machine
- Distribution: source + `znk-mcp.zip` + SHA256; npm package **prepared
  (v0.1.0) but not published** — see §13

---

## Quickstart (English)

The package is **publish-ready but not published yet** (2026-11-24). Anything
marked *after publication* below fails with `E404` until the owner publishes
it, so use the source checkout for now.

### A. Source checkout (works today)

```bash
git clone <this-repository-url> znk-mcp
cd znk-mcp
node --version            # must be >= 18
node test/selftest.cjs    # set ZNK2_CLI / ZNK2_LICENSE_FILE first
```

### B. After publication (not available yet)

```bash
# works only AFTER the package is published to npm
npx -y znk-mcp
```

MCP client entry — identical for both routes; replace `npx` with `node` and
the argument with the absolute path to `server.cjs` when running from a clone:

```json
{
  "mcpServers": {
    "znk": {
      "command": "npx",
      "args": ["-y", "znk-mcp"],
      "env": {
        "ZNK2_CLI": "C:\\path\\to\\znk2_cli.exe",
        "ZNK2_LICENSE_FILE": "C:\\path\\to\\znk2.lic"
      }
    }
  }
}
```

---

## 1. Install

```bash
git clone <this-repository-url> znk-mcp
cd znk-mcp
node --version          # >= 18
node test/selftest.cjs  # after the environment variables below are set
```

There is **no `npm install` step**. `package.json` exists for metadata and
scripts only; it declares no dependencies. After publication,
`npx -y znk-mcp` starts the same server without a clone; before publication
the clone above is the only install path.

You also need a ZNKernel-II distribution containing `znk2_cli` (Windows:
`znk2_cli.exe`) and a valid customer license. The ZNKernel-II kernel is
proprietary and is **not** bundled here.

---

## 2. Environment variables

The server never embeds, copies, prints or commits a license. It passes the
environment it inherited to each `znk2_cli` subprocess.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ZNK2_CLI` | yes (unless `znk2_cli` is on `PATH`) | Absolute path to `znk2_cli.exe` / `znk2_cli`. |
| `ZNK2_LICENSE_FILE` | yes for kernel operations | Absolute path to the customer `.lic` file. Missing -> CLI error `1004`. |
| `ZNK2_REVOKE_LIST` | recommended / policy-dependent | Absolute path to the signed revocation list. Missing while revocation checking is required fails closed. |
| `ZNK2_TIMEOUT_MS` | no | Per-tool timeout in ms, clamped to `1..60000`; default `60000`. |
| `ZNK2_EXPORT_DIR` | no | Default output directory when `znk_export` has no `path`. Default: `<server cwd>/znk_exports`. |
| `ZNK2_ALLOWED_ROOTS` | no | Path-delimiter-separated allow-list for import/export paths. Unset = no path restriction. |

Do **not** put license contents in the repository, README, chat, logs or MCP
configuration checked into git. Point `ZNK2_LICENSE_FILE` at a file outside the
repository and keep that file's ACL restricted.

Example (PowerShell):

```powershell
$env:ZNK2_CLI          = 'C:\path\to\znk2_cli.exe'
$env:ZNK2_LICENSE_FILE = 'C:\path\to\znk2.lic'
$env:ZNK2_REVOKE_LIST  = 'C:\path\to\REVOKE-1.txt'
node test/selftest.cjs
```

`znk_capabilities` is the one tool that still answers without a license (its
`license.status` will be `missing`). Every geometry/adjudication/sketch call
returns the CLI's `1004` when no license is configured.

---

## 3. MCP client configuration

Generic stdio configuration (Claude Desktop, Cursor, DSH MCP settings, custom
clients, etc.):

```json
{
  "mcpServers": {
    "znk": {
      "command": "node",
      "args": ["C:\\path\\to\\znk-mcp\\server.cjs"],
      "env": {
        "ZNK2_CLI": "C:\\path\\to\\znk2_cli.exe",
        "ZNK2_LICENSE_FILE": "C:\\path\\to\\znk2.lic",
        "ZNK2_REVOKE_LIST": "C:\\path\\to\\REVOKE-1.txt"
      }
    }
  }
}
```

Minimal shape (when the client starts the server from the repository root):
`{"command":"node","args":["server.cjs"]}`. Absolute paths are safer because
many clients do not set the server's cwd.

Notes:

- `command: node` works when `node` is on the client's `PATH`; otherwise use
  the absolute `node.exe` path.
- On Linux/macOS use the corresponding `znk2_cli` path and forward slashes.
- Relative import/export paths resolve against the **server process cwd**;
  prefer absolute paths in tool arguments.
- The client must use the MCP **stdio** transport. This server does not open a
  TCP port and does not use HTTP.
- DSH: add it in the MCP server settings. It is not a Cordis plugin and has no
  `cordis.patch.yml`.
- DeepSeek: this is not an official DeepSeek plugin; it is a standard MCP
  server that a DeepSeek-based MCP client can launch.

---

## 4. MCP protocol surface

Supported methods:

| Method | Result |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities.tools.listChanged=false`, `serverInfo`, `instructions` |
| `notifications/initialized` | notification; no response |
| `ping` | `{}` |
| `tools/list` | `{ "tools": [ {name, description, inputSchema}, ... ] }` with exactly 10 tools |
| `tools/call` | `{ content: [{type:"text", text}], structuredContent, isError }` |

Everything else returns JSON-RPC `-32601` (`Method not found`). Unknown tool
names return `-32602` (`Invalid params`). Malformed JSON returns `-32700`.

Protocol-version negotiation: if the client requests one of `2025-11-25`,
`2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`, that version is echoed;
otherwise the server answers with its latest supported version,
`2025-11-25` (the client must disconnect if it cannot support it).

Tool result shape (MCP `CallToolResult`):

- `content[]`: one `text` block containing the pretty-printed JSON envelope.
  Present because the tools do not declare an `outputSchema`.
- `structuredContent`: the same JSON envelope as an object, for clients that
  use structured tool output.
- `isError`: `true` when the envelope has `ok:false` (CLI or server error),
  `false` for successful calls — including adjudication rows whose verdict is
  `cannot_judge` (that is an undecided verdict, not a transport error).

There are no resources, prompts, sampling, logging, progress or pagination
features. `tools/list` does not return a `nextCursor`.

---

## 5. Tools

| Tool | What it does | Main arguments |
| --- | --- | --- |
| `znk_create` | Create a box / cylinder / sphere / cone / torus; returns measurements, tessellation and a replayable recipe. | `primitive`, `params`, `tessellate?` |
| `znk_boolean` | `union`, `subtract` (a-b), `intersect` on two recipes; returns measurements and a new recipe. | `operation`, `a`, `b`, `tessellate?` |
| `znk_describe` | Volume, area, bbox, centroid, topology counts, Euler characteristic, `volume_source`, watertight flag. | `solid`, `tessellate?` |
| `znk_import` | STEP / IGES / DXF / DWG / STL / OBJ / ZNK import (content-probed); returns a chainable `{kind:"import",file}` recipe. | `path` or `text`, `format?`, `with_mass?` |
| `znk_export` | STL / OBJ / STEP export, with schema and unit options, round-trip stats, absolute output path. | `solid` or `file`, `format`, `path?`, `binary?`, `chord_tol?`, `angle_tol?`, `schema?`, `length_unit?` |
| `znk_adjudicate` | Run all 10 manufacturing/quality rules (or one); returns raw `allow`/`reject`/`cannot_judge` rows. | `solid` or `file`, `rule?`, `params?`, `tolerance?`, `otherBodies?`, `otherFiles?` |
| `znk_adjudicate_rules` | List the 10 built-in rules and the three verdicts. | none |
| `znk_topology` | Body-level B-rep counts and validity. Entity-level queries return explicit `1003`. | `solid`, `entity?`, `entity_id?` |
| `znk_capabilities` | Kernel/CLI version, ABI symbols, implemented/unsupported families, formats, license/protection status, limits. | none |
| `znk_sketch_solve` | 2D sketch constraint solve (single constraint or `solve_system`). | `request`, `batch?` |

Full descriptions and JSON schemas come from `tools/list`; they are derived
from the ZNKernel-II 2.28.1 CLI contract.

### Recipes and chaining

Every geometry-producing tool returns a `recipe` that can be passed back:

```json
{"kind":"primitive","primitive":"box","params":{"lo":[0,0,0],"hi":[10,20,30]}}
{"kind":"boolean","op":"subtract","a":{"kind":"primitive",...},"b":{"kind":"primitive",...}}
{"kind":"import","file":"E:/path/to/part.step","format":"step"}
```

A **whole previous tool result** is accepted too: the CLI unwraps
`recipe` / `result.recipe`, so `znk_describe({solid: <create response>})`
works. `znk_import` adds the `{kind:"import",file}` recipe itself; the CLI
returns measurements but no recipe.

### Adjudication is three-valued

`znk_adjudicate` forwards the kernel's verdicts verbatim:

- `allow` — the rule passed.
- `reject` — the rule failed.
- `cannot_judge` — **undecided**. It is never mapped to `allow`, never counted
  as a pass, and `policy.cannot_judge` explicitly says
  `"undecided - NOT an allow; never treat as a pass"`.

The server does not add an `allowed:true` field, does not filter rows and does
not turn `cannot_judge` into an error. Callers must decide what to do with an
undecided verdict.

---

## 6. Error codes

CLI/kernel codes are passed through **unchanged** in
`structuredContent.error.code`; the server does not swallow, remap or
stringify them.

| Code | Name | Typical cause |
| --- | --- | --- |
| `1001` | `InvalidArgument` | bad/missing field, unknown rule id, empty boolean result |
| `1002` | `OutOfRange` | value outside the accepted range |
| `1003` | `NotSupported` | unsupported op/primitive/format; CLI-only topology entity query |
| `1004` | `EmptyInput` | missing license file / empty input |
| `1005` | `SchemaMismatch` | persisted payload/schema version mismatch |
| `2001` | `Degenerate` | degenerate geometry; some parse failures |
| `2002` | `Singular` | singular input |
| `2003` | `NoIntersection` | bodies do not intersect |
| `2004` | `Coincident` | coplanar/coincident contact; unsupported boolean configuration |
| `2005` | `NotOnGeometry` | entity/point not on the geometry |
| `2006` | `TopologyInvalid` | validation failure |
| `2007` | `NotClosed` | open shell / no solid handle |
| `2008` | `SelfIntersecting` | self-intersection / stale handle |
| `2009` | `BooleanFailed` | boolean could not be completed |
| `2010` | `FilletFailed` | fillet failure |
| `2011` | `ShellFailed` | shell/thickness failure |
| `2012` | `TessellationFailed` | tessellation failure |
| `2013` | `ConstraintUnsolved` | sketch solver did not converge |
| `2014` | `ConstraintOverConstrained` | over-constrained sketch |
| `2015` | `ConstraintUnderConstrained` | under-constrained sketch |
| `2016` | tolerance exceeded | tolerance inflation guard (CLI extension) |
| `2018` | I/O | import file not found / unreadable (CLI extension) |
| `3001` | `BadHandle` | invalid body handle |
| `3002` | `RebuildFailed` | parametric rebuild failed |
| `3003` | `UndoStackEmpty` | nothing to undo |
| `3004` | `RedoStackEmpty` | nothing to redo |
| `4001` | `ParseError` | malformed file/license/revocation data |
| `4002` | `UnsupportedFormat` | format not supported |
| `4003` | `IoError` | read/write failure |
| `4004` | `VersionMismatch` | unsupported file/schema version |
| `9001` | `NumericFailure` | numeric failure |
| `9002` | `NotImplemented` | feature not implemented (e.g. sketch batch mode) |
| `9999` | `InternalError` | internal error |

Server-side synthetic codes (only when the CLI did not produce an envelope):

| Code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | the MCP server rejected the tool arguments before calling the CLI |
| `PATH_NOT_ALLOWED` | path is outside `ZNK2_ALLOWED_ROOTS` |
| `TIMEOUT` | `znk2_cli` exceeded `ZNK2_TIMEOUT_MS` (<= 60 s) and was killed |
| `CLI_NOT_FOUND` | `ZNK2_CLI` cannot be spawned |
| `CLI_NO_OUTPUT` | CLI exited without stdout |
| `CLI_BAD_JSON` | CLI stdout was not JSON |
| `CLI_STDIN_ERROR` | request could not be written to the CLI |
| `OUTPUT_TOO_LARGE` | CLI output exceeded 8 MiB |
| `INTERNAL_ERROR` | unexpected server exception |

JSON-RPC layer: `-32700` parse error, `-32600` invalid request, `-32601`
method not found, `-32602` invalid params, `-32603` internal error.

### Timeouts

Each tool call is capped at **60 seconds** (`ZNK2_TIMEOUT_MS`, clamped
`1..60000`). On expiry the child process is killed and the tool returns
`isError:true` with `code:"TIMEOUT"` and `timeout_ms`. Long curved booleans or
large imports may legitimately hit this cap.

---

## 7. Examples

`examples/01-create-describe.jsonl` contains three JSON-RPC calls:
create -> describe -> adjudicate. From the repository root:

```bash
node server.cjs < examples/01-create-describe.jsonl
```

`examples/02-step-import.jsonl` imports `examples/sample.step`, describes the
imported recipe and exports a STEP copy. Run it from the repository root (the
paths are relative) or replace the paths with absolute ones:

```bash
node server.cjs < examples/02-step-import.jsonl
```

These JSONL files omit `initialize` for brevity; a real MCP client always
sends `initialize` first. You can still pipe them directly because the server
does not enforce initialization ordering.

---

## 8. Tests

```bash
node test/selftest.cjs
```

The self-test spawns the server over stdio and asserts 28 conditions:
initialize/tools list/ping; exactly 10 tools and their names; create volume > 0; boolean subtract reduces that volume;
describe; 10-rule adjudication with all verdicts in the three-value set and
`cannot_judge` preserved; rule list; body-level topology; explicit `1003` for
the unsupported entity-level topology query; capabilities; sketch solve; STL
export + import recipe; CLI `1003` passthrough for an invalid primitive;
`-32601` for an unknown method; `-32602` for an unknown tool.

Expected output on a configured machine:

```text
SELFTEST PASS 28/28
```

Optional transcript:

```powershell
$env:ZNK_MCP_SELFTEST_LOG = 'D:\ai-crew-data\t0750\selftest-transcript.jsonl'
node test/selftest.cjs
```

Negative-path behaviour (also verified during release validation):
`ZNK2_TIMEOUT_MS=1` -> `TIMEOUT`; no `ZNK2_LICENSE_FILE` -> CLI `1004`;
bad `ZNK2_CLI` -> `CLI_NOT_FOUND`.

---

## 9. Security and operational limits

- **No embedded license / key.** License and revocation paths come only from
  the environment. The server logs only whether they are configured, never
  their values.
- **No network access.** The server never opens a socket; it only spawns the
  configured CLI.
- **Path allow-list.** Set `ZNK2_ALLOWED_ROOTS` (path-delimiter separated) to
  confine import/export paths. Direct paths and nested recipe `file` fields are
  checked; `PATH_NOT_ALLOWED` is returned before spawning the CLI. Inline text
  imports are cached under the first allowed root.
- **Import text cache.** Inline text imports are written to
  `<tmp>/znk-mcp-imports/` (or `<first-allowed-root>/.znk-mcp-imports/` when a
  path allow-list is set); files older than 7 days are removed at startup.
  The returned import recipe points at that file, so it remains usable for the
  session.
- **Serialized CLI calls.** Calls are queued one at a time; the internal
  license has `max_concurrent=2`, and serial execution avoids spurious
  concurrent-license failures.
- **8 MiB output cap** and a 60 s timeout protect the client from runaway
  kernel calls.
- **Proprietary backend.** ZNKernel-II is commercial software; this repository
  ships no kernel binary, no sample license and no key material.

---

## 10. Known limitations

- `znk_topology` is **body-level only**: `znk2_cli` 2.28.1 does not expose
  `zn2_entity_topology` through its JSON ops, so `entity` / `entity_id`
  requests return explicit `1003` rather than fabricated adjacency or
  revision data. Use the DSH ABI plugin if you need entity geometry.
- `znk_sketch_solve` batch mode returns kernel `9002` on the official CLI; use
  the single-constraint or `solve_system` contract.
- `znk_import` defaults to the fast path: `volume`, `area`, `centroid` and
  `volume_source` are `null`. Set `with_mass:true` to measure them.
- The CLI's own capability report is authoritative for which boolean families
  are analytic vs faceted. Curved fallback volumes are approximated; check
  `volume_source`.
- Relative paths resolve against the server process cwd; use absolute paths in
  client calls for reproducibility.
- No progress notifications, cancellation propagation or streaming; a tool
  call completes or times out.

---

## 11. Repository layout

```text
znk-mcp/
  server.cjs                 # zero-dependency MCP stdio server (all 10 tools)
  package.json               # metadata + scripts, no dependencies
  README.md
  LICENSE                    # MIT, wrapper layer only (kernel excluded)
  examples/
    01-create-describe.jsonl # create -> describe -> adjudicate
    02-step-import.jsonl     # import -> describe -> export
    sample.step              # 10x20x30 box, generated by znk2_cli (AP242)
  test/
    selftest.cjs             # 28 assertions, prints SELFTEST PASS n/n
```

## 12. Release artifact

The packaged artifact is `znk-mcp.zip` with `znk-mcp.zip.sha256` next to it.
It is **not** published to GitHub, npm or any public registry. Verify with:

```powershell
Get-FileHash .\znk-mcp.zip -Algorithm SHA256
Get-Content .\znk-mcp.zip.sha256
```

The SHA256 of the current package is recorded in `znk-mcp.zip.sha256`; the
release report also records it.

## 13. License and publication status

`znk-mcp` (the wrapper layer) is licensed under the **MIT License** — see
[`LICENSE`](LICENSE). The MIT grant covers `server.cjs`, `package.json`,
`README.md`, `examples/` and `test/` only. It does **not** cover the
ZNKernel-II kernel (`znk2_cli`), the ZNGL licensing / activation / revocation
logic, customer `.lic` files, revocation lists or key material; those remain
proprietary and are licensed separately under the ZNKernel-II EULA.

This repository is a **source-available tool layer**, not a ZNKernel-II
distribution. No kernel binary, customer license or key material is included.

**npm status (2026-11-24): prepared, not published.** The package metadata is
complete (`name` `znk-mcp`, `version` `0.1.0`, `license` `MIT`, `engines.node`
`>=18`, `bin` `znk-mcp -> server.cjs`) and publishing is restricted by a
`files` whitelist (`server.cjs`, `README.md`, `LICENSE`, `examples/`, `test/`,
`package.json`). The tarball contains no `dist/`, no `*.lic` and no env files.
`znk-mcp.zip` is a separate source archive, not the npm tarball.

This repository and `znk-mcp.zip` are **not published to GitHub, npm or any
public registry**. Publishing requires the owner's explicit authorization;
do not publish, mirror or redistribute them without it.
