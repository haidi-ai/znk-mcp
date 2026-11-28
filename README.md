<p align="center">
  <img src="https://raw.githubusercontent.com/haidi-ai/znk-mcp/main/brand/logo-400x400.png" width="120" alt="znk-mcp logo">
</p>

# znk-mcp

A **zero-dependency Node.js MCP server** (stdio, JSON-RPC 2.0) that exposes
ZNKernel-II geometry as **three-valued manufacturability verdicts**:
`allow` / `reject` / `cannot_judge`. Every verdict carries the rule id, rule
version and the input file hash, so a result can be re-checked instead of taken
on faith.

- **Try it with no license: `ZNK_DEMO=1` replays 3 recorded samples** (§2).
- Full geometry and adjudication need a ZNKernel-II installation + a customer
  license (§3); the kernel is proprietary and is not bundled here.
- Runtime: Node.js >= 18 (validated with Node v24.19.0) · **no dependencies**
- Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout · **no network socket**
- Tools: **10** · npm latest: **`znk-mcp@0.1.4`** · repo source: **`0.1.5`**
- Repo: <https://github.com/haidi-ai/znk-mcp> · npm: <https://www.npmjs.com/package/znk-mcp>

> This is a tool layer, not an official DeepSeek plugin, not a DSH/Cordis
> plugin, and not an official Anthropic MCP server. It is a single
> `server.cjs` that speaks MCP over stdio and shells out to the official
> `znk2_cli` executable.

---

## 1. Install

Requirement: Node.js >= 18.

```bash
# demo mode: no license, no kernel binary — 3 recorded samples
ZNK_DEMO=1 npx -y znk-mcp@0.1.4

# full mode: point at a ZNKernel-II distribution and your license
npx -y znk-mcp@0.1.4
```

Use the explicit version (`@0.1.4`) until `0.1.4` is the `latest` tag you are
reading. `npx -y znk-mcp` installs the newest published version; **demo mode
requires `znk-mcp >= 0.1.3`** (the release that introduced `ZNK_DEMO=1`).

MCP client entry (Claude Desktop, Cursor, DSH MCP settings, custom clients):

```json
{
  "mcpServers": {
    "znk": {
      "command": "npx",
      "args": ["-y", "znk-mcp@0.1.4"],
      "env": {
        "ZNK2_CLI": "C:\\path\\to\\znk2_cli.exe",
        "ZNK2_LICENSE_FILE": "C:\\path\\to\\znk2.lic"
      }
    }
  }
}
```

macOS/Linux: same shape with the `znk2_cli` path and forward slashes.

---

## 2. Demo mode — `ZNK_DEMO=1` (no license needed)

Demo mode serves **three recorded, self-built samples** and nothing else. It
does not load the kernel, does not read a `.lic` file and does not accept a user
file. What it shows is the three-valued contract on real recorded output:

| Sample | Part | allow | reject | cannot_judge |
| --- | --- | ---: | ---: | ---: |
| `C01` | 120×120×10 mounting flange, 4×Ø10 through holes + Ø30 centre hole | 10 | 0 | 10 |
| `C05` | 60×40×20 pipe fitting, Ø20 cavity + Ø12 through hole | 7 | 5 | 8 |
| `C06` | 50×40×30 closed thin-wall box, 0.8 mm walls | 4 | 7 | 9 |

The rows were produced by the official ZNKernel-II 2.29.1 distribution CLI
(CLI 1.0.0, protocol `znk2-cli/1`, rule versions 1.0–1.3) and are replayed
verbatim. `demo.replay: true` in the response says so explicitly.

Pipe two JSON-RPC lines into the server to see it (bash / macOS / Linux):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"znk_adjudicate","arguments":{"sample":"C05"}}}' \
  | ZNK_DEMO=1 npx -y znk-mcp@0.1.4
