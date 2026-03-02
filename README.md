# SAL Tools (VSCode extension)

This extension adds **SAL language support** (syntax highlighting + snippets) and **one‑click runners** for the SAL (Symbolic Analysis Laboratory) toolchain:

- `sal-wfc` (well‑formedness)
- `sal-smc` (symbolic model checker)
- `sal-bmc` (bounded model checker)
- `sal-inf-bmc` (infinite-state BMC)
- `sal-emc` (explicit model checker)
- `sal-wmc` (witness model checker)
- `sal-deadlock-checker`
- `sal-invalid-state-detector`
- `sal-path-finder`
- `sal-path-explorer`
- `sal-atg`
- `ltl2buchi`
- `sal2bool`
- Interactive helpers: `salenv`, `salenv-safe`, `sal-sim` (terminal)

## What you get

### Language features
- `.sal` file association
- Syntax highlighting (keywords/types/operators/comments)
- Snippets: `context`, `module`, `theorem`
- Outline view support (Contexts / Modules / Types / Assertions)

### “Button-click away” tool integration
- **CodeLens** above:
  - `CONTEXT` declarations (WFC / SMC all‑assertions)
  - `MODULE` declarations (Deadlock / Path Finder / More…)
  - `THEOREM`/`LEMMA`/`CLAIM`/`OBLIGATION` declarations (SMC / BMC / EMC / More…)
  - Prover runs from CodeLens open a split result view (theorem, invocation, output)
- **Explorer sidebar view**: “SAL Tools”
- **Status bar button** (“SAL”) while editing SAL files
- **Editor title button**: “SAL: Run Checker…”
- **Configuration Manager (webview)**:
  - Manage named run configurations (`+ New`, save/update/delete)
  - Edit the active configuration (tool + target + flags + env)
- **Runtime Dashboard (webview)**:
  - Stage configs via drag/drop and launch batches
  - Monitor running/completed jobs (status, PID, exit code) and stop active jobs
- **Startup Dashboard (webview)**:
  - Recent SAL files (ring buffer of latest 6 open/save events)
  - Latest commit summaries from configured SAL repositories
  - Nightly release notes + local/nightly build-date sync status
  - One-click `Update SAL` action
  - Opens automatically when the extension initializes
  - GitHub requests are lazy (on panel expand), with caching to reduce rate-limit pressure

### Parametric contexts
If your context is declared like:

```sal
bakery{N : nznat, B : nznat}: CONTEXT =
BEGIN
  ...
END
```

…and `sal.run.promptForContextInstantiation` is enabled, the extension will prompt you for an instantiation like `5,15` and run tools on `bakery{5,15}`.

## Setup

### 1) Install SAL
The extension can install the nightly build from:

- `https://github.com/karthiknukala/sal/releases/tag/nightly`

It does **not** auto-install at startup. Use one of:

- `SAL: Update Nightly Build`
- `SAL: Startup Dashboard…` → install button

After SAL is installed/configured, the startup nightly compatibility check is throttled to at most once per week.

### 2) Point the extension at your SAL binaries (optional)
In VSCode Settings, set:

- `sal.toolchain.binPath` → directory containing `sal-smc`, `sal-bmc`, etc.

Example:

```jsonc
{
  "sal.toolchain.binPath": "/opt/sal-3.3/bin"
}
```

If you don’t set `sal.toolchain.binPath`, the extension will rely on your `PATH`.

You can also pick a folder interactively via:

- `SAL: Select Toolchain Bin Path…`

### 3) SALPATH
The extension automatically prepends the **active file’s directory** to `SALPATH` for each run, so tools can find the context.

You can add additional directories via:

- `sal.env.salpath`: `[ "/path/to/my/contexts", ... ]`

You can also set arbitrary env vars via:

- `sal.env.extra`: `{ "ICS_LICENSE_CERTIFICATE": "/path/to/cert", ... }`

## Using the tools

1. Open a `.sal` file.
2. Use any of:
   - CodeLens links above contexts/modules/assertions
   - The “SAL Tools” view (Explorer sidebar)
   - Status bar “SAL” button
   - Command palette: `SAL: Run Checker…`
   - Command palette: `SAL: Configuration Manager…`
   - Command palette: `SAL: Runtime Dashboard…`
   - Command palette: `SAL: Startup Dashboard…`

Both views are available from the editor title menu and the SAL Tools view.

Tool output is streamed into the **Output** panel under **“SAL”**.

## Flags / options

You can either:

- Edit settings arrays directly (e.g. `sal.tools.smc.args`)
- Or use the command: **`SAL: Configure Tool Flags…`**  
  (adds/removes flags and writes them to **workspace settings**)

Common pattern:

```jsonc
{
  "sal.common.args": ["-v", "3"],
  "sal.tools.bmc.args": ["--depth=20", "--solver=kissat"],
  "sal.tools.smc.args": ["--backward", "--cluster-size=8192"]
}
```

## Notes / limitations

- Target detection is regex‑based (not a full SAL parser). It works well on typical SAL style:
  - `name: CONTEXT =`
  - `name: MODULE =`
  - `prop: THEOREM ...`
- Diagnostics parsing is **best-effort**. You can disable it:
  - `sal.diagnostics.enable: false`
- Startup dashboard data source settings:
  - `sal.startup.nightlyRepository` (default: `karthiknukala/sal`)
  - `sal.startup.repositories` (default: `[ "karthiknukala/sal" ]`)

## Development / packaging

This extension is plain JavaScript (no build step required).

To use it locally:
1. Put the folder in your VSCode extensions directory (or)
2. Open it in VSCode and run **“Run Extension”** from the debugger.

To package as a `.vsix`, use `vsce` on a machine with internet access:

```bash
npm i -g @vscode/vsce
vsce package
```
