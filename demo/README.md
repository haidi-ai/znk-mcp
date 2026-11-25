# Demo samples (ZNK_DEMO=1)

These three parts are **self-built samples**, not customer parts. They exist so a
stranger can see the three-valued verdict contract without owning a
ZNKernel-II license.

| Sample | Part | Verdict summary (20 rules) | STEP SHA-256 |
| --- | --- | --- | --- |
| C01 | 120×120×10 mounting flange, 4×Ø10 through holes + Ø30 centre hole | allow 10 / reject 0 / cannot_judge 10 | `9C4027E1FC48F046127B85D0E8738DE75E3F4262476374BAB496C291B1B2352B` |
| C05 | 60×40×20 pipe fitting, Ø20 cavity + Ø12 through hole | allow 7 / reject 5 / cannot_judge 8 | `63C803A136841C7A40ABDF6B16A898C77938EE763C8CAE68B2AAADB5D39CF5B0` |
| C06 | 50×40×30 closed thin-wall box, 0.8 mm walls | allow 4 / reject 7 / cannot_judge 9 | `70C7132A63FC19FBF3C46439AF6ECE96285BD0828582763B8B0F71FD75450A54` |

- `*.verdicts.json` is the recorded `znk2_cli adjudicate` output (official
  ZNKernel-II 2.29.1 distribution, CLI 1.0.0, protocol `znk2-cli/1`, rule
  versions 1.0–1.3). Demo mode replays these rows verbatim; it does not re-run
  the kernel.
- `*.step` is the geometry those verdicts were computed on; its SHA-256 matches
  the `trace.fileShaRaw` field in the corresponding verdicts file.
- Before recording, `result.body.file` was rewritten to the package-relative
  path and `trace.licenseId` / `trace.runId` were removed. **The package contains
  no `.lic` file and no real license value or machine path**; the only license
  mentions in the package are documentation placeholders (for example
  `C:\path\to\znk2.lic`). No customer part or customer name is included. Demo
  mode never spawns `znk2_cli` and never reads a `.lic` file.

Verdict semantics: `allow` = passed, `reject` = failed, `cannot_judge` =
**undecided — never a pass**. The demo intentionally shows all three.