```

PowerShell:

```powershell
$env:ZNK_DEMO = '1'
$req = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"pwsh","version":"0"}}}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"znk_adjudicate","arguments":{"sample":"C01"}}}'
) -join "`n"
$req | npx -y znk-mcp@0.1.4
```

Demo-mode surface:

- `znk_capabilities` → the 3 samples and their summaries.
- `znk_adjudicate {"sample":"C01"|"C05"|"C06"}` → the recorded verdict rows.
- `znk_adjudicate_rules` → the rule ids present in the recordings.
- Every other tool returns `error.code = "DEMO_MODE"` and does not touch the
  kernel.

Demo mode is free. The sample STEP files and recorded verdicts live in
[`demo/`](demo/) with their SHA-256 values; no customer part, customer name,
internal path or license key is included.

---

## 3. Full mode — environment variables

The server never embeds, copies, prints or commits a license. It passes the
environment it inherited to each `znk2_cli` subprocess.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ZNK2_CLI` | yes (unless `znk2_cli` is on `PATH`) | Absolute path to `znk2_cli.exe` / `znk2_cli`. |
| `ZNK2_LICENSE_FILE` | yes for kernel operations | Absolute path to the customer `.lic` file. Missing -> CLI error `1004`. |
| `ZNK2_REVOKE_LIST` | recommended / policy-dependent | Absolute path to the signed revocation list. Missing while revocation checking is required fails closed. |
| `ZNK2_TIMEOUT_MS` | no | Per-tool timeout in ms, clamped to `1..60000`; default `60000`. |
| `ZNK2_EXPORT_DIR` | no | Default output directory when `znk_export` has no `path`. |
| `ZNK2_ALLOWED_ROOTS` | no | Path-delimiter-separated allow-list for import/export paths. |
| `ZNK_DEMO` | no | `1` / `true` enables demo mode (§2); leave unset for full mode. |

Do **not** put license contents in the repository, README, chat, logs or MCP
configuration checked into git. Point `ZNK2_LICENSE_FILE` at a file outside the
repository and keep that file's ACL restricted.

`znk_capabilities` answers without a license (`license.status = missing`);
every geometry/adjudication/sketch call returns the CLI's `1004` until a license
is configured.

---

## 4. MCP client configuration

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

Notes:

- `command: node` works when `node` is on the client's `PATH`; otherwise use the
  absolute `node.exe` path.
- Relative import/export paths resolve against the **server process cwd**;
  prefer absolute paths in tool arguments.
- The client must use the MCP **stdio** transport. This server does not open a
  TCP port and does not use HTTP.
- DSH: add it in the MCP server settings. It is not a Cordis plugin and has no
  `cordis.patch.yml`.
- DeepSeek: this is not an official DeepSeek plugin; it is a standard MCP server
  that a DeepSeek-based MCP client can launch.

---

## 5. MCP protocol surface

| Method | Result |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities.tools.listChanged=false`, `serverInfo`, `instructions` |
| `notifications/initialized` | notification; no response |
| `ping` | `{}` |
| `tools/list` | `{ "tools": [ {name, description, inputSchema}, ... ] }` with exactly 10 tools |
| `tools/call` | `{ content: [{type:"text", text}], structuredContent, isError }` |

Everything else returns JSON-RPC `-32601`. Unknown tool names return `-32602`.
Malformed JSON returns `-32700`.

Protocol-version negotiation: if the client requests one of `2025-11-25`,
`2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`, that version is echoed;
otherwise the server answers with its latest supported version `2025-11-25`.

Tool result shape (MCP `CallToolResult`):

- `content[]`: one `text` block with the pretty-printed JSON envelope.
- `structuredContent`: the same envelope as an object.
- `isError`: `true` only when the envelope has `ok:false` — adjudication rows
  whose verdict is `cannot_judge` are **not** transport errors.

No resources, prompts, sampling, logging, progress or pagination. `tools/list`
does not return a `nextCursor`.

---

## 6. Tools

| Tool | What it does | Main arguments |
| --- | --- | --- |
| `znk_create` | Create a box / cylinder / sphere / cone / torus; returns measurements, tessellation and a replayable recipe. | `primitive`, `params`, `tessellate?` |
| `znk_boolean` | `union`, `subtract` (a-b), `intersect` on two recipes; returns measurements and a new recipe. | `operation`, `a`, `b`, `tessellate?` |
| `znk_describe` | Volume, area, bbox, centroid, topology counts, Euler characteristic, `volume_source`, watertight flag. | `solid`, `tessellate?` |
| `znk_import` | STEP / IGES / DXF / DWG / STL / OBJ / ZNK import (content-probed); returns a chainable `{kind:"import",file}` recipe. | `path` or `text`, `format?`, `with_mass?` |
| `znk_export` | STL / OBJ / STEP export, with schema and unit options, round-trip stats, absolute output path. | `solid` or `file`, `format`, `path?`, `binary?`, `chord_tol?`, `angle_tol?`, `schema?`, `length_unit?` |
| `znk_adjudicate` | Run the kernel's rule registry and return raw `allow`/`reject`/`cannot_judge` rows. Demo mode: `{"sample":"C01"\|"C05"\|"C06"}`. | `solid` or `file`, `rule?`, `params?`, `tolerance?`, `otherBodies?`, `otherFiles?`, `sample?` |
| `znk_adjudicate_rules` | List the rule ids the server knows and the three verdicts. | none |
| `znk_topology` | Body-level B-rep counts and validity. Entity-level queries return explicit `1003`. | `solid`, `entity?`, `entity_id?` |
| `znk_capabilities` | Kernel/CLI version, ABI symbols, formats, license/protection status, limits. Demo mode lists the samples. | none |
| `znk_sketch_solve` | 2D sketch constraint solve (single constraint or `solve_system`). | `request`, `batch?` |

Full descriptions and JSON schemas come from `tools/list`.

**Rule-count note.** `znk_adjudicate`'s `rule` enum lists all **20 rule ids of
the ZNKernel-II 2.29.1 registry** — the same 20 ids the recorded demo samples
replay; the list was regenerated from `znk2_cli` capabilities in 0.1.4. Older
kernels expose fewer ids (2.28.1: 10): on those, call `znk_adjudicate_rules`
first and pass only ids it returns, or omit `rule` to run every rule the kernel
exposes.

### Recipes and chaining

Every geometry-producing tool returns a `recipe` that can be passed back:

```json
{"kind":"primitive","primitive":"box","params":{"lo":[0,0,0],"hi":[10,20,30]}}
{"kind":"boolean","op":"subtract","a":{"kind":"primitive"},"b":{"kind":"primitive"}}
{"kind":"import","file":"E:/path/to/part.step","format":"step"}
```

A whole previous tool result is accepted too: the CLI unwraps
`recipe` / `result.recipe`.

### Adjudication is three-valued

- `allow` — the rule passed.
- `reject` — the rule failed.
- `cannot_judge` — **undecided**. Never mapped to `allow`, never counted as a
  pass; `policy.cannot_judge` says
  `"undecided - NOT an allow; never treat as a pass"`.

The server does not add an `allowed:true` field, does not filter rows and does
not turn `cannot_judge` into an error. Callers decide what to do with an
undecided verdict.

---

## 7. Error codes

CLI/kernel codes are passed through unchanged in `structuredContent.error.code`.

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

Server-side synthetic codes:

| Code | Meaning |
| --- | --- |
| `DEMO_MODE` | tool needs the kernel, but the server runs with `ZNK_DEMO=1` |
| `DEMO_MODE_INPUT` | demo mode received a file/recipe instead of `{"sample":...}` |
| `DEMO_SAMPLE_MISSING` | a recorded demo sample file is unreadable |
| `INVALID_ARGUMENT` | arguments rejected before calling the CLI |
| `PATH_NOT_ALLOWED` | path outside `ZNK2_ALLOWED_ROOTS` |
| `TIMEOUT` | `znk2_cli` exceeded `ZNK2_TIMEOUT_MS` and was killed |
| `CLI_NOT_FOUND` | `ZNK2_CLI` cannot be spawned |
| `CLI_NO_OUTPUT` | CLI exited without stdout |
| `CLI_BAD_JSON` | CLI stdout was not JSON |
| `CLI_STDIN_ERROR` | request could not be written to the CLI |
| `OUTPUT_TOO_LARGE` | CLI output exceeded 8 MiB |
| `INTERNAL_ERROR` | unexpected server exception |

JSON-RPC layer: `-32700`, `-32600`, `-32601`, `-32602`, `-32603`.

### Timeouts

Each tool call is capped at **60 seconds** (`ZNK2_TIMEOUT_MS`, clamped
`1..60000`). On expiry the child process is killed and the tool returns
`isError:true` with `code:"TIMEOUT"`.

---

## 8. Examples

```bash
node server.cjs < examples/01-create-describe.jsonl   # create -> describe -> adjudicate
node server.cjs < examples/02-step-import.jsonl      # import -> describe -> export
```

The JSONL files omit `initialize` for brevity; the server does not enforce
initialization ordering, so piping them directly works.

---

## 9. Tests

```bash
node test/selftest.cjs
```

The self-test spawns the server over stdio and asserts 28 conditions:
initialize/tools list/ping; exactly 10 tools and their names; create volume > 0;
boolean subtract reduces that volume; describe; adjudication with every verdict
in the three-value set and `cannot_judge` preserved; rule list; body-level
topology; explicit `1003` for the unsupported entity-level query; capabilities;
sketch solve; STL export + import recipe; CLI `1003` passthrough for an invalid
primitive; `-32601` for an unknown method; `-32602` for an unknown tool.

The rule-count assertions are **not hardcoded**: they read the registry length
from `znk_capabilities` (`result.adjudicate.rules`) and expect exactly that many
rows and rule ids — 10 on kernel 2.28.1, 20 on 2.29.1. The pass line is:

```text
SELFTEST PASS n/n
```

where `n` is the assertion count of this build (28 in 0.1.4); the rule-count
expectations move with the kernel registry instead of being pinned to 10.

Negative-path behaviour: `ZNK2_TIMEOUT_MS=1` -> `TIMEOUT`; no
`ZNK2_LICENSE_FILE` -> CLI `1004` (or `DEMO_MODE` when `ZNK_DEMO=1`); bad
`ZNK2_CLI` -> `CLI_NOT_FOUND`.

---

## 10. Security and operational limits

- **No embedded license / key.** License and revocation paths come only from the
  environment. The server logs only whether they are configured, never their
  values.
- **No network access.** The server never opens a socket; it only spawns the
  configured CLI (demo mode does not even do that).
- **Path allow-list.** `ZNK2_ALLOWED_ROOTS` (path-delimiter separated) confines
  import/export paths; `PATH_NOT_ALLOWED` is returned before spawning the CLI.
- **Import text cache.** Inline text imports are written to
  `<tmp>/znk-mcp-imports/` (or `<first-allowed-root>/.znk-mcp-imports/`); files
  older than 7 days are removed at startup.
- **Serialized CLI calls.** Calls are queued one at a time; serial execution
  avoids spurious concurrent-license failures.
- **8 MiB output cap** and a 60 s timeout protect the client from runaway kernel
  calls.
- **Proprietary backend.** ZNKernel-II is commercial software; this repository
  ships no kernel binary, no sample license and no key material.

---

## 11. Known limitations

- **Not a CAD modeler or GUI.** No feature tree, no assemblies, no drawings, no
  interactive editing.
- **Not a CAE/FEA solver.** No meshing, structural, thermal or flow analysis.
- **Not CAM / path planning.** No toolpath, no post-processor, no machine
  simulation.
- **Demo mode replays recorded rows.** It is not a fresh computation on your
  geometry; `demo.replay: true` marks every such response.
- `znk_topology` is **body-level only**: `znk2_cli` does not expose
  `zn2_entity_topology` through its JSON ops, so `entity` / `entity_id` requests
  return explicit `1003` rather than fabricated adjacency or revision data.
- `znk_sketch_solve` batch mode returns kernel `9002` on the official CLI; use
  the single-constraint or `solve_system` contract.
- `znk_import` defaults to the fast path: `volume`, `area`, `centroid` and
  `volume_source` are `null`. Set `with_mass:true` to measure them.
- Curved fallback volumes are approximated; check `volume_source`.
- Relative paths resolve against the server process cwd; use absolute paths in
  client calls for reproducibility.
- No progress notifications, cancellation propagation or streaming.

`cannot_judge` is a legitimate undecided outcome, not a pass and not a defect
of the tool layer.

---

## 12. Repository layout

```text
znk-mcp/
  server.cjs                 # zero-dependency MCP stdio server (all 10 tools)
  package.json               # metadata + scripts, no dependencies
  README.md
  LICENSE                    # MIT, wrapper layer only (kernel excluded)
  demo/
    README.md                # provenance of the recorded samples
    samples/                 # C01/C05/C06 .step + .verdicts.json (self-built)
  examples/
    01-create-describe.jsonl # create -> describe -> adjudicate
    02-step-import.jsonl     # import -> describe -> export
    sample.step              # 10x20x30 box, generated by znk2_cli (AP242)
  test/
    selftest.cjs             # self-test: 28 assertions; rule counts follow znk_capabilities
```

---

## 13. License and publication status

`znk-mcp` (the wrapper layer) is licensed under the **MIT License** — see
[`LICENSE`](LICENSE). The MIT grant covers `server.cjs`, `package.json`,
`README.md`, `demo/`, `examples/` and `test/` only. It does **not** cover the
ZNKernel-II kernel (`znk2_cli`), the ZNGL licensing / activation / revocation
logic, customer `.lic` files, revocation lists or key material; those remain
proprietary and are licensed separately under the ZNKernel-II EULA.

Demo mode is free and needs no license: it replays recorded sample verdicts and
ships no kernel code. Commercial or production use of the geometry tools
requires a ZNKernel-II license.

**Release status (2026-11-28):** `znk-mcp@0.1.4` is **published on npm**
(`latest`) — it corrects the stale self-test pass-count promise, makes the
self-test read the rule count from the kernel registry instead of hardcoding
it (**20 rules** on 2.29.1; the older 2.28.1 kernel exposes 10) and expands the
`znk_adjudicate` rule enum to the 20 ids of the 2.29.1 registry. The tool
surface is otherwise unchanged from `0.1.3`; install with
`npx -y znk-mcp@0.1.4`. The repository source version is `0.1.5` (the `0.1.5`
npm publish is tracked as a separate release task). Public GitHub repository:
<https://github.com/haidi-ai/znk-mcp>. The npm `files` whitelist is
`server.cjs`, `README.md`, `LICENSE`, `demo/`, `examples/`, `test/`,
`package.json`; the tarball contains no `dist/`, no `*.lic` file and no env
files.

**Evaluation build / 评测版.** This is an evaluation build for trial and
evaluation only: it is **not a quotation or a commercial offer** (非报价) and
contains **no customer data** (不含客户数据). Real quotes and customer-specific
trials are handled separately. To request a trial, open a **Trial request**
issue — the form lives in
[`.github/ISSUE_TEMPLATE/trial-request.yml`](.github/ISSUE_TEMPLATE/trial-request.yml)
and asks for company, part type, parts per day, contact and trial mode.
