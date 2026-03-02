// SAL Tools VSCode extension
// Provides: SAL language highlighting + CodeLens + one-click tool runners.

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

/**
 * Tool specs.
 * targetKind:
 *  - "context": tool consumes a context (optionally just the active context)
 *  - "assertion": tool consumes a context + assertion
 *  - "module": tool consumes a context + module
 *  - "assertionOrContext": tool can run on a whole context or a single assertion (sal-smc)
 */
const TOOLS = {
  wfc: {
    id: 'wfc',
    title: 'Well-Formedness (sal-wfc)',
    exe: 'sal-wfc',
    targetKind: 'context',
    configKey: 'tools.wfc.args',
    description: 'Check SAL context for well-formedness.'
  },
  smc: {
    id: 'smc',
    title: 'Symbolic Model Check (sal-smc)',
    exe: 'sal-smc',
    targetKind: 'assertionOrContext',
    configKey: 'tools.smc.args',
    description: 'Symbolic model checking (BDD-based).'
  },
  bmc: {
    id: 'bmc',
    title: 'Bounded Model Check (sal-bmc)',
    exe: 'sal-bmc',
    targetKind: 'assertion',
    configKey: 'tools.bmc.args',
    description: 'SAT-based bounded model checking (and k-induction).'
  },
  infBmc: {
    id: 'infBmc',
    title: 'Infinite BMC (sal-inf-bmc)',
    exe: 'sal-inf-bmc',
    targetKind: 'assertion',
    configKey: 'tools.infBmc.args',
    description: 'SMT-based bounded model checking for infinite-state systems.'
  },
  emc: {
    id: 'emc',
    title: 'Explicit Model Check (sal-emc)',
    exe: 'sal-emc',
    targetKind: 'assertion',
    configKey: 'tools.emc.args',
    description: 'Explicit-state model checking.'
  },
  wmc: {
    id: 'wmc',
    title: 'Witness Model Check (sal-wmc)',
    exe: 'sal-wmc',
    targetKind: 'assertion',
    configKey: 'tools.wmc.args',
    description: 'Witness counterexample based symbolic model checker.'
  },
  deadlock: {
    id: 'deadlock',
    title: 'Deadlock Check (sal-deadlock-checker)',
    exe: 'sal-deadlock-checker',
    targetKind: 'module',
    configKey: 'tools.deadlock.args',
    description: 'Detect deadlocks for a module.'
  },
  invalidStates: {
    id: 'invalidStates',
    title: 'Invalid State Detector (sal-invalid-state-detector)',
    exe: 'sal-invalid-state-detector',
    targetKind: 'module',
    configKey: 'tools.invalidStates.args',
    description: 'Detect invalid states for a module.'
  },
  pathFinder: {
    id: 'pathFinder',
    title: 'Path Finder (sal-path-finder)',
    exe: 'sal-path-finder',
    targetKind: 'module',
    configKey: 'tools.pathFinder.args',
    description: 'Find paths (counterexamples / witnesses) in a module.'
  },
  pathExplorer: {
    id: 'pathExplorer',
    title: 'Path Explorer (sal-path-explorer)',
    exe: 'sal-path-explorer',
    targetKind: 'module',
    configKey: 'tools.pathExplorer.args',
    description: 'Explore paths of bounded length in a module.'
  },
  atg: {
    id: 'atg',
    title: 'Automated Test Generation (sal-atg)',
    exe: 'sal-atg',
    targetKind: 'module',
    configKey: 'tools.atg.args',
    description: 'Generate tests from a module.'
  },
  ltl2buchi: {
    id: 'ltl2buchi',
    title: 'LTL → Büchi (ltl2buchi)',
    exe: 'ltl2buchi',
    targetKind: 'assertion',
    configKey: 'tools.ltl2buchi.args',
    description: 'Translate LTL assertions to Büchi automata.'
  },
  sal2bool: {
    id: 'sal2bool',
    title: 'SAL → Boolean TR (sal2bool)',
    exe: 'sal2bool',
    targetKind: 'assertion',
    configKey: 'tools.sal2bool.args',
    description: 'Generate a boolean transition relation from an assertion.'
  }
};

const INTERACTIVE_TOOLS = {
  salenv: { id: 'salenv', title: 'SALenv (REPL)', exe: 'salenv' },
  salenvSafe: { id: 'salenvSafe', title: 'SALenv Safe (REPL)', exe: 'salenv-safe' },
  sim: { id: 'sim', title: 'Simulator (sal-sim)', exe: 'sal-sim' }
};

const DEFAULT_NIGHTLY_REPOSITORY = 'karthiknukala/sal';
const DEFAULT_STARTUP_REPOSITORIES = [DEFAULT_NIGHTLY_REPOSITORY];
const NIGHTLY_RELEASE_WEB_URL = 'https://github.com/karthiknukala/sal/releases/tag/nightly';
const STARTUP_COMMITS_CACHE_KEY = 'sal.startup.remote.commits';
const STARTUP_NIGHTLY_CACHE_KEY = 'sal.startup.remote.nightly';
const STARTUP_COMMITS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STARTUP_NIGHTLY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const STARTUP_NIGHTLY_INSTALLED_CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NIGHTLY_INSTALLATION_STATE_KEY = 'sal.nightly.installation';
const RECENT_SAL_FILES_KEY = 'sal.startup.recentSalFiles';
const MAX_RECENT_SAL_FILES = 6;

/**
 * Curated flag menu (used by "SAL: Configure Tool Flags…").
 * This is intentionally not exhaustive; it covers the most common options and
 * still lets users type arbitrary args in settings.
 */
const FLAG_CATALOGUE = {
  common: [
    { label: '--help', kind: 'bool', desc: 'Show help.' },
    { label: '--version', kind: 'bool', desc: 'Show version.' },
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level (e.g. 0..5).' },
    { label: '-v', kind: 'number', style: 'separate', desc: 'Verbosity level (short form).' }
  ],
  smc: [
    { label: '--backward', kind: 'bool', desc: 'Backward search (default is forward).' },
    { label: '--cluster-size', kind: 'number', style: 'equals', desc: 'BDD cluster size.' },
    { label: '--monolithic', kind: 'bool', desc: 'Use monolithic transition relation.' },
    { label: '--disable-counter-examples', kind: 'bool', desc: 'Disable counterexamples (often faster).' },
    { label: '--disable-traceability', kind: 'bool', desc: 'Disable traceability information.' },
    { label: '--delta-path', kind: 'bool', desc: 'Show only changes between consecutive states.' },
    { label: '--reorder-method', kind: 'enum', style: 'equals', desc: 'BDD reordering method.', choices: ['sift','annealing','genetic','window2','window3','window4'] }
  ],
  bmc: [
    { label: '--depth', kind: 'number', style: 'equals', desc: 'BMC depth.' },
    { label: '-d', kind: 'number', style: 'separate', desc: 'BMC depth (short form).' },
    { label: '--from', kind: 'number', style: 'equals', desc: 'Start depth.' },
    { label: '--to', kind: 'number', style: 'equals', desc: 'End depth.' },
    { label: '--iterative', kind: 'bool', desc: 'Iterative deepening.' },
    { label: '-it', kind: 'bool', desc: 'Iterative deepening (short form).' },
    { label: '--induction', kind: 'bool', desc: 'K-induction.' },
    { label: '-i', kind: 'bool', desc: 'K-induction (short form).' },
    { label: '--lemma', kind: 'string', style: 'equals', desc: 'Add lemma (repeatable).' },
    { label: '-l', kind: 'string', style: 'separate', desc: 'Add lemma (short form, repeatable).' },
    { label: '--solver', kind: 'enum', style: 'equals', desc: 'SAT solver.', choices: ['yices','yices2','ics','kissat','minisat','lingeling','zchaff','berkmin','grasp','siege'] },
    { label: '-s', kind: 'enum', style: 'separate', desc: 'SAT solver (short form).', choices: ['yices','yices2','ics','kissat','minisat','lingeling','zchaff','berkmin','grasp','siege'] },
    { label: '--acyclic', kind: 'bool', desc: 'Acyclic paths only.' },
    { label: '--display-induction-ce', kind: 'bool', desc: 'Show induction counterexample.' },
    { label: '--delta-path', kind: 'bool', desc: 'Show only changes between consecutive states.' },
    { label: '--hide-locals', kind: 'bool', desc: 'Hide local variables in traces.' }
  ],
  infBmc: [
    { label: '--depth', kind: 'number', style: 'equals', desc: 'BMC depth.' },
    { label: '-d', kind: 'number', style: 'separate', desc: 'BMC depth (short form).' },
    { label: '--induction', kind: 'bool', desc: 'K-induction.' },
    { label: '-i', kind: 'bool', desc: 'K-induction (short form).' },
    { label: '--lemma', kind: 'string', style: 'equals', desc: 'Add lemma (repeatable).' },
    { label: '-l', kind: 'string', style: 'separate', desc: 'Add lemma (short form, repeatable).' },
    { label: '--solver', kind: 'enum', style: 'equals', desc: 'SMT solver.', choices: ['yices','yices2','ics','cvcl','svc'] },
    { label: '-s', kind: 'enum', style: 'separate', desc: 'SMT solver (short form).', choices: ['yices','yices2','ics','cvcl','svc'] }
  ],
  emc: [
    { label: '--strategy', kind: 'enum', style: 'equals', desc: 'Search strategy.', choices: ['bfs','dfs','cacheless'] },
    { label: '-s', kind: 'enum', style: 'separate', desc: 'Search strategy (short form).', choices: ['bfs','dfs','cacheless'] },
    { label: '--depth', kind: 'number', style: 'equals', desc: 'Depth bound.' },
    { label: '-d', kind: 'number', style: 'separate', desc: 'Depth bound (short form).' },
    { label: '--num-paths', kind: 'number', style: 'equals', desc: 'Number of paths (simulation).' },
    { label: '-n', kind: 'number', style: 'separate', desc: 'Number of paths (short form).' },
    { label: '--type-check', kind: 'bool', desc: 'Enable type checking during simulation.' },
    { label: '-g', kind: 'bool', desc: 'Enable type checking (short form).' },
    { label: '--deadlock', kind: 'bool', desc: 'Check deadlocks.' },
    { label: '-k', kind: 'bool', desc: 'Check deadlocks (short form).' },
    { label: '--compile', kind: 'bool', desc: 'Dynamic compilation.' },
    { label: '-c', kind: 'bool', desc: 'Dynamic compilation (short form).' },
    { label: '--symmetry', kind: 'string', style: 'equals', desc: 'Symmetry reduction option.' },
    { label: '-y', kind: 'string', style: 'separate', desc: 'Symmetry reduction (short form).' },
    { label: '--delta-path', kind: 'bool', desc: 'Show only changes between consecutive states.' },
    { label: '--disable-traceability', kind: 'bool', desc: 'Disable traceability information.' }
  ],
  wmc: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '--disable-traceability', kind: 'bool', desc: 'Disable traceability information.' },
    { label: '--delta-path', kind: 'bool', desc: 'Show only changes between consecutive states.' }
  ],
  deadlock: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '-v', kind: 'number', style: 'separate', desc: 'Verbosity level (short form).' },
    { label: '-u', kind: 'number', style: 'separate', desc: 'Unroll bound (if supported).' }
  ],
  invalidStates: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '-v', kind: 'number', style: 'separate', desc: 'Verbosity level (short form).' },
    { label: '-u', kind: 'number', style: 'separate', desc: 'Unroll bound (if supported).' }
  ],
  pathFinder: [
    { label: '--depth', kind: 'number', style: 'equals', desc: 'Depth bound.' },
    { label: '--full-trace', kind: 'bool', desc: 'Show full trace.' },
    { label: '--disable-traceability', kind: 'bool', desc: 'Disable traceability information.' },
    { label: '--solver', kind: 'enum', style: 'equals', desc: 'SAT solver.', choices: ['yices','yices2','ics','kissat','minisat','lingeling'] }
  ],
  pathExplorer: [
    { label: '-d', kind: 'number', style: 'separate', desc: 'Depth bound (short form).' },
    { label: '-n', kind: 'number', style: 'separate', desc: 'Number of paths (short form).' },
    { label: '-k', kind: 'bool', desc: 'Check deadlocks / keep? (tool-specific).' },
    { label: '-g', kind: 'bool', desc: 'Enable type checking (tool-specific).' }
  ],
  atg: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '--solver', kind: 'enum', style: 'equals', desc: 'SAT solver.', choices: ['yices','yices2','ics','kissat','minisat','lingeling'] },
    { label: '--incremental', kind: 'bool', desc: 'Incremental test generation (if supported).' }
  ],
  ltl2buchi: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '-dbo', kind: 'bool', desc: 'Disable expensive optimizations.' },
    { label: '-dotty', kind: 'bool', desc: 'Output dot graph (if supported).' }
  ],
  sal2bool: [
    { label: '--output', kind: 'string', style: 'equals', desc: 'Output file.' }
  ],
  wfc: [
    { label: '--verbose', kind: 'number', style: 'equals', desc: 'Verbosity level.' },
    { label: '-v', kind: 'number', style: 'separate', desc: 'Verbosity level (short form).' }
  ]
};

// ---------- Parsing helpers (best-effort, regex-based) ----------

function indexSalDocument(document) {
  const contexts = [];
  const modules = [];
  const assertions = [];
  const types = [];

  const contextRe = /^\s*([A-Za-z][\w?_]*)(\s*\{[^}]*\})?\s*:\s*CONTEXT\b/i;
  const moduleRe = /^\s*([A-Za-z][\w?_]*)(\s*\[[^\]]*\])?\s*:\s*MODULE\b/i;
  const assertionRe = /^\s*([A-Za-z][\w?_]*)\s*:\s*(THEOREM|LEMMA|CLAIM|OBLIGATION)\b/i;
  const typeRe = /^\s*([A-Za-z][\w?_]*)\s*:\s*TYPE\b/i;

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i).text;

    let m = contextRe.exec(line);
    if (m) {
      contexts.push({ name: m[1], formalParamsRaw: m[2] || '', line: i });
      continue;
    }

    m = moduleRe.exec(line);
    if (m) {
      modules.push({ name: m[1], line: i });
      continue;
    }

    m = assertionRe.exec(line);
    if (m) {
      assertions.push({ name: m[1], kind: m[2], line: i });
      continue;
    }

    m = typeRe.exec(line);
    if (m) {
      types.push({ name: m[1], line: i });
      continue;
    }
  }

  return { contexts, modules, assertions, types };
}

function parseFormalParamNames(formalParamsRaw) {
  // formalParamsRaw like "{N : nznat, B : nznat}"
  if (!formalParamsRaw) return [];
  const inner = formalParamsRaw.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  // Split on commas at top-level (best effort)
  const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
  const names = [];
  for (const p of parts) {
    const m = /^([A-Za-z][\w?_]*)\s*:/.exec(p);
    if (m) names.push(m[1]);
  }
  return names;
}

function findEnclosingContextName(contexts, line) {
  let name = undefined;
  for (const c of (contexts || [])) {
    if (c.line > line) break;
    name = c.name;
  }
  return name;
}

// ---------- VSCode integration ----------

class SalCodeLensProvider {
  constructor() {}

  provideCodeLenses(document, token) {
    const idx = indexSalDocument(document);
    const lenses = [];
    const codeLensArg = (payload) => Object.assign({ source: 'codelens' }, payload || {});

    // Top-level lens: run checker on this file
    const topRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(new vscode.CodeLens(topRange, {
      title: 'SAL: Run Checker…',
      command: 'sal.runChecker',
      arguments: [codeLensArg({ uri: document.uri })]
    }));

    lenses.push(new vscode.CodeLens(topRange, {
      title: 'SAL: Configuration Manager…',
      command: 'sal.openRunConfig',
      arguments: [codeLensArg({ uri: document.uri })]
    }));

    lenses.push(new vscode.CodeLens(topRange, {
      title: 'SAL: Runtime Dashboard…',
      command: 'sal.openRuntimeDashboard',
      arguments: [codeLensArg({ uri: document.uri })]
    }));

    // Context lenses
    for (const ctx of idx.contexts) {
      const range = new vscode.Range(ctx.line, 0, ctx.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: WFC',
        command: 'sal.runWfc',
        arguments: [codeLensArg({ uri: document.uri, contextName: ctx.name, declarationLine: ctx.line, declarationKind: 'context' })]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: SMC (all assertions)',
        command: 'sal.runSmc',
        arguments: [codeLensArg({ uri: document.uri, contextName: ctx.name, runWholeContext: true, declarationLine: ctx.line, declarationKind: 'context' })]
      }));
    }

    // Module lenses
    for (const mod of idx.modules) {
      const contextName = findEnclosingContextName(idx.contexts, mod.line);
      const runArgs = contextName
        ? codeLensArg({ uri: document.uri, contextName, moduleName: mod.name, declarationLine: mod.line, declarationKind: 'module' })
        : codeLensArg({ uri: document.uri, moduleName: mod.name, declarationLine: mod.line, declarationKind: 'module' });
      const range = new vscode.Range(mod.line, 0, mod.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: Deadlock',
        command: 'sal.runDeadlockChecker',
        arguments: [runArgs]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: Path Finder',
        command: 'sal.runPathFinder',
        arguments: [runArgs]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: More…',
        command: 'sal.runChecker',
        arguments: [Object.assign({ defaultKind: 'module' }, runArgs)]
      }));
    }

    // Assertion lenses
    for (const asrt of idx.assertions) {
      const contextName = findEnclosingContextName(idx.contexts, asrt.line);
      const runArgs = contextName
        ? codeLensArg({ uri: document.uri, contextName, assertionName: asrt.name, declarationLine: asrt.line, declarationKind: 'assertion' })
        : codeLensArg({ uri: document.uri, assertionName: asrt.name, declarationLine: asrt.line, declarationKind: 'assertion' });
      const range = new vscode.Range(asrt.line, 0, asrt.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: SMC',
        command: 'sal.runSmc',
        arguments: [runArgs]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: BMC',
        command: 'sal.runBmc',
        arguments: [runArgs]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: EMC',
        command: 'sal.runEmc',
        arguments: [runArgs]
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'SAL: More…',
        command: 'sal.runChecker',
        arguments: [Object.assign({ defaultKind: 'assertion' }, runArgs)]
      }));
    }

    return lenses;
  }
}

class SalDocumentSymbolProvider {
  provideDocumentSymbols(document, token) {
    const idx = indexSalDocument(document);
    const symbols = [];

    // Contexts as namespaces
    for (const ctx of idx.contexts) {
      const range = document.lineAt(ctx.line).range;
      const sel = new vscode.Range(ctx.line, 0, ctx.line, Math.min(100, document.lineAt(ctx.line).text.length));
      const s = new vscode.DocumentSymbol(ctx.name, 'CONTEXT', vscode.SymbolKind.Namespace, range, sel);
      symbols.push(s);
    }

    // Modules
    for (const mod of idx.modules) {
      const range = document.lineAt(mod.line).range;
      const sel = new vscode.Range(mod.line, 0, mod.line, Math.min(100, document.lineAt(mod.line).text.length));
      const s = new vscode.DocumentSymbol(mod.name, 'MODULE', vscode.SymbolKind.Class, range, sel);
      symbols.push(s);
    }

    // Types
    for (const t of idx.types) {
      const range = document.lineAt(t.line).range;
      const sel = new vscode.Range(t.line, 0, t.line, Math.min(100, document.lineAt(t.line).text.length));
      const s = new vscode.DocumentSymbol(t.name, 'TYPE', vscode.SymbolKind.Enum, range, sel);
      symbols.push(s);
    }

    // Assertions
    for (const a of idx.assertions) {
      const range = document.lineAt(a.line).range;
      const sel = new vscode.Range(a.line, 0, a.line, Math.min(100, document.lineAt(a.line).text.length));
      const s = new vscode.DocumentSymbol(a.name, a.kind.toUpperCase(), vscode.SymbolKind.Method, range, sel);
      symbols.push(s);
    }

    // Sort by position
    symbols.sort((x, y) => x.range.start.line - y.range.start.line);
    return symbols;
  }
}

class SalToolsTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() { this._onDidChangeTreeData.fire(); }

  getTreeItem(element) { return element; }

  getChildren(element) {
    if (!element) {
      return [
        new vscode.TreeItem('Startup Dashboard…', vscode.TreeItemCollapsibleState.None),
        new vscode.TreeItem('Run Checker…', vscode.TreeItemCollapsibleState.None),
        new vscode.TreeItem('Configuration Manager…', vscode.TreeItemCollapsibleState.None),
        new vscode.TreeItem('Runtime Dashboard…', vscode.TreeItemCollapsibleState.None),
        this._category('Model Checking', [
          this._cmdItem('Symbolic Model Check (sal-smc)', 'sal.runSmc'),
          this._cmdItem('Bounded Model Check (sal-bmc)', 'sal.runBmc'),
          this._cmdItem('Infinite BMC (sal-inf-bmc)', 'sal.runInfBmc'),
          this._cmdItem('Explicit Model Check (sal-emc)', 'sal.runEmc'),
          this._cmdItem('Witness Model Check (sal-wmc)', 'sal.runWmc')
        ]),
        this._category('Analysis', [
          this._cmdItem('Well-Formedness Check (sal-wfc)', 'sal.runWfc'),
          this._cmdItem('Deadlock Check (sal-deadlock-checker)', 'sal.runDeadlockChecker'),
          this._cmdItem('Invalid State Detector (sal-invalid-state-detector)', 'sal.runInvalidStateDetector')
        ]),
        this._category('Paths', [
          this._cmdItem('Path Finder (sal-path-finder)', 'sal.runPathFinder'),
          this._cmdItem('Path Explorer (sal-path-explorer)', 'sal.runPathExplorer')
        ]),
        this._category('Translation', [
          this._cmdItem('LTL → Büchi (ltl2buchi)', 'sal.runLtl2Buchi'),
          this._cmdItem('SAL → Boolean TR (sal2bool)', 'sal.runSal2Bool')
        ]),
        this._category('Interactive', [
          this._cmdItem('Open SALenv', 'sal.openSalenv'),
          this._cmdItem('Open SALenv Safe', 'sal.openSalenvSafe'),
          this._cmdItem('Open Simulator (sal-sim)', 'sal.openSimulator')
        ]),
        this._cmdItem('Configure Tool Flags…', 'sal.configureFlags')
      ].filter(Boolean).map(item => {
        if (item.label === 'Startup Dashboard…') {
          item.command = { command: 'sal.openStartupPane', title: 'Startup Dashboard…' };
          item.iconPath = new vscode.ThemeIcon('home');
          item.tooltip = 'Open the SAL startup dashboard.';
        }
        if (item.label === 'Run Checker…') {
          item.command = { command: 'sal.runChecker', title: 'Run Checker…' };
          item.iconPath = new vscode.ThemeIcon('play');
          item.tooltip = 'Pick a SAL tool and run it on the active file/selection.';
        }
        if (item.label === 'Configuration Manager…') {
          item.command = { command: 'sal.openRunConfig', title: 'Configuration Manager…' };
          item.iconPath = new vscode.ThemeIcon('settings-gear');
          item.tooltip = 'Open the SAL configuration manager.';
        }
        if (item.label === 'Runtime Dashboard…') {
          item.command = { command: 'sal.openRuntimeDashboard', title: 'Runtime Dashboard…' };
          item.iconPath = new vscode.ThemeIcon('pulse');
          item.tooltip = 'Open the SAL runtime dashboard.';
        }
        return item;
      });
    }

    if (element.contextValue === 'salCategory') {
      return element._children || [];
    }

    return [];
  }

  _category(label, children) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = 'salCategory';
    item._children = children;
    item.iconPath = new vscode.ThemeIcon('folder');
    return item;
  }

  _cmdItem(label, command) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command, title: label };
    item.iconPath = new vscode.ThemeIcon('run');
    return item;
  }
}

// ---------- Tool execution helpers ----------

function getSalConfiguration() {
  return vscode.workspace.getConfiguration('sal');
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x) continue;
    const key = String(x);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function resolveExecutable(exeName, overrideBinPath) {
  const cfg = getSalConfiguration();
  const binPath = (overrideBinPath !== undefined ? String(overrideBinPath) : String(cfg.get('toolchain.binPath') || '')).trim();

  if (!binPath) {
    return exeName;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(`${exeName}.exe`, `${exeName}.cmd`, `${exeName}.bat`, exeName);
  } else {
    candidates.push(exeName);
  }

  for (const c of candidates) {
    const full = path.join(binPath, c);
    try {
      if (fs.existsSync(full)) return full;
    } catch (_) { /* ignore */ }
  }
  // fallback
  return path.join(binPath, exeName);
}

function shellQuote(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[\s"]/g.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function buildEnvForDocument(documentDir, overrides) {
  const cfg = getSalConfiguration();
  const env = Object.assign({}, process.env);

  // Extra env vars from settings
  const extra = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'extraEnv'))
    ? (overrides.extraEnv || {})
    : (cfg.get('env.extra') || {});
  for (const [k, v] of Object.entries(extra)) {
    env[k] = String(v);
  }

  // SALPATH handling
  const extraSalpath = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'salpath'))
    ? (overrides.salpath || [])
    : (cfg.get('env.salpath') || []);
  const existing = env.SALPATH ? String(env.SALPATH).split(path.delimiter) : [];
  const merged = dedupePreserveOrder([documentDir, ...extraSalpath, ...existing]);
  env.SALPATH = merged.join(path.delimiter);

  // PATH: optionally prepend binPath
  const binPath = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'binPath'))
    ? String(overrides.binPath || '').trim()
    : String(cfg.get('toolchain.binPath') || '').trim();
  const prepend = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'prependBinPathToPATH'))
    ? !!overrides.prependBinPathToPATH
    : !!cfg.get('toolchain.prependBinPathToPATH');
  if (binPath && prepend) {
    const existingPath = env.PATH ? String(env.PATH) : '';
    env.PATH = [binPath, existingPath].filter(Boolean).join(path.delimiter);
  }

  return env;
}

async function getDocumentFromArgs(arg) {
  // explorer context menu passes a URI directly
  // CodeLens passes { uri, ... }
  if (!arg) {
    const editor = vscode.window.activeTextEditor;
    return editor ? editor.document : null;
  }

  if (arg instanceof vscode.Uri) {
    try {
      return await vscode.workspace.openTextDocument(arg);
    } catch (e) {
      return null;
    }
  }

  if (arg && arg.uri) {
    const uri = arg.uri instanceof vscode.Uri ? arg.uri : vscode.Uri.parse(String(arg.uri));
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch (e) {
      return null;
    }
  }

  return null;
}

function pickFromList(title, items, placeholder) {
  return vscode.window.showQuickPick(
    items.map(i => ({ label: i.label, description: i.description, _value: i.value })),
    { title, placeHolder: placeholder }
  ).then(sel => sel ? sel._value : undefined);
}

async function chooseAssertion(document, preselectedName) {
  if (preselectedName) return preselectedName;
  const idx = indexSalDocument(document);
  const items = idx.assertions.map(a => ({ label: a.name, description: a.kind, value: a.name }));
  if (items.length === 0) {
    return await vscode.window.showInputBox({ prompt: 'Assertion name', placeHolder: 'e.g. mutex' });
  }
  return await pickFromList('Select assertion', items, 'Pick a theorem/lemma/claim/obligation…');
}

async function chooseModule(document, preselectedName) {
  if (preselectedName) return preselectedName;
  const idx = indexSalDocument(document);
  const items = idx.modules.map(m => ({ label: m.name, description: 'MODULE', value: m.name }));
  if (items.length === 0) {
    return await vscode.window.showInputBox({ prompt: 'Module name', placeHolder: 'e.g. system' });
  }
  return await pickFromList('Select module', items, 'Pick a module…');
}

async function chooseContext(document, preselectedName) {
  if (preselectedName) return preselectedName;
  const idx = indexSalDocument(document);
  if (idx.contexts.length === 0) {
    // fallback to file base name
    return path.basename(document.fileName, path.extname(document.fileName));
  }
  if (idx.contexts.length === 1) return idx.contexts[0].name;
  const items = idx.contexts.map(c => ({ label: c.name, description: 'CONTEXT', value: c.name }));
  return await pickFromList('Select context', items, 'Pick a context…');
}

async function getContextDecl(document, contextName) {
  const idx = indexSalDocument(document);
  if (!idx.contexts.length) return null;
  if (!contextName) return idx.contexts[0];
  return idx.contexts.find(c => c.name === contextName) || idx.contexts[0];
}

function shouldUseContextFromFile(overrides, cfg) {
  const conf = cfg || getSalConfiguration();
  return (overrides && Object.prototype.hasOwnProperty.call(overrides, 'useContextFromFile'))
    ? !!overrides.useContextFromFile
    : !!conf.get('run.useContextFromFile');
}

async function buildContextExpression(extCtx, document, contextName, overrides) {
  const cfg = getSalConfiguration();
  const runUseContext = shouldUseContextFromFile(overrides, cfg);
  if (!runUseContext) return null;

  const ctxDecl = await getContextDecl(document, contextName);
  const ctxBaseName = ctxDecl ? ctxDecl.name : (contextName || path.basename(document.fileName, path.extname(document.fileName)));

  const formalRaw = ctxDecl ? (ctxDecl.formalParamsRaw || '') : '';
  if (!formalRaw) return ctxBaseName;

  // If provided (e.g. from the Run Configuration webview), use it and remember it.
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'contextInstantiation')) {
    const raw = overrides.contextInstantiation;
    const trimmed = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!trimmed) return ctxBaseName;

    const key = `contextInstantiation:${ctxBaseName}`;
    await extCtx.workspaceState.update(key, trimmed);

    if (trimmed.includes('{') && trimmed.includes('}')) {
      // Allow user to provide a full context expression (e.g. bakery{5,15})
      // or just {5,15}.
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return `${ctxBaseName}${trimmed}`;
      }
      return trimmed;
    }

    return `${ctxBaseName}{${trimmed}}`;
  }

  const promptForInst = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'promptForContextInstantiation'))
    ? !!overrides.promptForContextInstantiation
    : !!cfg.get('run.promptForContextInstantiation');
  if (!promptForInst) return ctxBaseName;

  const paramNames = parseFormalParamNames(formalRaw);
  const key = `contextInstantiation:${ctxBaseName}`;
  const prev = extCtx.workspaceState.get(key, '');
  const prompt = await vscode.window.showInputBox({
    prompt: paramNames.length
      ? `Enter values for ${ctxBaseName}{${paramNames.join(', ')}} (comma-separated)`
      : `Enter context instantiation for ${ctxBaseName} (comma-separated values)`,
    placeHolder: 'e.g. 5,15   (or: bakery{5,15})',
    value: prev
  });

  if (prompt === undefined) {
    // user cancelled
    return undefined;
  }

  const trimmed = String(prompt).trim();
  if (!trimmed) return ctxBaseName;

  await extCtx.workspaceState.update(key, trimmed);

  if (trimmed.includes('{') && trimmed.includes('}')) {
    // allow user to paste bakery{5,15} or {5,15}
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return `${ctxBaseName}${trimmed}`;
    }
    return trimmed;
  }

  return `${ctxBaseName}{${trimmed}}`;
}

function flattenArgs(args) {
  // Remove empty args and stringify
  const out = [];
  for (const a of (args || [])) {
    if (a === undefined || a === null) continue;
    const s = String(a).trim();
    if (!s) continue;
    out.push(s);
  }
  return out;
}

function flagDefToArgs(flag, value) {
  // Convert a flag definition from FLAG_CATALOGUE into argv elements.
  // For value flags, "style" controls whether we emit "--opt=value" (equals)
  // or "-o value" (separate).
  if (!flag) return [];
  if (flag.kind === 'bool') return [flag.label];

  const style = flag.style
    ? String(flag.style)
    : (String(flag.label).startsWith('-') && !String(flag.label).startsWith('--') ? 'separate' : 'equals');

  const v = value === undefined || value === null ? '' : String(value);

  if (style === 'separate') {
    return [flag.label, v];
  }
  // default: equals
  return [`${flag.label}=${v}`];
}

async function prepareCliInvocation(extCtx, toolSpec, arg, runOverrides, options) {
  const opts = options || {};
  const promptForMissingTargets = opts.promptForMissingTargets !== false;

  const document = await getDocumentFromArgs(arg);
  if (!document) {
    throw new Error('No document selected/open.');
  }

  const cfg = getSalConfiguration();
  const runUseContext = shouldUseContextFromFile(runOverrides, cfg);
  const alwaysSaveBeforeRun = (runOverrides && Object.prototype.hasOwnProperty.call(runOverrides, 'alwaysSaveBeforeRun'))
    ? !!runOverrides.alwaysSaveBeforeRun
    : !!cfg.get('run.alwaysSaveBeforeRun');
  const diagnosticsEnable = (runOverrides && Object.prototype.hasOwnProperty.call(runOverrides, 'diagnosticsEnable'))
    ? !!runOverrides.diagnosticsEnable
    : !!cfg.get('diagnostics.enable');

  if (alwaysSaveBeforeRun && document.isDirty) {
    await document.save();
  }

  const docDir = path.dirname(document.fileName);
  const env = buildEnvForDocument(docDir, runOverrides);
  const cwd = docDir;
  const idx = indexSalDocument(document);

  const fallbackContextName = idx.contexts.length
    ? idx.contexts[0].name
    : path.basename(document.fileName, path.extname(document.fileName));

  let contextName = arg && arg.contextName ? String(arg.contextName) : undefined;
  const shouldChooseContext = runUseContext
    || toolSpec.targetKind === 'context'
    || toolSpec.targetKind === 'assertionOrContext';
  if (shouldChooseContext) {
    if (!contextName) {
      if (promptForMissingTargets) {
        contextName = await chooseContext(document, contextName);
      } else {
        contextName = fallbackContextName;
      }
    }
    if (!contextName) {
      throw new Error('No context selected.');
    }
  }

  const effectiveOverrides = Object.assign({}, runOverrides || {});
  if (!promptForMissingTargets && !Object.prototype.hasOwnProperty.call(effectiveOverrides, 'promptForContextInstantiation')) {
    effectiveOverrides.promptForContextInstantiation = false;
  }

  const contextExpr = await buildContextExpression(extCtx, document, contextName, effectiveOverrides);
  if (contextExpr === undefined) {
    return { cancelled: true };
  }
  const useContext = !!contextExpr;

  let assertionName = arg && arg.assertionName ? String(arg.assertionName) : undefined;
  let moduleName = arg && arg.moduleName ? String(arg.moduleName) : undefined;
  const runWholeContext = !!(arg && arg.runWholeContext);

  if (toolSpec.targetKind === 'assertion' || toolSpec.targetKind === 'assertionOrContext') {
    if (!runWholeContext) {
      if (!assertionName) {
        if (promptForMissingTargets) {
          assertionName = await chooseAssertion(document, assertionName);
        } else if (idx.assertions.length === 1) {
          assertionName = idx.assertions[0].name;
        }
      }
      if (!assertionName) {
        throw new Error('No assertion selected.');
      }
    }
  }

  if (toolSpec.targetKind === 'module') {
    if (!moduleName) {
      if (promptForMissingTargets) {
        moduleName = await chooseModule(document, moduleName);
      } else if (idx.modules.length === 1) {
        moduleName = idx.modules[0].name;
      }
    }
    if (!moduleName) {
      throw new Error('No module selected.');
    }
  }

  const commonArgs = flattenArgs((runOverrides && Object.prototype.hasOwnProperty.call(runOverrides, 'commonArgs'))
    ? (runOverrides.commonArgs || [])
    : (cfg.get('common.args') || []));
  const toolArgs = flattenArgs((runOverrides && Object.prototype.hasOwnProperty.call(runOverrides, 'toolArgs'))
    ? (runOverrides.toolArgs || [])
    : (cfg.get(toolSpec.configKey) || []));

  const args = [];
  args.push(...commonArgs);
  args.push(...toolArgs);

  if (toolSpec.targetKind === 'assertion') {
    if (useContext) {
      args.push(contextExpr);
      args.push(assertionName);
    } else {
      args.push(document.fileName);
      args.push(assertionName);
    }
  } else if (toolSpec.targetKind === 'module') {
    if (useContext) {
      args.push(contextExpr);
      args.push(moduleName);
    } else {
      args.push(document.fileName);
      args.push(moduleName);
    }
  } else if (toolSpec.targetKind === 'context') {
    if (useContext) {
      args.push(contextExpr);
    } else {
      args.push(document.fileName);
    }
  } else if (toolSpec.targetKind === 'assertionOrContext') {
    if (runWholeContext) {
      if (useContext) args.push(contextExpr);
      else args.push(document.fileName);
    } else {
      if (useContext) {
        args.push(contextExpr);
        args.push(assertionName);
      } else {
        args.push(document.fileName);
        args.push(assertionName);
      }
    }
  }

  const cmd = resolveExecutable(toolSpec.exe, (runOverrides && Object.prototype.hasOwnProperty.call(runOverrides, 'binPath')) ? runOverrides.binPath : undefined);
  const cmdLineForDisplay = `$ ${shellQuote(cmd)} ${args.map(shellQuote).join(' ')}`;

  return {
    cancelled: false,
    diagnosticsEnable,
    document,
    cwd,
    env,
    cmd,
    args,
    cmdLineForDisplay,
    target: {
      contextName: contextName || '',
      moduleName: moduleName || '',
      assertionName: assertionName || '',
      runWholeContext: !!runWholeContext,
      useContext,
      contextExpression: contextExpr || ''
    }
  };
}

async function runCliTool(extCtx, outputChannel, diagnostics, toolSpec, arg, runOverrides) {
  let prepared;
  try {
    prepared = await prepareCliInvocation(extCtx, toolSpec, arg, runOverrides, { promptForMissingTargets: true });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    vscode.window.showErrorMessage(`SAL: ${msg}`);
    return;
  }
  if (prepared.cancelled) {
    return;
  }

  const diagnosticsEnable = prepared.diagnosticsEnable;
  const document = prepared.document;
  const cwd = prepared.cwd;
  const env = prepared.env;
  const cmd = prepared.cmd;
  const args = prepared.args;
  const cmdLineForDisplay = prepared.cmdLineForDisplay;
  const targetSummary = summarizeInvocationTarget(prepared.target);
  const isCodeLensRun = !!(arg && arg.source === 'codelens');
  const declarationText = isCodeLensRun
    ? extractDeclarationForCodeLens(document, arg, prepared.target)
    : '';
  const resultPanel = isCodeLensRun ? SalCodeLensResultPanel.createOrShow() : null;

  outputChannel.clear();
  outputChannel.appendLine(cmdLineForDisplay);
  outputChannel.appendLine('');

  if (resultPanel) {
    resultPanel.postRunState({
      title: `SAL: ${toolSpec.title}`,
      targetSummary,
      theorem: declarationText || 'No declaration metadata found for this CodeLens action.',
      commandLine: cmdLineForDisplay,
      resultText: '',
      statusText: 'Running…',
      timestamp: new Date().toISOString()
    }).catch(() => {});
  }

  // Clear previous diagnostics for this file
  if (diagnosticsEnable) {
    diagnostics.delete(document.uri);
  }

  const collectedLines = [];
  let collectedText = '';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: `SAL: ${toolSpec.title}`
    },
    (progress, token) =>
      new Promise((resolve) => {
        let proc;
        let wasCancelled = false;
        let hadProcessError = false;
        try {
          proc = cp.spawn(cmd, args, {
            cwd,
            env,
            shell: process.platform === 'win32'
          });
        } catch (e) {
          vscode.window.showErrorMessage(`SAL: Failed to start ${toolSpec.exe}: ${e.message || e}`);
          if (resultPanel) {
            const msg = String(e && e.message ? e.message : e);
            resultPanel.postRunState({
              title: `SAL: ${toolSpec.title}`,
              targetSummary,
              theorem: declarationText || 'No declaration metadata found for this CodeLens action.',
              commandLine: cmdLineForDisplay,
              resultText: `[process error] ${msg}`,
              statusText: 'Failed to start.',
              timestamp: new Date().toISOString()
            }).catch(() => {});
          }
          resolve();
          return;
        }

        token.onCancellationRequested(() => {
          wasCancelled = true;
          try { proc.kill(); } catch (_) { /* ignore */ }
        });

        proc.stdout.on('data', (buf) => {
          const text = buf.toString('utf8');
          outputChannel.append(text);
          collectedLines.push(...text.split(/\r?\n/));
          collectedText = appendBoundedText(collectedText, text, 350000);
        });

        proc.stderr.on('data', (buf) => {
          const text = buf.toString('utf8');
          outputChannel.append(text);
          collectedLines.push(...text.split(/\r?\n/));
          collectedText = appendBoundedText(collectedText, text, 350000);
        });

        proc.on('error', (err) => {
          hadProcessError = true;
          const msg = err && err.message ? err.message : String(err);
          outputChannel.appendLine(`\n[process error] ${msg}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`SAL: Failed to start ${toolSpec.exe}: ${msg}`);
          if (resultPanel) {
            const fullResult = appendBoundedText(collectedText, `\n[process error] ${msg}\n`, 350000);
            resultPanel.postRunState({
              title: `SAL: ${toolSpec.title}`,
              targetSummary,
              theorem: declarationText || 'No declaration metadata found for this CodeLens action.',
              commandLine: cmdLineForDisplay,
              resultText: fullResult,
              statusText: 'Process error.',
              timestamp: new Date().toISOString()
            }).catch(() => {});
          }
          resolve();
        });

        proc.on('close', (code) => {
          if (hadProcessError) return;
          outputChannel.appendLine(`\n[exit code] ${code}`);
          outputChannel.show(true);
          const fullResult = appendBoundedText(collectedText, `\n[exit code] ${code}\n`, 350000);

          if (diagnosticsEnable) {
            const diags = parseDiagnosticsFromOutput(collectedLines, document.uri);
            diagnostics.set(document.uri, diags);
          }

          if (resultPanel) {
            let statusText = `Completed (exit code ${code}).`;
            if (wasCancelled) statusText = 'Cancelled.';
            else if (code !== 0) statusText = `Failed (exit code ${code}).`;
            resultPanel.postRunState({
              title: `SAL: ${toolSpec.title}`,
              targetSummary,
              theorem: declarationText || 'No declaration metadata found for this CodeLens action.',
              commandLine: cmdLineForDisplay,
              resultText: fullResult,
              statusText,
              timestamp: new Date().toISOString()
            }).catch(() => {});
          }

          if (wasCancelled) {
            vscode.window.showInformationMessage(`SAL: ${toolSpec.title} cancelled.`);
          } else if (code === 0) {
            vscode.window.showInformationMessage(`SAL: ${toolSpec.title} finished successfully.`);
          } else {
            vscode.window.showErrorMessage(`SAL: ${toolSpec.title} failed (exit code ${code}). See 'SAL' output.`);
          }

          resolve();
        });
      })
  );
}

function parseDiagnosticsFromOutput(lines, defaultUri) {
  // Best-effort:
  // 1) file:line:col: msg
  // 2) line <n> column <m>
  // 3) line <n>
  const diags = [];

  const re1 = /^(.+?):(\d+):(\d+):\s*(.*)$/;
  const re2 = /line\s+(\d+)\s*,?\s*column\s+(\d+)/i;
  const re3 = /\bline\s+(\d+)\b/i;

  for (const raw of lines) {
    if (!raw) continue;
    const line = String(raw);

    let fileUri = defaultUri;
    let lineNo = null;
    let colNo = null;
    let msg = null;

    let m = re1.exec(line);
    if (m) {
      const f = m[1];
      lineNo = parseInt(m[2], 10) - 1;
      colNo = parseInt(m[3], 10) - 1;
      msg = m[4] || line;

      try { fileUri = vscode.Uri.file(f); } catch (_) { fileUri = defaultUri; }
    } else {
      m = re2.exec(line);
      if (m) {
        lineNo = parseInt(m[1], 10) - 1;
        colNo = parseInt(m[2], 10) - 1;
        msg = line;
      } else {
        m = re3.exec(line);
        if (m && /\berror\b/i.test(line)) {
          lineNo = parseInt(m[1], 10) - 1;
          colNo = 0;
          msg = line;
        }
      }
    }

    if (msg && lineNo !== null && !Number.isNaN(lineNo)) {
      const range = new vscode.Range(
        Math.max(0, lineNo),
        Math.max(0, colNo || 0),
        Math.max(0, lineNo),
        Math.max(0, (colNo || 0) + 1)
      );
      const severity = /\bwarning\b/i.test(msg) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
      const d = new vscode.Diagnostic(range, msg, severity);
      diags.push(d);
    }
  }

  return diags;
}

function extractDeclarationFromLine(document, startLine, declarationKind) {
  if (!document || !Number.isInteger(startLine) || startLine < 0 || startLine >= document.lineCount) return '';
  const lines = [];
  const kind = String(declarationKind || '').toLowerCase();
  const maxLines = Math.min(document.lineCount, startLine + (kind === 'context' || kind === 'module' ? 80 : 40));
  const nextDeclRe = /^\s*[A-Za-z][\w?_]*\s*:\s*(THEOREM|LEMMA|CLAIM|OBLIGATION|MODULE|CONTEXT|TYPE)\b/i;
  for (let i = startLine; i < maxLines; i++) {
    const text = document.lineAt(i).text;
    if (i > startLine && nextDeclRe.test(text)) {
      break;
    }
    lines.push(text);
    if (kind === 'assertion') {
      if (/;\s*(--.*)?$/.test(text) && i >= startLine) break;
      if (i > startLine && /^\s*$/.test(text)) break;
    } else if (kind === 'context' || kind === 'module') {
      if (/\bBEGIN\b/i.test(text) && i > startLine) break;
      if (i > startLine + 8 && /^\s*$/.test(text)) break;
    } else if (i > startLine && /^\s*$/.test(text)) {
      break;
    }
  }
  return lines.join('\n').trim();
}

function extractDeclarationForCodeLens(document, arg, target) {
  if (!document) return '';
  const line = arg && Number.isInteger(arg.declarationLine) ? arg.declarationLine : null;
  const kind = arg && arg.declarationKind ? String(arg.declarationKind) : '';
  if (line !== null) {
    return extractDeclarationFromLine(document, line, kind);
  }

  if (target && target.assertionName) {
    const idx = indexSalDocument(document);
    const assertion = (idx.assertions || []).find((a) => a.name === target.assertionName);
    if (assertion) {
      return extractDeclarationFromLine(document, assertion.line, 'assertion');
    }
  }
  if (target && target.moduleName) {
    const idx = indexSalDocument(document);
    const mod = (idx.modules || []).find((m) => m.name === target.moduleName);
    if (mod) {
      return extractDeclarationFromLine(document, mod.line, 'module');
    }
  }
  if (target && target.contextName) {
    const idx = indexSalDocument(document);
    const ctx = (idx.contexts || []).find((c) => c.name === target.contextName);
    if (ctx) {
      return extractDeclarationFromLine(document, ctx.line, 'context');
    }
  }
  return '';
}

function summarizeInvocationTarget(target) {
  if (!target || typeof target !== 'object') return '';
  const pieces = [];
  if (target.contextName) pieces.push(`context=${target.contextName}`);
  if (target.moduleName) pieces.push(`module=${target.moduleName}`);
  if (target.assertionName) pieces.push(`assertion=${target.assertionName}`);
  if (target.runWholeContext) pieces.push('whole-context');
  return pieces.join(' | ');
}

function appendBoundedText(current, chunk, maxChars) {
  const max = Number(maxChars || 300000);
  const next = `${String(current || '')}${String(chunk || '')}`;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

class SalRuntimeManager {
  constructor(outputChannel, diagnostics) {
    this.outputChannel = outputChannel;
    this.diagnostics = diagnostics;
    this.jobs = new Map();
    this.nextJobId = 1;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  _emit() {
    this._onDidChange.fire(this.getSnapshot());
  }

  _isActiveStatus(status) {
    return status === 'preparing' || status === 'running' || status === 'cancelling';
  }

  _toPublicJob(job) {
    const startedAt = job.startedAt || job.createdAt;
    const endedAt = job.finishedAt || Date.now();
    const durationMs = startedAt ? Math.max(0, endedAt - startedAt) : null;
    return {
      id: job.id,
      configId: job.configId || '',
      configName: job.configName || '',
      source: job.source || 'runtime',
      toolId: job.toolId || '',
      toolTitle: job.toolTitle || '',
      status: job.status,
      commandLine: job.commandLine || '',
      pid: job.pid || null,
      createdAt: job.createdAt || null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      durationMs,
      exitCode: job.exitCode,
      error: job.error || '',
      targetSummary: job.targetSummary || ''
    };
  }

  getSnapshot() {
    const ranked = [];
    const order = { running: 0, preparing: 1, cancelling: 2, failed: 3, error: 4, cancelled: 5, success: 6 };
    for (const job of this.jobs.values()) {
      ranked.push(this._toPublicJob(job));
    }
    ranked.sort((a, b) => {
      const sa = Object.prototype.hasOwnProperty.call(order, a.status) ? order[a.status] : 99;
      const sb = Object.prototype.hasOwnProperty.call(order, b.status) ? order[b.status] : 99;
      if (sa !== sb) return sa - sb;
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
    return ranked;
  }

  async startJob(extCtx, toolSpec, arg, runOverrides, meta) {
    const id = `job-${this.nextJobId++}`;
    const job = {
      id,
      toolId: toolSpec.id,
      toolTitle: toolSpec.title,
      configId: meta && meta.configId ? String(meta.configId) : '',
      configName: meta && meta.configName ? String(meta.configName) : '',
      source: meta && meta.source ? String(meta.source) : 'runtime',
      targetSummary: meta && meta.targetSummary ? String(meta.targetSummary) : '',
      status: 'preparing',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      commandLine: '',
      pid: null,
      exitCode: null,
      error: '',
      cancelRequested: false,
      proc: null,
      diagnosticsEnable: false,
      documentUri: null,
      collectedLines: []
    };
    this.jobs.set(id, job);
    this._emit();

    try {
      const prepared = await prepareCliInvocation(extCtx, toolSpec, arg, runOverrides, {
        promptForMissingTargets: false
      });
      if (prepared.cancelled) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        this._emit();
        return id;
      }

      job.diagnosticsEnable = !!prepared.diagnosticsEnable;
      job.documentUri = prepared.document ? prepared.document.uri : null;
      job.commandLine = prepared.cmdLineForDisplay;
      job.startedAt = new Date().toISOString();
      job.status = 'running';
      if (job.diagnosticsEnable && job.documentUri) {
        this.diagnostics.delete(job.documentUri);
      }
      this._emit();

      this.outputChannel.appendLine(`[runtime ${job.id}] ${prepared.cmdLineForDisplay}`);

      let proc;
      try {
        proc = cp.spawn(prepared.cmd, prepared.args, {
          cwd: prepared.cwd,
          env: prepared.env,
          shell: process.platform === 'win32'
        });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        job.status = 'error';
        job.error = msg;
        job.finishedAt = new Date().toISOString();
        this.outputChannel.appendLine(`[runtime ${job.id}] failed to start: ${msg}`);
        this._emit();
        return id;
      }

      job.proc = proc;
      job.pid = proc.pid || null;
      this._emit();

      proc.stdout.on('data', (buf) => {
        const text = buf.toString('utf8');
        this.outputChannel.append(text);
        job.collectedLines.push(...text.split(/\r?\n/));
      });

      proc.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        this.outputChannel.append(text);
        job.collectedLines.push(...text.split(/\r?\n/));
      });

      proc.on('error', (err) => {
        const msg = err && err.message ? err.message : String(err);
        job.error = msg;
        job.status = job.cancelRequested ? 'cancelled' : 'error';
        job.finishedAt = new Date().toISOString();
        job.proc = null;
        this.outputChannel.appendLine(`[runtime ${job.id}] process error: ${msg}`);
        this._emit();
      });

      proc.on('close', (code) => {
        if (job.status === 'error' && job.finishedAt) {
          return;
        }
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
        job.proc = null;
        if (job.cancelRequested) {
          job.status = 'cancelled';
        } else if (code === 0) {
          job.status = 'success';
        } else {
          job.status = 'failed';
        }

        if (job.diagnosticsEnable && job.documentUri) {
          const diags = parseDiagnosticsFromOutput(job.collectedLines, job.documentUri);
          this.diagnostics.set(job.documentUri, diags);
        }
        this.outputChannel.appendLine(`[runtime ${job.id}] exit code ${code}`);
        this._emit();
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      job.status = 'error';
      job.error = msg;
      job.finishedAt = new Date().toISOString();
      this.outputChannel.appendLine(`[runtime ${job.id}] ${msg}`);
      this._emit();
    }

    return id;
  }

  cancelJob(jobId) {
    const id = String(jobId || '');
    const job = this.jobs.get(id);
    if (!job || !job.proc || !this._isActiveStatus(job.status)) {
      return false;
    }
    job.cancelRequested = true;
    job.status = 'cancelling';
    this._emit();
    try {
      job.proc.kill();
    } catch (_) {
      // ignore
    }
    return true;
  }

  clearFinishedJobs() {
    for (const [id, job] of this.jobs.entries()) {
      if (!this._isActiveStatus(job.status)) {
        this.jobs.delete(id);
      }
    }
    this._emit();
  }
}

class SalCodeLensResultPanel {
  static currentPanel = undefined;

  static createOrShow() {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    if (SalCodeLensResultPanel.currentPanel) {
      const existing = SalCodeLensResultPanel.currentPanel;
      // Keep the panel in its current editor group and preserve focus on the SAL editor.
      existing.panel.reveal(existing.panel.viewColumn || vscode.ViewColumn.Beside, true);
      return SalCodeLensResultPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'salCodeLensResult',
      'SAL Proof Result',
      { viewColumn: (column ? vscode.ViewColumn.Beside : vscode.ViewColumn.One), preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const created = new SalCodeLensResultPanel(panel);
    SalCodeLensResultPanel.currentPanel = created;
    return created;
  }

  constructor(panel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      if (SalCodeLensResultPanel.currentPanel === this) {
        SalCodeLensResultPanel.currentPanel = undefined;
      }
    });
    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);
  }

  async postRunState(state) {
    await this.panel.webview.postMessage({ type: 'runState', state: state || {} });
  }

  _getHtmlForWebview(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>SAL Proof Result</title>
  <style>
    :root {
      --sal-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
      --sal-bg: var(--vscode-editor-background);
      --sal-card-bg: var(--vscode-editorWidget-background);
      --sal-radius: 10px;
    }
    body {
      margin: 0;
      padding: 14px;
      background: var(--sal-bg);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .hero {
      border: 1px solid var(--sal-border);
      border-radius: var(--sal-radius);
      background: linear-gradient(135deg, rgba(127,127,127,0.14), rgba(127,127,127,0.05));
      padding: 10px 12px;
    }
    .title {
      margin: 0;
      font-size: 1.1em;
    }
    .muted { opacity: 0.82; }
    .small { font-size: 0.9em; }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr 1.5fr;
      gap: 10px;
    }
    .pane {
      border: 1px solid var(--sal-border);
      border-radius: var(--sal-radius);
      background: var(--sal-card-bg);
      min-height: 260px;
      display: flex;
      flex-direction: column;
    }
    .pane-head {
      font-weight: 650;
      padding: 8px 10px;
      border-bottom: 1px solid var(--sal-border);
      background: rgba(127,127,127,0.08);
    }
    .pane-body {
      margin: 0;
      padding: 10px;
      white-space: pre-wrap;
      overflow: auto;
      flex: 1;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 0.9em;
      line-height: 1.35;
    }
    @media (max-width: 1000px) {
      .split {
        grid-template-columns: 1fr;
      }
      .pane {
        min-height: 180px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <h2 id="runTitle" class="title">SAL Proof Result</h2>
      <div id="runMeta" class="small muted"></div>
      <div id="runStatus" class="small"></div>
    </section>

    <section class="split">
      <article class="pane">
        <div class="pane-head">Theorem Statement</div>
        <pre id="theoremPane" class="pane-body"></pre>
      </article>
      <article class="pane">
        <div class="pane-head">Tool Command Invocation</div>
        <pre id="commandPane" class="pane-body"></pre>
      </article>
      <article class="pane">
        <div class="pane-head">Tool Result</div>
        <pre id="resultPane" class="pane-body"></pre>
      </article>
    </section>
  </div>

  <script nonce="${nonce}">
    const byId = (id) => document.getElementById(id);
    const runTitle = byId('runTitle');
    const runMeta = byId('runMeta');
    const runStatus = byId('runStatus');
    const theoremPane = byId('theoremPane');
    const commandPane = byId('commandPane');
    const resultPane = byId('resultPane');

    function renderState(state) {
      const s = state || {};
      runTitle.textContent = s.title || 'SAL Proof Result';
      const metaParts = [];
      if (s.targetSummary) metaParts.push(s.targetSummary);
      if (s.timestamp) metaParts.push(new Date(s.timestamp).toLocaleString());
      runMeta.textContent = metaParts.join(' | ');
      runStatus.textContent = s.statusText || '';
      theoremPane.textContent = s.theorem || 'No theorem target selected.';
      commandPane.textContent = s.commandLine || '';
      resultPane.textContent = s.resultText || '';
      resultPane.scrollTop = resultPane.scrollHeight;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'runState') return;
      renderState(msg.state || {});
    });
  </script>
</body>
</html>`;
  }
}

// ---------- Run Configuration Webview ----------

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

class SalRunConfigPanel {
  static currentPanels = { config: undefined, runtime: undefined };

  static normalizeMode(mode) {
    return mode === 'runtime' ? 'runtime' : 'config';
  }

  static viewTypeForMode(mode) {
    return mode === 'runtime' ? 'salRuntimeDashboard' : 'salConfigManager';
  }

  static titleForMode(mode) {
    return mode === 'runtime' ? 'SAL Runtime Dashboard' : 'SAL Configuration Manager';
  }

  static forEachOpenPanel(fn) {
    for (const p of Object.values(SalRunConfigPanel.currentPanels)) {
      if (p) fn(p);
    }
  }

  static createOrShow(extCtx, extensionUri, outputChannel, diagnostics, runtimeManager, mode, arg) {
    const normalizedMode = SalRunConfigPanel.normalizeMode(mode);
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const existing = SalRunConfigPanel.currentPanels[normalizedMode];
    if (existing) {
      existing.panel.reveal(column);
      existing.postState(arg);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SalRunConfigPanel.viewTypeForMode(normalizedMode),
      SalRunConfigPanel.titleForMode(normalizedMode),
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const created = new SalRunConfigPanel(panel, extensionUri, extCtx, outputChannel, diagnostics, runtimeManager, normalizedMode);
    SalRunConfigPanel.currentPanels[normalizedMode] = created;
    created.postState(arg);
  }

  constructor(panel, extensionUri, extCtx, outputChannel, diagnostics, runtimeManager, mode) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.extCtx = extCtx;
    this.outputChannel = outputChannel;
    this.diagnostics = diagnostics;
    this.runtimeManager = runtimeManager;
    this.mode = SalRunConfigPanel.normalizeMode(mode);
    this.lastArg = undefined;
    this.runtimeSubscription = this.runtimeManager.onDidChange(() => {
      this.postState().catch(() => {});
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.extCtx.subscriptions);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await this._onMessage(message);
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          vscode.window.showErrorMessage(`SAL Run Config: ${msg}`);
        }
      },
      null,
      this.extCtx.subscriptions
    );

    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);
  }

  dispose() {
    if (this.runtimeSubscription) {
      this.runtimeSubscription.dispose();
      this.runtimeSubscription = null;
    }
    if (SalRunConfigPanel.currentPanels[this.mode] === this) {
      SalRunConfigPanel.currentPanels[this.mode] = undefined;
    }
    // panel is already disposed by VSCode at this point
  }

  async _onMessage(message) {
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.postState(message && message.arg ? message.arg : undefined);
        break;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        break;
      case 'openOutput':
        this.outputChannel.show(true);
        break;
      case 'openConfigManager':
        await vscode.commands.executeCommand('sal.openRunConfig', message && message.arg ? message.arg : undefined);
        break;
      case 'openRuntimeDashboard':
        await vscode.commands.executeCommand('sal.openRuntimeDashboard', message && message.arg ? message.arg : undefined);
        break;
      case 'saveConfig':
        await this._saveConfigFromWebview(message);
        await this._toast('Saved SAL settings.');
        await this.postState();
        break;
      case 'run':
        await this._runFromWebview(message);
        break;
      case 'saveNamedConfig':
        await this._saveNamedConfigFromWebview(message);
        await this._toast('Saved run configuration.');
        await this.postState();
        break;
      case 'deleteNamedConfig':
        await this._deleteNamedConfigFromWebview(message);
        await this._toast('Deleted run configuration.');
        await this.postState();
        break;
      case 'runSavedConfigs':
        await this._runSavedConfigsFromWebview(message);
        break;
      case 'cancelRuntimeJob':
        this.runtimeManager.cancelJob(message && message.jobId ? String(message.jobId) : '');
        break;
      case 'clearFinishedRuntimeJobs':
        this.runtimeManager.clearFinishedJobs();
        break;
      default:
        break;
    }
  }

  async _toast(message) {
    try {
      await this.panel.webview.postMessage({ type: 'toast', level: 'info', message: String(message) });
    } catch (_) {
      // ignore
    }
  }

  async postState(arg) {
    if (arg !== undefined) {
      this.lastArg = arg;
    }
    const state = await this._collectState(this.lastArg);
    await this.panel.webview.postMessage({ type: 'state', state });
  }

  _savedConfigsKey() {
    return 'savedRunConfigs';
  }

  _normalizeMessageRunConfig(c) {
    const toolArgsByToolId = {};
    const rawToolArgs = (c && c.toolArgsByToolId && typeof c.toolArgsByToolId === 'object') ? c.toolArgsByToolId : {};
    for (const t of Object.values(TOOLS)) {
      const arr = Array.isArray(rawToolArgs[t.id]) ? rawToolArgs[t.id].map(String) : [];
      toolArgsByToolId[t.id] = arr;
    }
    return {
      binPath: c && c.binPath ? String(c.binPath) : '',
      prependBinPathToPATH: !!(c && c.prependBinPathToPATH),
      salpath: Array.isArray(c && c.salpath) ? c.salpath.map(String) : [],
      extraEnv: (c && c.extraEnv && typeof c.extraEnv === 'object' && !Array.isArray(c.extraEnv)) ? c.extraEnv : {},
      useContextFromFile: !!(c && c.useContextFromFile),
      promptForContextInstantiation: !!(c && c.promptForContextInstantiation),
      alwaysSaveBeforeRun: !!(c && c.alwaysSaveBeforeRun),
      diagnosticsEnable: !!(c && c.diagnosticsEnable),
      commonArgs: Array.isArray(c && c.commonArgs) ? c.commonArgs.map(String) : [],
      toolArgsByToolId
    };
  }

  _readSavedConfigs() {
    const raw = this.extCtx.workspaceState.get(this._savedConfigsKey(), []);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const id = c.id ? String(c.id) : '';
      const toolId = c.toolId ? String(c.toolId) : '';
      if (!id || !toolId || !TOOLS[toolId]) continue;
      out.push({
        id,
        name: c.name ? String(c.name) : `Config ${id}`,
        toolId,
        uri: c.uri ? String(c.uri) : '',
        contextName: c.contextName ? String(c.contextName) : '',
        moduleName: c.moduleName ? String(c.moduleName) : '',
        assertionName: c.assertionName ? String(c.assertionName) : '',
        runWholeContext: !!c.runWholeContext,
        contextInstantiation: c.contextInstantiation ? String(c.contextInstantiation) : '',
        config: this._normalizeMessageRunConfig(c.config || {}),
        createdAt: c.createdAt ? String(c.createdAt) : '',
        updatedAt: c.updatedAt ? String(c.updatedAt) : ''
      });
    }
    out.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
    return out;
  }

  async _writeSavedConfigs(configs) {
    await this.extCtx.workspaceState.update(this._savedConfigsKey(), configs);
  }

  _newConfigId() {
    return `cfg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  async _saveNamedConfigFromWebview(message) {
    const payload = (message && message.configuration) || {};
    const toolId = payload.toolId ? String(payload.toolId) : '';
    if (!toolId || !TOOLS[toolId]) {
      throw new Error('Cannot save configuration: invalid tool.');
    }

    const configId = payload.id ? String(payload.id) : '';
    const all = this._readSavedConfigs();
    const now = new Date().toISOString();
    const existing = configId ? all.find(c => c.id === configId) : null;
    const name = String(payload.name || '').trim()
      || (existing ? existing.name : `New ${TOOLS[toolId].exe} config`);

    const saved = {
      id: existing ? existing.id : this._newConfigId(),
      name,
      toolId,
      uri: payload.uri ? String(payload.uri) : '',
      contextName: payload.contextName ? String(payload.contextName) : '',
      moduleName: payload.moduleName ? String(payload.moduleName) : '',
      assertionName: payload.assertionName ? String(payload.assertionName) : '',
      runWholeContext: !!payload.runWholeContext,
      contextInstantiation: payload.contextInstantiation ? String(payload.contextInstantiation) : '',
      config: this._normalizeMessageRunConfig(payload.config || {}),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    const next = [];
    let replaced = false;
    for (const c of all) {
      if (c.id === saved.id) {
        next.push(saved);
        replaced = true;
      } else {
        next.push(c);
      }
    }
    if (!replaced) next.push(saved);
    await this._writeSavedConfigs(next);
  }

  async _deleteNamedConfigFromWebview(message) {
    const id = message && message.id ? String(message.id) : '';
    if (!id) return;
    const all = this._readSavedConfigs();
    const next = all.filter(c => c.id !== id);
    await this._writeSavedConfigs(next);
  }

  async _runSavedConfigsFromWebview(message) {
    const ids = Array.isArray(message && message.ids) ? message.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return;
    const all = this._readSavedConfigs();
    const byId = new Map(all.map(c => [c.id, c]));

    for (const id of ids) {
      const saved = byId.get(id);
      if (!saved) continue;
      const tool = TOOLS[saved.toolId];
      if (!tool) continue;

      let savedUri = undefined;
      if (saved.uri) {
        try {
          savedUri = vscode.Uri.parse(saved.uri);
        } catch (_) {
          savedUri = undefined;
        }
      }

      const arg = {
        uri: savedUri,
        contextName: saved.contextName || undefined,
        moduleName: saved.moduleName || undefined,
        assertionName: saved.assertionName || undefined,
        runWholeContext: !!saved.runWholeContext
      };

      const c = saved.config || {};
      const overrides = {
        binPath: c.binPath,
        prependBinPathToPATH: c.prependBinPathToPATH,
        salpath: c.salpath,
        extraEnv: c.extraEnv,
        useContextFromFile: c.useContextFromFile,
        promptForContextInstantiation: false,
        alwaysSaveBeforeRun: c.alwaysSaveBeforeRun,
        diagnosticsEnable: c.diagnosticsEnable,
        commonArgs: c.commonArgs,
        toolArgs: (c.toolArgsByToolId && c.toolArgsByToolId[saved.toolId]) ? c.toolArgsByToolId[saved.toolId] : undefined,
        contextInstantiation: saved.contextInstantiation || ''
      };

      const targetSummary = [
        saved.contextName ? `ctx=${saved.contextName}` : '',
        saved.moduleName ? `mod=${saved.moduleName}` : '',
        saved.assertionName ? `assert=${saved.assertionName}` : '',
        saved.runWholeContext ? 'whole-context' : ''
      ].filter(Boolean).join(' ');

      await this.runtimeManager.startJob(this.extCtx, tool, arg, overrides, {
        source: 'saved-config',
        configId: saved.id,
        configName: saved.name,
        targetSummary
      });
    }
  }

  async _collectState(arg) {
    const cfg = getSalConfiguration();

    const config = {
      toolchain: {
        binPath: String(cfg.get('toolchain.binPath') || ''),
        prependBinPathToPATH: !!cfg.get('toolchain.prependBinPathToPATH')
      },
      env: {
        salpath: (cfg.get('env.salpath') || []).map(String),
        extra: cfg.get('env.extra') || {}
      },
      run: {
        useContextFromFile: !!cfg.get('run.useContextFromFile'),
        promptForContextInstantiation: !!cfg.get('run.promptForContextInstantiation'),
        alwaysSaveBeforeRun: !!cfg.get('run.alwaysSaveBeforeRun')
      },
      diagnosticsEnable: !!cfg.get('diagnostics.enable'),
      commonArgs: flattenArgs(cfg.get('common.args') || []),
      toolArgs: {}
    };

    for (const t of Object.values(TOOLS)) {
      config.toolArgs[t.id] = flattenArgs(cfg.get(t.configKey) || []);
    }

    const tools = Object.values(TOOLS).map(t => ({
      id: t.id,
      title: t.title,
      exe: t.exe,
      targetKind: t.targetKind,
      description: t.description
    }));

    // Document context
    const doc = await getDocumentFromArgs(arg);
    let documentInfo = null;
    let lastContextInstantiation = {};
    if (doc) {
      const idx = indexSalDocument(doc);
      documentInfo = {
        uri: doc.uri.toString(),
        fileName: doc.fileName,
        languageId: doc.languageId,
        contexts: idx.contexts.map(c => ({
          name: c.name,
          line: c.line,
          formalParamsRaw: c.formalParamsRaw || '',
          paramNames: parseFormalParamNames(c.formalParamsRaw || '')
        })),
        modules: idx.modules.map(m => ({ name: m.name, line: m.line })),
        assertions: idx.assertions.map(a => ({ name: a.name, kind: a.kind, line: a.line }))
      };

      for (const c of documentInfo.contexts) {
        const key = `contextInstantiation:${c.name}`;
        lastContextInstantiation[c.name] = String(this.extCtx.workspaceState.get(key, ''));
      }
    }

    const preset = {
      toolId: arg && arg.toolId ? String(arg.toolId) : undefined,
      contextName: arg && arg.contextName ? String(arg.contextName) : undefined,
      moduleName: arg && arg.moduleName ? String(arg.moduleName) : undefined,
      assertionName: arg && arg.assertionName ? String(arg.assertionName) : undefined,
      runWholeContext: !!(arg && arg.runWholeContext)
    };

    return {
      tools,
      flagCatalogue: FLAG_CATALOGUE,
      config,
      document: documentInfo,
      lastContextInstantiation,
      savedConfigs: this._readSavedConfigs(),
      runtimeJobs: this.runtimeManager.getSnapshot(),
      ui: { preset, mode: this.mode }
    };
  }

  async _saveConfigFromWebview(message) {
    const cfg = getSalConfiguration();
    const target = message && message.target === 'global'
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;

    const c = (message && message.config) || {};

    // Toolchain
    await cfg.update('toolchain.binPath', String(c.binPath || ''), target);
    await cfg.update('toolchain.prependBinPathToPATH', !!c.prependBinPathToPATH, target);

    // Env
    await cfg.update('env.salpath', Array.isArray(c.salpath) ? c.salpath.map(String) : [], target);
    await cfg.update('env.extra', (c.extraEnv && typeof c.extraEnv === 'object') ? c.extraEnv : {}, target);

    // Run behavior
    await cfg.update('run.useContextFromFile', !!c.useContextFromFile, target);
    await cfg.update('run.promptForContextInstantiation', !!c.promptForContextInstantiation, target);
    await cfg.update('run.alwaysSaveBeforeRun', !!c.alwaysSaveBeforeRun, target);

    // Diagnostics
    await cfg.update('diagnostics.enable', !!c.diagnosticsEnable, target);

    // Args
    await cfg.update('common.args', Array.isArray(c.commonArgs) ? c.commonArgs.map(String) : [], target);

    const toolArgsById = (c.toolArgsByToolId && typeof c.toolArgsByToolId === 'object') ? c.toolArgsByToolId : {};
    for (const t of Object.values(TOOLS)) {
      if (!Object.prototype.hasOwnProperty.call(toolArgsById, t.id)) {
        // skip untouched tools
        continue;
      }
      const arr = Array.isArray(toolArgsById[t.id]) ? toolArgsById[t.id].map(String) : [];
      await cfg.update(t.configKey, arr, target);
    }
  }

  async _runFromWebview(message) {
    const payload = (message && message.run) || {};
    const toolId = String(payload.toolId || '');
    const tool = TOOLS[toolId];
    if (!tool) {
      vscode.window.showErrorMessage(`SAL: Unknown tool '${toolId}'.`);
      return;
    }

    const saveFirst = !!payload.saveFirst;
    if (saveFirst) {
      await this._saveConfigFromWebview({
        type: 'saveConfig',
        target: payload.saveTarget || 'workspace',
        config: payload.config || {}
      });
    }

    const c = payload.config || {};
    const overrides = {
      binPath: c.binPath,
      prependBinPathToPATH: c.prependBinPathToPATH,
      salpath: c.salpath,
      extraEnv: c.extraEnv,
      useContextFromFile: c.useContextFromFile,
      promptForContextInstantiation: c.promptForContextInstantiation,
      alwaysSaveBeforeRun: c.alwaysSaveBeforeRun,
      diagnosticsEnable: c.diagnosticsEnable,
      commonArgs: c.commonArgs,
      toolArgs: (c.toolArgsByToolId && c.toolArgsByToolId[toolId]) ? c.toolArgsByToolId[toolId] : undefined,
      contextInstantiation: payload.contextInstantiation
    };

    const arg = {
      uri: payload.uri ? vscode.Uri.parse(String(payload.uri)) : undefined,
      contextName: payload.contextName ? String(payload.contextName) : undefined,
      moduleName: payload.moduleName ? String(payload.moduleName) : undefined,
      assertionName: payload.assertionName ? String(payload.assertionName) : undefined,
      runWholeContext: !!payload.runWholeContext
    };

    await runCliTool(this.extCtx, this.outputChannel, this.diagnostics, tool, arg, overrides);
  }

  _getHtmlForWebview(webview) {
    const nonce = getNonce();
    const mode = this.mode === 'runtime' ? 'runtime' : 'config';
    const pageTitle = mode === 'runtime' ? 'SAL Runtime Dashboard' : 'SAL Configuration Manager';
    const pageSubtitle = mode === 'runtime'
      ? 'Inspect active solver jobs and launch saved configurations.'
      : 'Create, edit, and save reusable SAL run configurations.';

    // NOTE: We keep everything in one file to make the extension easy to install locally.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${pageTitle}</title>
  <style>
    :root {
      --sal-panel-radius: 10px;
      --sal-panel-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
      --sal-panel-bg: var(--vscode-editorWidget-background);
      --sal-accent: var(--vscode-focusBorder, var(--vscode-button-background));
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at 100% -10%, rgba(120, 120, 120, 0.12), transparent 42%),
        radial-gradient(circle at 0% 0%, rgba(120, 120, 120, 0.08), transparent 28%),
        var(--vscode-editor-background);
      padding: 14px;
      margin: 0;
    }
    .shell {
      max-width: 1180px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--sal-panel-border);
      border-radius: var(--sal-panel-radius);
      background: linear-gradient(
        135deg,
        rgba(127, 127, 127, 0.14),
        rgba(127, 127, 127, 0.05)
      );
    }
    h2 {
      margin: 0;
      font-size: 1.25em;
      letter-spacing: 0.1px;
    }
    .muted { opacity: 0.82; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .col { flex: 1 1 260px; min-width: 240px; }
    label {
      display: block;
      margin: 10px 0 5px;
      font-weight: 500;
    }
    input[type="text"], select, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border, var(--sal-panel-border));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    input[type="text"]:focus,
    select:focus,
    textarea:focus {
      border-color: var(--sal-accent);
      box-shadow: 0 0 0 1px var(--sal-accent);
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      line-height: 1.35;
    }
    .inline {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .inline label { margin: 0; }
    .checkline {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-top: 8px;
    }
    .checkline input[type="checkbox"] {
      margin-top: 2px;
      flex: 0 0 auto;
    }
    button {
      padding: 7px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      transition: filter 0.12s ease, transform 0.12s ease;
    }
    button:hover {
      filter: brightness(1.04);
      transform: translateY(-1px);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    details.panel {
      border: 1px solid var(--sal-panel-border);
      border-radius: var(--sal-panel-radius);
      padding: 0;
      overflow: hidden;
      background: var(--sal-panel-bg);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
    }
    details.panel + details.panel {
      margin-top: 2px;
    }
    summary {
      list-style: none;
      cursor: pointer;
      font-weight: 650;
      padding: 11px 14px;
      background: linear-gradient(
        180deg,
        rgba(127, 127, 127, 0.12),
        rgba(127, 127, 127, 0.04)
      );
      border-bottom: 1px solid transparent;
      position: relative;
      user-select: none;
    }
    summary::-webkit-details-marker { display: none; }
    summary::after {
      content: '▾';
      position: absolute;
      right: 12px;
      top: 10px;
      opacity: 0.7;
      transition: transform 0.16s ease;
      transform: rotate(-90deg);
    }
    details[open] > summary {
      border-bottom-color: var(--sal-panel-border);
    }
    details[open] > summary::after {
      transform: rotate(0deg);
    }
    .panel-body {
      padding: 12px 14px 14px;
    }
    .button-bar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .button-row {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .button-row label {
      margin: 0;
      font-weight: 500;
    }
    .tool-meta {
      padding: 8px 10px;
      border: 1px dashed var(--sal-panel-border);
      border-radius: 6px;
      margin-top: 8px;
      background: var(--vscode-editor-background);
    }
    .tip {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--sal-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .field-card {
      border: 1px solid var(--sal-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .file-pill {
      padding: 7px 10px;
      border-radius: 999px;
      border: 1px solid var(--sal-panel-border);
      background: var(--vscode-editorWidget-background);
      font-size: 0.91em;
      white-space: nowrap;
      max-width: 58%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status {
      padding: 10px 12px;
      border-radius: var(--sal-panel-radius);
      border: 1px solid var(--sal-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .error { color: var(--vscode-errorForeground); }
    .note { margin-top: 6px; font-size: 0.95em; opacity: 0.9; }
    .small { font-size: 0.92em; }
    .hr { height: 1px; background: var(--sal-panel-border); margin: 12px 0; }
    .hero-right {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
    }
    .hero-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .mode-config .runtime-only { display: none !important; }
    .mode-runtime .config-only { display: none !important; }
    .mono { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); }
    .config-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 10px;
    }
    .config-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .config-card {
      border: 1px solid var(--sal-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
      cursor: pointer;
      user-select: none;
    }
    .config-card:hover {
      border-color: var(--sal-accent);
    }
    .config-card.selected {
      border-color: var(--sal-accent);
      box-shadow: 0 0 0 1px var(--sal-accent);
    }
    .config-card-row {
      display: flex;
      gap: 8px;
      justify-content: space-between;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .pill {
      border: 1px solid var(--sal-panel-border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.84em;
      opacity: 0.9;
    }
    .runtime-layout {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 12px;
    }
    .runtime-card {
      border: 1px solid var(--sal-panel-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
      min-height: 220px;
    }
    .runtime-config {
      border: 1px dashed var(--sal-panel-border);
      border-radius: 8px;
      padding: 8px;
      margin-top: 8px;
      background: var(--vscode-editorWidget-background);
    }
    .runtime-config[draggable="true"] {
      cursor: grab;
    }
    .runtime-config-top {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .staging-drop {
      border: 1px dashed var(--sal-panel-border);
      border-radius: 8px;
      padding: 10px;
      min-height: 70px;
      background: var(--vscode-editorWidget-background);
      margin-top: 10px;
    }
    .staging-drop.dragging {
      border-color: var(--sal-accent);
      box-shadow: 0 0 0 1px var(--sal-accent);
    }
    .staging-items {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--sal-panel-border);
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--vscode-editor-background);
      font-size: 0.9em;
    }
    .chip button {
      padding: 1px 6px;
      min-height: 20px;
      border-radius: 999px;
      font-size: 0.82em;
    }
    .jobs-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
      max-height: 430px;
      overflow: auto;
    }
    .job-card {
      border: 1px solid var(--sal-panel-border);
      border-radius: 8px;
      padding: 9px;
      background: var(--vscode-editorWidget-background);
    }
    .job-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .job-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .status-pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.82em;
      border: 1px solid var(--sal-panel-border);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status-running, .status-preparing, .status-cancelling {
      border-color: var(--vscode-debugIcon-startForeground, var(--sal-accent));
    }
    .status-success {
      border-color: var(--vscode-testing-iconPassed, #3d9c4c);
    }
    .status-failed, .status-error, .status-cancelled {
      border-color: var(--vscode-errorForeground);
    }
    @media (max-width: 900px) {
      .hero {
        flex-direction: column;
        align-items: stretch;
      }
      .hero-right {
        align-items: stretch;
      }
      .hero-actions {
        justify-content: flex-start;
      }
      .file-pill {
        max-width: 100%;
      }
      .runtime-layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body class="mode-${mode}">
  <div class="shell">
  <header class="hero">
    <div>
      <h2>${pageTitle}</h2>
      <div class="muted small">${pageSubtitle}</div>
    </div>
    <div class="hero-right">
      <div id="fileInfo" class="file-pill muted small"></div>
      <div class="hero-actions">
        <button id="openConfigViewBtn" class="secondary runtime-only">Open Configuration Manager</button>
        <button id="openRuntimeViewBtn" class="secondary config-only">Open Runtime Dashboard</button>
      </div>
    </div>
  </header>

  <details class="panel config-only" open>
    <summary>Configuration Manager</summary>
    <div class="panel-body">
      <div class="row">
        <div class="col">
          <label for="configName">Configuration name</label>
          <input id="configName" type="text" placeholder="e.g. BMC depth 40" />
        </div>
        <div class="col">
          <label class="muted">Selected configuration</label>
          <div id="selectedConfigMeta" class="tool-meta note muted">No configuration selected.</div>
        </div>
      </div>

      <div class="config-toolbar">
        <button id="newConfigBtn">+ New</button>
        <button id="saveAsConfigBtn">Save as new</button>
        <button id="updateConfigBtn" class="secondary">Update selected</button>
        <button id="deleteConfigBtn" class="secondary">Delete selected</button>
      </div>

      <div class="note muted small" id="configCount">0 configurations</div>
      <div id="configList" class="config-list"></div>
    </div>
  </details>

  <details class="panel config-only" open>
    <summary>Run</summary>
    <div class="panel-body">
    <div class="row">
      <div class="col">
        <label for="toolSelect">Tool</label>
        <select id="toolSelect"></select>
        <div id="toolDesc" class="tool-meta note muted"></div>
      </div>
      <div class="col">
        <label for="contextSelect">Context</label>
        <select id="contextSelect"></select>
        <label for="contextInst">Context instantiation (for parametric contexts)</label>
        <input id="contextInst" type="text" placeholder="e.g. 5,15  (or: bakery{5,15})" />
        <div id="contextInstHint" class="note muted"></div>
      </div>
      <div class="col" id="moduleCol">
        <label for="moduleSelect">Module</label>
        <select id="moduleSelect"></select>
      </div>
      <div class="col" id="assertionCol">
        <label for="assertionSelect">Assertion (THEOREM/LEMMA/CLAIM/...)</label>
        <select id="assertionSelect"></select>
        <div class="checkline">
          <input id="runWholeContext" type="checkbox" />
          <label for="runWholeContext">SMC: run whole context (all assertions)</label>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top:12px">
      <div class="col">
        <div class="button-bar">
          <button id="runBtn">Run now</button>
          <button id="saveBtn" class="secondary">Save settings</button>
          <button id="saveRunBtn">Save & Run</button>
        </div>
        <div class="button-row">
          <label for="saveTarget" class="muted">Save to</label>
          <select id="saveTarget" style="width: 220px; max-width: 100%;">
            <option value="workspace">Workspace</option>
            <option value="global">User</option>
          </select>
          <button id="reloadBtn" class="secondary">Reload from settings</button>
        </div>
        <div class="button-row">
          <button id="openOutputBtn" class="secondary">Open Output</button>
          <button id="openSettingsBtn" class="secondary">Open settings.json</button>
          <button id="refreshBtn" class="secondary">Refresh file index</button>
        </div>
      </div>
    </div>
    </div>
  </details>

  <details class="panel runtime-only" open>
    <summary>Runtime Dashboard</summary>
    <div class="panel-body">
      <div class="runtime-layout">
        <div class="runtime-card">
          <div class="config-card-row">
            <strong>Configurations</strong>
            <span class="muted small">Drag to staging area or multi-select</span>
          </div>
          <div class="config-toolbar">
            <button id="stageSelectedBtn" class="secondary">Stage selected</button>
            <button id="runSelectedNowBtn">Run selected</button>
          </div>
          <div id="runtimeConfigPool"></div>
          <div id="runtimeStaging" class="staging-drop">
            Drop configuration cards here to stage jobs.
            <div id="runtimeStagingItems" class="staging-items"></div>
          </div>
          <div class="config-toolbar">
            <button id="runStagedBtn">Run staged</button>
            <button id="clearStagedBtn" class="secondary">Clear staged</button>
          </div>
        </div>

        <div class="runtime-card">
          <div class="config-card-row">
            <strong>Running / Recent Jobs</strong>
            <div class="inline">
              <button id="clearFinishedJobsBtn" class="secondary">Clear finished</button>
              <button id="refreshRuntimeBtn" class="secondary">Refresh</button>
            </div>
          </div>
          <div id="runtimeJobs" class="jobs-list"></div>
        </div>
      </div>
    </div>
  </details>

  <details class="panel config-only" open>
    <summary>Flags</summary>
    <div class="panel-body">
    <div class="row">
      <div class="col">
        <label for="commonArgs">Common args (one arg per line)</label>
        <textarea id="commonArgs"></textarea>
      </div>
      <div class="col">
        <label for="toolArgs">Tool args (one arg per line)</label>
        <textarea id="toolArgs"></textarea>
      </div>
    </div>

    <div class="hr"></div>

    <div class="row">
      <div class="col">
        <div class="field-card">
        <label>Flag builder</label>
        <div class="row">
          <div class="col" style="min-width: 200px">
            <label for="flagScope">Add to</label>
            <select id="flagScope">
              <option value="tool">Tool args</option>
              <option value="common">Common args</option>
            </select>
          </div>
          <div class="col">
            <label for="flagSelect">Flag</label>
            <select id="flagSelect"></select>
            <div id="flagDesc" class="note muted"></div>
          </div>
          <div class="col" id="flagValueCol">
            <label for="flagValue">Value</label>
            <input id="flagValue" type="text" placeholder="value" />
            <select id="flagEnum" style="display:none"></select>
          </div>
          <div class="col" style="min-width: 140px">
            <label>&nbsp;</label>
            <button id="addFlagBtn">Add flag</button>
          </div>
        </div>
        <div class="tip note muted">Tip: for flags like <code>-l lemma</code>, add <code>-l</code> and <code>lemma</code> as two separate lines (two argv elements).</div>
        </div>
      </div>
    </div>
    </div>
  </details>

  <details class="panel config-only">
    <summary>Environment & Behavior</summary>
    <div class="panel-body">
    <div class="row">
      <div class="col">
        <label for="binPath">SAL bin path (optional)</label>
        <input id="binPath" type="text" placeholder="/path/to/sal-3.3/bin" />
        <div class="checkline">
          <input id="prependBinPath" type="checkbox" />
          <label for="prependBinPath">Prepend binPath to PATH when running tools</label>
        </div>
      </div>
      <div class="col">
        <label for="salpath">Extra SALPATH entries (one path per line)</label>
        <textarea id="salpath"></textarea>
      </div>
    </div>

    <div class="row">
      <div class="col">
        <label for="extraEnv">Extra env (JSON object)</label>
        <textarea id="extraEnv" placeholder='{ "ICS_LICENSE_CERTIFICATE": "/path/to/cert" }'></textarea>
        <div id="extraEnvError" class="note error" style="display:none"></div>
      </div>
      <div class="col">
        <label>Run behavior</label>
        <div class="checkline">
          <input id="useContextFromFile" type="checkbox" />
          <label for="useContextFromFile">Prefer invoking tools using context name (SALPATH) instead of file path</label>
        </div>
        <div class="checkline">
          <input id="promptForInst" type="checkbox" />
          <label for="promptForInst">Prompt for context instantiation (parametric contexts)</label>
        </div>
        <div class="checkline">
          <input id="alwaysSave" type="checkbox" />
          <label for="alwaysSave">Save active file before running</label>
        </div>
        <div class="checkline">
          <input id="diagnosticsEnable" type="checkbox" />
          <label for="diagnosticsEnable">Parse tool output into diagnostics (Problems)</label>
        </div>
      </div>
    </div>
    </div>
  </details>

  <div id="status" class="status muted" style="display:none"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let lastState = null;
    let draft = (vscode.getState() && vscode.getState().draft) ? vscode.getState().draft : null;

    // Elements
    const el = (id) => document.getElementById(id);
    const configName = el('configName');
    const selectedConfigMeta = el('selectedConfigMeta');
    const newConfigBtn = el('newConfigBtn');
    const saveAsConfigBtn = el('saveAsConfigBtn');
    const updateConfigBtn = el('updateConfigBtn');
    const deleteConfigBtn = el('deleteConfigBtn');
    const configCount = el('configCount');
    const configList = el('configList');
    const toolSelect = el('toolSelect');
    const toolDesc = el('toolDesc');
    const contextSelect = el('contextSelect');
    const contextInst = el('contextInst');
    const contextInstHint = el('contextInstHint');
    const moduleCol = el('moduleCol');
    const moduleSelect = el('moduleSelect');
    const assertionCol = el('assertionCol');
    const assertionSelect = el('assertionSelect');
    const runWholeContext = el('runWholeContext');
    const runBtn = el('runBtn');
    const saveBtn = el('saveBtn');
    const saveRunBtn = el('saveRunBtn');
    const saveTarget = el('saveTarget');
    const reloadBtn = el('reloadBtn');
    const openOutputBtn = el('openOutputBtn');
    const openSettingsBtn = el('openSettingsBtn');
    const refreshBtn = el('refreshBtn');
    const commonArgs = el('commonArgs');
    const toolArgs = el('toolArgs');
    const flagScope = el('flagScope');
    const flagSelect = el('flagSelect');
    const flagDesc = el('flagDesc');
    const flagValueCol = el('flagValueCol');
    const flagValue = el('flagValue');
    const flagEnum = el('flagEnum');
    const addFlagBtn = el('addFlagBtn');
    const binPath = el('binPath');
    const prependBinPath = el('prependBinPath');
    const salpath = el('salpath');
    const extraEnv = el('extraEnv');
    const extraEnvError = el('extraEnvError');
    const useContextFromFile = el('useContextFromFile');
    const promptForInst = el('promptForInst');
    const alwaysSave = el('alwaysSave');
    const diagnosticsEnable = el('diagnosticsEnable');
    const fileInfo = el('fileInfo');
    const status = el('status');
    const runtimeConfigPool = el('runtimeConfigPool');
    const runtimeStaging = el('runtimeStaging');
    const runtimeStagingItems = el('runtimeStagingItems');
    const stageSelectedBtn = el('stageSelectedBtn');
    const runSelectedNowBtn = el('runSelectedNowBtn');
    const runStagedBtn = el('runStagedBtn');
    const clearStagedBtn = el('clearStagedBtn');
    const runtimeJobs = el('runtimeJobs');
    const clearFinishedJobsBtn = el('clearFinishedJobsBtn');
    const refreshRuntimeBtn = el('refreshRuntimeBtn');
    const openConfigViewBtn = el('openConfigViewBtn');
    const openRuntimeViewBtn = el('openRuntimeViewBtn');

    const splitLines = (text) => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const joinLines = (arr) => (arr && arr.length) ? arr.join('\n') : '';

    function setStatus(msg, isError=false) {
      const text = String(msg || '').trim();
      if (!text) {
        status.textContent = '';
        status.classList.remove('error');
        status.style.display = 'none';
        return;
      }
      status.style.display = 'block';
      status.textContent = text;
      status.classList.toggle('error', !!isError);
    }

    function ensureDraftFromState(state) {
      if (!draft) {
        draft = {
          selectedToolId: (state.ui && state.ui.preset && state.ui.preset.toolId) || 'smc',
          selectedSavedConfigId: '',
          savedConfigName: '',
          target: {
            contextName: (state.ui && state.ui.preset && state.ui.preset.contextName) || '',
            moduleName: (state.ui && state.ui.preset && state.ui.preset.moduleName) || '',
            assertionName: (state.ui && state.ui.preset && state.ui.preset.assertionName) || '',
            runWholeContext: !!(state.ui && state.ui.preset && state.ui.preset.runWholeContext),
            contextInstantiation: ''
          },
          runtime: {
            selectedConfigIds: [],
            stagedConfigIds: []
          },
          config: {
            binPath: state.config.toolchain.binPath || '',
            prependBinPathToPATH: !!state.config.toolchain.prependBinPathToPATH,
            salpathText: joinLines(state.config.env.salpath || []),
            extraEnvText: JSON.stringify(state.config.env.extra || {}, null, 2),
            useContextFromFile: !!state.config.run.useContextFromFile,
            promptForContextInstantiation: !!state.config.run.promptForContextInstantiation,
            alwaysSaveBeforeRun: !!state.config.run.alwaysSaveBeforeRun,
            diagnosticsEnable: !!state.config.diagnosticsEnable,
            commonArgsText: joinLines(state.config.commonArgs || []),
            toolArgsTextByToolId: {}
          }
        };
        for (const t of state.tools || []) {
          draft.config.toolArgsTextByToolId[t.id] = joinLines((state.config.toolArgs && state.config.toolArgs[t.id]) ? state.config.toolArgs[t.id] : []);
        }
      } else {
        draft.target = draft.target || {};
        draft.target.contextName = draft.target.contextName || '';
        draft.target.moduleName = draft.target.moduleName || '';
        draft.target.assertionName = draft.target.assertionName || '';
        draft.target.runWholeContext = !!draft.target.runWholeContext;
        draft.target.contextInstantiation = draft.target.contextInstantiation || '';

        draft.runtime = draft.runtime || {};
        draft.runtime.selectedConfigIds = Array.isArray(draft.runtime.selectedConfigIds) ? draft.runtime.selectedConfigIds : [];
        draft.runtime.stagedConfigIds = Array.isArray(draft.runtime.stagedConfigIds) ? draft.runtime.stagedConfigIds : [];

        draft.selectedSavedConfigId = draft.selectedSavedConfigId || '';
        draft.savedConfigName = draft.savedConfigName || '';

        // Ensure any new tools have storage
        draft.config.toolArgsTextByToolId = draft.config.toolArgsTextByToolId || {};
        for (const t of state.tools || []) {
          if (!Object.prototype.hasOwnProperty.call(draft.config.toolArgsTextByToolId, t.id)) {
            draft.config.toolArgsTextByToolId[t.id] = joinLines((state.config.toolArgs && state.config.toolArgs[t.id]) ? state.config.toolArgs[t.id] : []);
          }
        }
      }

      const validConfigIds = new Set((state.savedConfigs || []).map(c => c.id));
      draft.runtime.selectedConfigIds = (draft.runtime.selectedConfigIds || []).filter(id => validConfigIds.has(id));
      draft.runtime.stagedConfigIds = (draft.runtime.stagedConfigIds || []).filter(id => validConfigIds.has(id));
      if (draft.selectedSavedConfigId && !validConfigIds.has(draft.selectedSavedConfigId)) {
        draft.selectedSavedConfigId = '';
      }

      vscode.setState({ draft });
    }

    function currentToolId() {
      return draft ? draft.selectedToolId : (toolSelect.value || 'smc');
    }

    function getToolSpec(toolId) {
      if (!lastState || !lastState.tools) return null;
      return lastState.tools.find(t => t.id === toolId) || null;
    }

    function refreshToolSelect(state) {
      const prev = toolSelect.value || (draft ? draft.selectedToolId : 'smc');
      toolSelect.innerHTML = '';
      for (const t of state.tools || []) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.title;
        toolSelect.appendChild(opt);
      }
      const toSelect = (draft && draft.selectedToolId) ? draft.selectedToolId : prev;
      toolSelect.value = toSelect;
    }

    function refreshTargetLists(state) {
      const doc = state.document;
      const ctxs = (doc && doc.contexts) ? doc.contexts : [];
      const mods = (doc && doc.modules) ? doc.modules : [];
      const asrts = (doc && doc.assertions) ? doc.assertions : [];

      const fillSelect = (selectEl, items, labelFn) => {
        const prev = selectEl.value;
        selectEl.innerHTML = '';
        const promptOpt = document.createElement('option');
        promptOpt.value = '';
        promptOpt.textContent = '(Prompt / auto)';
        selectEl.appendChild(promptOpt);
        for (const it of items) {
          const opt = document.createElement('option');
          opt.value = it.name;
          opt.textContent = labelFn ? labelFn(it) : it.name;
          selectEl.appendChild(opt);
        }
        selectEl.value = prev;
      };

      fillSelect(contextSelect, ctxs, (c) => (c.paramNames && c.paramNames.length) ? (c.name + '{…}') : c.name);
      fillSelect(moduleSelect, mods, (m) => m.name);
      fillSelect(assertionSelect, asrts, (a) => a.name + ' : ' + a.kind);

      // Apply draft values if set
      if (draft) {
        if (draft.target && draft.target.contextName !== undefined) contextSelect.value = draft.target.contextName;
        if (draft.target && draft.target.moduleName !== undefined) moduleSelect.value = draft.target.moduleName;
        if (draft.target && draft.target.assertionName !== undefined) assertionSelect.value = draft.target.assertionName;
        runWholeContext.checked = !!(draft.target && draft.target.runWholeContext);
      }

      updateContextInstUI();
    }

    function updateContextInstUI() {
      const doc = lastState ? lastState.document : null;
      const ctxName = contextSelect.value || '';
      const ctx = doc && doc.contexts ? doc.contexts.find(c => c.name === ctxName) : null;
      const isParametric = !!(ctx && ctx.paramNames && ctx.paramNames.length);
      contextInst.disabled = !isParametric;
      contextInstHint.textContent = isParametric
        ? ('Formal params: ' + ctx.paramNames.join(', '))
        : 'Not a parametric context.';

      if (isParametric) {
        // If draft is empty, seed from last instantiation if available
        const current = (draft && draft.target) ? String(draft.target.contextInstantiation || '') : '';
        if (!current) {
          const remembered = lastState && lastState.lastContextInstantiation ? (lastState.lastContextInstantiation[ctxName] || '') : '';
          if (remembered) {
            contextInst.value = remembered;
            if (draft && draft.target) {
              draft.target.contextInstantiation = remembered;
              vscode.setState({ draft });
            }
          }
        }
      }
    }

    function updateToolUI() {
      const toolId = currentToolId();
      const tool = getToolSpec(toolId);
      toolDesc.textContent = tool ? (tool.exe + ' — ' + (tool.description || '')) : '';

      // Show/hide target selectors based on tool kind
      const kind = tool ? tool.targetKind : '';
      moduleCol.style.display = (kind === 'module') ? 'block' : 'none';
      assertionCol.style.display = (kind === 'assertion' || kind === 'assertionOrContext') ? 'block' : 'none';
      runWholeContext.parentElement.style.display = (toolId === 'smc') ? 'flex' : 'none';

      // Load tool args textarea for selected tool
      if (draft && draft.config && draft.config.toolArgsTextByToolId) {
        toolArgs.value = draft.config.toolArgsTextByToolId[toolId] || '';
      } else {
        toolArgs.value = '';
      }

      refreshFlagCatalogue();
    }

    function refreshFlagCatalogue() {
      const toolId = currentToolId();
      const scope = flagScope.value || 'tool';
      const cat = (lastState && lastState.flagCatalogue) ? lastState.flagCatalogue : {};
      const flags = scope === 'common'
        ? (cat.common || [])
        : ((cat[toolId] || []).concat([]));

      const prev = flagSelect.value;
      flagSelect.innerHTML = '';
      for (const f of flags) {
        const opt = document.createElement('option');
        opt.value = f.label;
        opt.textContent = f.label;
        opt.dataset.kind = f.kind;
        opt.dataset.desc = f.desc || '';
        opt.dataset.style = f.style || '';
        opt.dataset.choices = (f.choices || []).join(',');
        flagSelect.appendChild(opt);
      }
      if (prev) flagSelect.value = prev;
      updateFlagValueUI();
    }

    function updateFlagValueUI() {
      const opt = flagSelect.selectedOptions && flagSelect.selectedOptions[0];
      if (!opt) {
        flagDesc.textContent = '';
        flagValueCol.style.display = 'none';
        return;
      }
      const kind = opt.dataset.kind;
      const desc = opt.dataset.desc || '';
      flagDesc.textContent = desc;

      if (kind === 'bool') {
        flagValueCol.style.display = 'none';
        return;
      }

      flagValueCol.style.display = 'block';
      const choices = (opt.dataset.choices || '').split(',').map(s => s.trim()).filter(Boolean);
      if (kind === 'enum' && choices.length) {
        flagEnum.style.display = 'block';
        flagValue.style.display = 'none';
        flagEnum.innerHTML = '';
        for (const c of choices) {
          const o = document.createElement('option');
          o.value = c;
          o.textContent = c;
          flagEnum.appendChild(o);
        }
      } else {
        flagEnum.style.display = 'none';
        flagValue.style.display = 'block';
        flagValue.placeholder = (kind === 'number') ? 'number' : 'value';
      }
    }

    function emitFlagArgs(flagLabel, kind, style, value) {
      if (kind === 'bool') return [flagLabel];
      const v = String(value || '');
      const st = style || (flagLabel.startsWith('-') && !flagLabel.startsWith('--') ? 'separate' : 'equals');
      if (st === 'separate') return [flagLabel, v];
      return [flagLabel + '=' + v];
    }

    function validateExtraEnv() {
      const t = extraEnv.value || '';
      if (!t.trim()) {
        extraEnvError.style.display = 'none';
        return { ok: true, value: {} };
      }
      try {
        const obj = JSON.parse(t);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          throw new Error('Extra env must be a JSON object.');
        }
        extraEnvError.style.display = 'none';
        return { ok: true, value: obj };
      } catch (e) {
        extraEnvError.textContent = 'Extra env JSON error: ' + (e.message || e);
        extraEnvError.style.display = 'block';
        return { ok: false, value: {} };
      }
    }

    function collectConfigForMessage() {
      const extra = validateExtraEnv();
      if (!extra.ok) return null;

      // Persist current tool args into draft
      const toolId = currentToolId();
      if (draft && draft.config && draft.config.toolArgsTextByToolId) {
        draft.config.toolArgsTextByToolId[toolId] = toolArgs.value || '';
      }

      // Persist common args
      if (draft && draft.config) {
        draft.config.commonArgsText = commonArgs.value || '';
      }

      vscode.setState({ draft });

      const toolArgsByToolId = {};
      for (const [tid, text] of Object.entries((draft && draft.config && draft.config.toolArgsTextByToolId) || {})) {
        toolArgsByToolId[tid] = splitLines(text);
      }

      return {
        binPath: binPath.value || '',
        prependBinPathToPATH: !!prependBinPath.checked,
        salpath: splitLines(salpath.value || ''),
        extraEnv: extra.value,
        useContextFromFile: !!useContextFromFile.checked,
        promptForContextInstantiation: !!promptForInst.checked,
        alwaysSaveBeforeRun: !!alwaysSave.checked,
        diagnosticsEnable: !!diagnosticsEnable.checked,
        commonArgs: splitLines(commonArgs.value || ''),
        toolArgsByToolId
      };
    }

    function getSavedConfigs() {
      return (lastState && Array.isArray(lastState.savedConfigs)) ? lastState.savedConfigs : [];
    }

    function findSavedConfigById(id) {
      return getSavedConfigs().find(c => c.id === id) || null;
    }

    function summarizeTarget(t) {
      const parts = [];
      if (t.contextName) parts.push('ctx=' + t.contextName);
      if (t.moduleName) parts.push('mod=' + t.moduleName);
      if (t.assertionName) parts.push('assert=' + t.assertionName);
      if (t.runWholeContext) parts.push('whole-context');
      return parts.length ? parts.join(' | ') : 'auto target';
    }

    function ensureRuntimeArrays() {
      draft.runtime = draft.runtime || {};
      draft.runtime.selectedConfigIds = Array.isArray(draft.runtime.selectedConfigIds) ? draft.runtime.selectedConfigIds : [];
      draft.runtime.stagedConfigIds = Array.isArray(draft.runtime.stagedConfigIds) ? draft.runtime.stagedConfigIds : [];
    }

    function applySavedConfigToDraft(saved) {
      if (!saved || !draft) return;
      ensureRuntimeArrays();
      draft.selectedSavedConfigId = saved.id || '';
      draft.savedConfigName = saved.name || '';
      draft.selectedToolId = saved.toolId || draft.selectedToolId || 'smc';
      draft.target.contextName = saved.contextName || '';
      draft.target.moduleName = saved.moduleName || '';
      draft.target.assertionName = saved.assertionName || '';
      draft.target.runWholeContext = !!saved.runWholeContext;
      draft.target.contextInstantiation = saved.contextInstantiation || '';

      const c = saved.config || {};
      draft.config.binPath = c.binPath || '';
      draft.config.prependBinPathToPATH = !!c.prependBinPathToPATH;
      draft.config.salpathText = joinLines(c.salpath || []);
      draft.config.extraEnvText = JSON.stringify(c.extraEnv || {}, null, 2);
      draft.config.useContextFromFile = !!c.useContextFromFile;
      draft.config.promptForContextInstantiation = !!c.promptForContextInstantiation;
      draft.config.alwaysSaveBeforeRun = !!c.alwaysSaveBeforeRun;
      draft.config.diagnosticsEnable = !!c.diagnosticsEnable;
      draft.config.commonArgsText = joinLines(c.commonArgs || []);
      draft.config.toolArgsTextByToolId = draft.config.toolArgsTextByToolId || {};
      for (const t of (lastState && lastState.tools) || []) {
        const arr = (c.toolArgsByToolId && c.toolArgsByToolId[t.id]) ? c.toolArgsByToolId[t.id] : [];
        draft.config.toolArgsTextByToolId[t.id] = joinLines(arr);
      }

      vscode.setState({ draft });
    }

    function renderConfigManager() {
      const configs = getSavedConfigs();
      const selected = draft.selectedSavedConfigId ? findSavedConfigById(draft.selectedSavedConfigId) : null;
      updateConfigBtn.disabled = !selected;
      deleteConfigBtn.disabled = !selected;
      configCount.textContent = String(configs.length) + (configs.length === 1 ? ' configuration' : ' configurations');

      if (selected) {
        selectedConfigMeta.textContent = selected.name + ' | ' + selected.toolId + ' | ' + summarizeTarget(selected);
      } else {
        selectedConfigMeta.textContent = 'No configuration selected.';
      }

      configName.value = draft.savedConfigName || (selected ? selected.name : '');

      configList.innerHTML = '';
      if (!configs.length) {
        const empty = document.createElement('div');
        empty.className = 'note muted';
        empty.textContent = 'No saved configurations yet. Click + New, tune the editor, then Save as new.';
        configList.appendChild(empty);
        return;
      }

      for (const cfg of configs) {
        const card = document.createElement('div');
        card.className = 'config-card' + (cfg.id === draft.selectedSavedConfigId ? ' selected' : '');
        card.draggable = true;
        card.dataset.configId = cfg.id;

        const row1 = document.createElement('div');
        row1.className = 'config-card-row';
        const title = document.createElement('strong');
        title.textContent = cfg.name;
        const tag = document.createElement('span');
        tag.className = 'pill mono';
        tag.textContent = cfg.toolId;
        row1.appendChild(title);
        row1.appendChild(tag);

        const row2 = document.createElement('div');
        row2.className = 'note muted small';
        row2.textContent = summarizeTarget(cfg);

        card.appendChild(row1);
        card.appendChild(row2);

        card.addEventListener('click', () => {
          draft.selectedSavedConfigId = cfg.id;
          draft.savedConfigName = cfg.name;
          applySavedConfigToDraft(cfg);
          render(lastState);
          setStatus('Loaded configuration: ' + cfg.name);
        });

        card.addEventListener('dragstart', (evt) => {
          if (evt.dataTransfer) {
            evt.dataTransfer.setData('text/plain', cfg.id);
            evt.dataTransfer.effectAllowed = 'copy';
          }
        });

        configList.appendChild(card);
      }
    }

    function isJobActive(status) {
      return status === 'preparing' || status === 'running' || status === 'cancelling';
    }

    function statusClass(status) {
      if (!status) return 'status-pill';
      return 'status-pill status-' + status;
    }

    function formatDuration(ms) {
      if (ms === null || ms === undefined) return '-';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const rem = s % 60;
      if (m < 60) return m + 'm ' + rem + 's';
      const h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }

    function renderRuntimeConfigPool() {
      ensureRuntimeArrays();
      const configs = getSavedConfigs();
      const selectedIds = new Set(draft.runtime.selectedConfigIds || []);
      runtimeConfigPool.innerHTML = '';

      if (!configs.length) {
        const empty = document.createElement('div');
        empty.className = 'note muted';
        empty.textContent = 'Save configurations first, then select and run them here.';
        runtimeConfigPool.appendChild(empty);
        return;
      }

      for (const cfg of configs) {
        const card = document.createElement('div');
        card.className = 'runtime-config';
        card.draggable = true;
        card.dataset.configId = cfg.id;

        const top = document.createElement('div');
        top.className = 'runtime-config-top';

        const left = document.createElement('div');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selectedIds.has(cfg.id);
        check.addEventListener('change', () => {
          ensureRuntimeArrays();
          const s = new Set(draft.runtime.selectedConfigIds || []);
          if (check.checked) s.add(cfg.id);
          else s.delete(cfg.id);
          draft.runtime.selectedConfigIds = Array.from(s);
          vscode.setState({ draft });
        });

        const label = document.createElement('span');
        label.style.marginLeft = '8px';
        label.textContent = cfg.name;
        left.appendChild(check);
        left.appendChild(label);

        const tool = document.createElement('span');
        tool.className = 'pill mono';
        tool.textContent = cfg.toolId;

        top.appendChild(left);
        top.appendChild(tool);

        const target = document.createElement('div');
        target.className = 'note muted small';
        target.textContent = summarizeTarget(cfg);

        card.appendChild(top);
        card.appendChild(target);

        card.addEventListener('dragstart', (evt) => {
          if (evt.dataTransfer) {
            evt.dataTransfer.setData('text/plain', cfg.id);
            evt.dataTransfer.effectAllowed = 'copy';
          }
        });

        runtimeConfigPool.appendChild(card);
      }
    }

    function renderRuntimeStaging() {
      ensureRuntimeArrays();
      const ids = draft.runtime.stagedConfigIds || [];
      runtimeStagingItems.innerHTML = '';
      if (!ids.length) {
        return;
      }
      for (const id of ids) {
        const cfg = findSavedConfigById(id);
        if (!cfg) continue;
        const chip = document.createElement('span');
        chip.className = 'chip';
        const txt = document.createElement('span');
        txt.textContent = cfg.name;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'x';
        removeBtn.addEventListener('click', () => {
          ensureRuntimeArrays();
          draft.runtime.stagedConfigIds = (draft.runtime.stagedConfigIds || []).filter(v => v !== id);
          vscode.setState({ draft });
          renderRuntimeStaging();
        });
        chip.appendChild(txt);
        chip.appendChild(removeBtn);
        runtimeStagingItems.appendChild(chip);
      }
    }

    function renderRuntimeJobs() {
      const jobs = (lastState && Array.isArray(lastState.runtimeJobs)) ? lastState.runtimeJobs : [];
      runtimeJobs.innerHTML = '';
      if (!jobs.length) {
        const empty = document.createElement('div');
        empty.className = 'note muted';
        empty.textContent = 'No runtime jobs yet.';
        runtimeJobs.appendChild(empty);
        return;
      }

      for (const job of jobs) {
        const card = document.createElement('div');
        card.className = 'job-card';

        const head = document.createElement('div');
        head.className = 'job-head';
        const left = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = (job.configName || job.toolId || 'job') + ' (' + job.id + ')';
        const meta = document.createElement('div');
        meta.className = 'note muted small';
        meta.textContent = (job.targetSummary || 'target: auto') + ' | duration: ' + formatDuration(job.durationMs);
        left.appendChild(title);
        left.appendChild(meta);

        const st = document.createElement('span');
        st.className = statusClass(job.status);
        st.textContent = job.status || 'unknown';

        head.appendChild(left);
        head.appendChild(st);

        const cmd = document.createElement('div');
        cmd.className = 'note mono small';
        cmd.textContent = job.commandLine || '';

        const meta2 = document.createElement('div');
        meta2.className = 'note muted small';
        const pid = job.pid ? ('PID ' + job.pid) : 'PID -';
        const exit = (job.exitCode === null || job.exitCode === undefined) ? 'exit -' : ('exit ' + job.exitCode);
        meta2.textContent = pid + ' | ' + exit + (job.error ? (' | ' + job.error) : '');

        const actions = document.createElement('div');
        actions.className = 'job-actions';
        if (isJobActive(job.status)) {
          const stopBtn = document.createElement('button');
          stopBtn.className = 'secondary';
          stopBtn.textContent = 'Stop';
          stopBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'cancelRuntimeJob', jobId: job.id });
          });
          actions.appendChild(stopBtn);
        }
        const outBtn = document.createElement('button');
        outBtn.className = 'secondary';
        outBtn.textContent = 'Open Output';
        outBtn.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
        actions.appendChild(outBtn);

        card.appendChild(head);
        card.appendChild(cmd);
        card.appendChild(meta2);
        card.appendChild(actions);
        runtimeJobs.appendChild(card);
      }
    }

    function collectNamedConfigurationPayload(configId) {
      const cfg = collectConfigForMessage();
      if (!cfg) return null;
      return {
        id: configId || '',
        name: (configName.value || '').trim(),
        toolId: currentToolId(),
        uri: lastState && lastState.document ? lastState.document.uri : '',
        contextName: contextSelect.value || '',
        moduleName: moduleSelect.value || '',
        assertionName: assertionSelect.value || '',
        runWholeContext: !!runWholeContext.checked,
        contextInstantiation: contextInst.value || '',
        config: cfg
      };
    }

    function render(state) {
      lastState = state;
      ensureDraftFromState(state);

      // File info
      if (state.document) {
        fileInfo.textContent = state.document.fileName + '  (' + state.document.languageId + ')';
      } else {
        fileInfo.textContent = 'No active document. Open a .sal file to enable context/module/assertion pickers.';
      }

      refreshToolSelect(state);
      refreshTargetLists(state);

      // Config fields
      binPath.value = draft.config.binPath || '';
      prependBinPath.checked = !!draft.config.prependBinPathToPATH;
      salpath.value = draft.config.salpathText || '';
      extraEnv.value = draft.config.extraEnvText || '';
      useContextFromFile.checked = !!draft.config.useContextFromFile;
      promptForInst.checked = !!draft.config.promptForContextInstantiation;
      alwaysSave.checked = !!draft.config.alwaysSaveBeforeRun;
      diagnosticsEnable.checked = !!draft.config.diagnosticsEnable;
      commonArgs.value = draft.config.commonArgsText || '';

      // Targets
      toolSelect.value = draft.selectedToolId || 'smc';
      contextSelect.value = draft.target.contextName || '';
      moduleSelect.value = draft.target.moduleName || '';
      assertionSelect.value = draft.target.assertionName || '';
      runWholeContext.checked = !!draft.target.runWholeContext;
      contextInst.value = draft.target.contextInstantiation || '';

      updateToolUI();
      renderConfigManager();
      renderRuntimeConfigPool();
      renderRuntimeStaging();
      renderRuntimeJobs();
      setStatus('');
    }

    // --- UI event wiring ---

    openConfigViewBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openConfigManager', arg: lastState && lastState.document ? { uri: lastState.document.uri } : undefined });
    });
    openRuntimeViewBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openRuntimeDashboard', arg: lastState && lastState.document ? { uri: lastState.document.uri } : undefined });
    });

    configName.addEventListener('input', () => {
      if (!draft) return;
      draft.savedConfigName = configName.value || '';
      vscode.setState({ draft });
    });

    newConfigBtn.addEventListener('click', () => {
      if (!draft) return;
      draft.selectedSavedConfigId = '';
      draft.savedConfigName = '';
      configName.value = '';
      vscode.setState({ draft });
      renderConfigManager();
      setStatus('New configuration draft.');
    });

    saveAsConfigBtn.addEventListener('click', () => {
      const payload = collectNamedConfigurationPayload('');
      if (!payload) { setStatus('Fix Extra env JSON before saving configuration.', true); return; }
      vscode.postMessage({ type: 'saveNamedConfig', configuration: payload });
      setStatus('Saving configuration…');
    });

    updateConfigBtn.addEventListener('click', () => {
      const id = draft && draft.selectedSavedConfigId ? draft.selectedSavedConfigId : '';
      if (!id) {
        setStatus('Select a configuration to update.', true);
        return;
      }
      const payload = collectNamedConfigurationPayload(id);
      if (!payload) { setStatus('Fix Extra env JSON before saving configuration.', true); return; }
      vscode.postMessage({ type: 'saveNamedConfig', configuration: payload });
      setStatus('Updating configuration…');
    });

    deleteConfigBtn.addEventListener('click', () => {
      const id = draft && draft.selectedSavedConfigId ? draft.selectedSavedConfigId : '';
      if (!id) {
        setStatus('Select a configuration to delete.', true);
        return;
      }
      vscode.postMessage({ type: 'deleteNamedConfig', id });
      draft.selectedSavedConfigId = '';
      draft.savedConfigName = '';
      vscode.setState({ draft });
      setStatus('Deleting configuration…');
    });

    runtimeStaging.addEventListener('dragover', (evt) => {
      evt.preventDefault();
      runtimeStaging.classList.add('dragging');
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
    });
    runtimeStaging.addEventListener('dragleave', () => {
      runtimeStaging.classList.remove('dragging');
    });
    runtimeStaging.addEventListener('drop', (evt) => {
      evt.preventDefault();
      runtimeStaging.classList.remove('dragging');
      const id = evt.dataTransfer ? evt.dataTransfer.getData('text/plain') : '';
      if (!id) return;
      ensureRuntimeArrays();
      const set = new Set(draft.runtime.stagedConfigIds || []);
      set.add(id);
      draft.runtime.stagedConfigIds = Array.from(set);
      vscode.setState({ draft });
      renderRuntimeStaging();
    });

    stageSelectedBtn.addEventListener('click', () => {
      ensureRuntimeArrays();
      const set = new Set(draft.runtime.stagedConfigIds || []);
      for (const id of (draft.runtime.selectedConfigIds || [])) {
        set.add(id);
      }
      draft.runtime.stagedConfigIds = Array.from(set);
      vscode.setState({ draft });
      renderRuntimeStaging();
      setStatus('Staged ' + String(draft.runtime.stagedConfigIds.length) + ' configuration(s).');
    });

    runSelectedNowBtn.addEventListener('click', () => {
      ensureRuntimeArrays();
      const ids = (draft.runtime.selectedConfigIds || []).slice();
      if (!ids.length) {
        setStatus('Select one or more configurations to run.', true);
        return;
      }
      vscode.postMessage({ type: 'runSavedConfigs', ids });
      setStatus('Starting selected configuration jobs…');
    });

    runStagedBtn.addEventListener('click', () => {
      ensureRuntimeArrays();
      const ids = (draft.runtime.stagedConfigIds || []).slice();
      if (!ids.length) {
        setStatus('Stage one or more configurations first.', true);
        return;
      }
      vscode.postMessage({ type: 'runSavedConfigs', ids });
      setStatus('Starting staged jobs…');
    });

    clearStagedBtn.addEventListener('click', () => {
      ensureRuntimeArrays();
      draft.runtime.stagedConfigIds = [];
      vscode.setState({ draft });
      renderRuntimeStaging();
      setStatus('Cleared staged configurations.');
    });

    clearFinishedJobsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearFinishedRuntimeJobs' });
      setStatus('Clearing finished jobs…');
    });

    refreshRuntimeBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
      setStatus('Refreshing runtime state…');
    });

    toolSelect.addEventListener('change', () => {
      // Save current tool args to draft, then switch
      const prevToolId = currentToolId();
      if (draft && draft.config && draft.config.toolArgsTextByToolId) {
        draft.config.toolArgsTextByToolId[prevToolId] = toolArgs.value || '';
      }
      draft.selectedToolId = toolSelect.value;
      vscode.setState({ draft });
      updateToolUI();
    });

    contextSelect.addEventListener('change', () => {
      if (draft && draft.target) draft.target.contextName = contextSelect.value || '';
      vscode.setState({ draft });
      updateContextInstUI();
    });
    moduleSelect.addEventListener('change', () => {
      if (draft && draft.target) draft.target.moduleName = moduleSelect.value || '';
      vscode.setState({ draft });
    });
    assertionSelect.addEventListener('change', () => {
      if (draft && draft.target) draft.target.assertionName = assertionSelect.value || '';
      vscode.setState({ draft });
    });
    runWholeContext.addEventListener('change', () => {
      if (draft && draft.target) draft.target.runWholeContext = !!runWholeContext.checked;
      vscode.setState({ draft });
    });
    contextInst.addEventListener('input', () => {
      if (draft && draft.target) draft.target.contextInstantiation = contextInst.value || '';
      vscode.setState({ draft });
    });

    // Config fields
    binPath.addEventListener('input', () => { if (draft) { draft.config.binPath = binPath.value || ''; vscode.setState({ draft }); } });
    prependBinPath.addEventListener('change', () => { if (draft) { draft.config.prependBinPathToPATH = !!prependBinPath.checked; vscode.setState({ draft }); } });
    salpath.addEventListener('input', () => { if (draft) { draft.config.salpathText = salpath.value || ''; vscode.setState({ draft }); } });
    extraEnv.addEventListener('input', () => { if (draft) { draft.config.extraEnvText = extraEnv.value || ''; validateExtraEnv(); vscode.setState({ draft }); } });
    useContextFromFile.addEventListener('change', () => { if (draft) { draft.config.useContextFromFile = !!useContextFromFile.checked; vscode.setState({ draft }); } });
    promptForInst.addEventListener('change', () => { if (draft) { draft.config.promptForContextInstantiation = !!promptForInst.checked; vscode.setState({ draft }); } });
    alwaysSave.addEventListener('change', () => { if (draft) { draft.config.alwaysSaveBeforeRun = !!alwaysSave.checked; vscode.setState({ draft }); } });
    diagnosticsEnable.addEventListener('change', () => { if (draft) { draft.config.diagnosticsEnable = !!diagnosticsEnable.checked; vscode.setState({ draft }); } });
    commonArgs.addEventListener('input', () => { if (draft) { draft.config.commonArgsText = commonArgs.value || ''; vscode.setState({ draft }); } });
    toolArgs.addEventListener('input', () => {
      const tid = currentToolId();
      if (draft && draft.config && draft.config.toolArgsTextByToolId) {
        draft.config.toolArgsTextByToolId[tid] = toolArgs.value || '';
        vscode.setState({ draft });
      }
    });

    flagScope.addEventListener('change', refreshFlagCatalogue);
    flagSelect.addEventListener('change', updateFlagValueUI);

    addFlagBtn.addEventListener('click', () => {
      const opt = flagSelect.selectedOptions && flagSelect.selectedOptions[0];
      if (!opt) return;
      const label = opt.value;
      const kind = opt.dataset.kind;
      const style = opt.dataset.style || '';
      let value = '';
      if (kind === 'enum' && flagEnum.style.display !== 'none') {
        value = flagEnum.value;
      } else {
        value = flagValue.value;
      }
      const argv = emitFlagArgs(label, kind, style, value);
      const targetArea = (flagScope.value === 'common') ? commonArgs : toolArgs;
      const existing = splitLines(targetArea.value || '');
      targetArea.value = joinLines(existing.concat(argv));

      // Update draft backing store
      if (flagScope.value === 'common') {
        draft.config.commonArgsText = targetArea.value;
      } else {
        draft.config.toolArgsTextByToolId[currentToolId()] = targetArea.value;
      }
      vscode.setState({ draft });
      setStatus('Added ' + argv.join(' '));
    });

    openSettingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettingsJson' }));
    openOutputBtn.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
    refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    reloadBtn.addEventListener('click', () => {
      draft = null;
      vscode.setState({ draft: null });
      vscode.postMessage({ type: 'refresh' });
      setStatus('Reloading from settings…');
    });

    saveBtn.addEventListener('click', () => {
      const cfg = collectConfigForMessage();
      if (!cfg) { setStatus('Fix Extra env JSON before saving.', true); return; }
      vscode.postMessage({ type: 'saveConfig', target: saveTarget.value || 'workspace', config: cfg });
      setStatus('Saving settings…');
    });

    runBtn.addEventListener('click', () => {
      const cfg = collectConfigForMessage();
      if (!cfg) { setStatus('Fix Extra env JSON before running.', true); return; }
      const toolId = currentToolId();
      const run = {
        toolId,
        uri: lastState && lastState.document ? lastState.document.uri : null,
        contextName: contextSelect.value || '',
        moduleName: moduleSelect.value || '',
        assertionName: assertionSelect.value || '',
        runWholeContext: !!runWholeContext.checked,
        contextInstantiation: contextInst.value || '',
        config: cfg,
        saveFirst: false
      };
      vscode.postMessage({ type: 'run', run });
      setStatus('Running ' + toolId + '…');
    });

    saveRunBtn.addEventListener('click', () => {
      const cfg = collectConfigForMessage();
      if (!cfg) { setStatus('Fix Extra env JSON before running.', true); return; }
      const toolId = currentToolId();
      const run = {
        toolId,
        uri: lastState && lastState.document ? lastState.document.uri : null,
        contextName: contextSelect.value || '',
        moduleName: moduleSelect.value || '',
        assertionName: assertionSelect.value || '',
        runWholeContext: !!runWholeContext.checked,
        contextInstantiation: contextInst.value || '',
        config: cfg,
        saveFirst: true,
        saveTarget: saveTarget.value || 'workspace'
      };
      vscode.postMessage({ type: 'run', run });
      setStatus('Saving & running ' + toolId + '…');
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'state') {
        render(msg.state);
      } else if (msg.type === 'toast') {
        setStatus(msg.message || '');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function normalizeRepoSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^https?:\/\/github\.com\//i, '').replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return '';
  return `${parts[0]}/${parts[1]}`;
}

function splitRepoSlug(repoSlug) {
  const normalized = normalizeRepoSlug(repoSlug);
  if (!normalized) return null;
  const parts = normalized.split('/');
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1], slug: normalized };
}

function getNightlyRepository() {
  const cfg = getSalConfiguration();
  const configured = normalizeRepoSlug(cfg.get('startup.nightlyRepository') || '');
  return configured || DEFAULT_NIGHTLY_REPOSITORY;
}

function getStartupRepositories() {
  const cfg = getSalConfiguration();
  const raw = cfg.get('startup.repositories');
  const repos = Array.isArray(raw) ? raw.map(normalizeRepoSlug).filter(Boolean) : [];
  if (!repos.length) return DEFAULT_STARTUP_REPOSITORIES.slice();
  return dedupePreserveOrder(repos);
}

function githubHeaders(extra) {
  return Object.assign({
    'User-Agent': 'sal-tools-vscode',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }, extra || {});
}

function requestBuffer(url, headers, redirectsLeft) {
  const budget = Number.isInteger(redirectsLeft) ? redirectsLeft : 5;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: headers || {} }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers && res.headers.location) {
        if (budget <= 0) {
          res.resume();
          reject(new Error('Too many redirects.'));
          return;
        }
        const nextUrl = new URL(String(res.headers.location), url).toString();
        res.resume();
        requestBuffer(nextUrl, headers, budget - 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          statusCode: status,
          headers: res.headers || {},
          body: Buffer.concat(chunks)
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

function downloadToFile(url, destinationPath, headers, redirectsLeft) {
  const budget = Number.isInteger(redirectsLeft) ? redirectsLeft : 5;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: headers || {} }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers && res.headers.location) {
        if (budget <= 0) {
          res.resume();
          reject(new Error('Too many redirects while downloading asset.'));
          return;
        }
        const nextUrl = new URL(String(res.headers.location), url).toString();
        res.resume();
        downloadToFile(nextUrl, destinationPath, headers, budget - 1).then(resolve, reject);
        return;
      }

      if (status < 200 || status >= 300) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const msg = Buffer.concat(chunks).toString('utf8').trim() || `HTTP ${status}`;
          reject(new Error(`Download failed (${status}): ${msg}`));
        });
        return;
      }

      const stream = fs.createWriteStream(destinationPath);
      stream.on('error', (e) => reject(e));
      stream.on('finish', () => resolve());
      res.pipe(stream);
    });

    req.on('error', reject);
    req.end();
  });
}

async function githubGetJson(url) {
  const res = await requestBuffer(url, githubHeaders(), 5);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const raw = res.body ? res.body.toString('utf8').trim() : '';
    if (res.statusCode === 403 && /rate limit/i.test(raw)) {
      throw new Error('GitHub API rate limit exceeded. Try again later.');
    }
    throw new Error(`GitHub API request failed (${res.statusCode}): ${raw || 'No response body.'}`);
  }
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    throw new Error(`Failed to parse GitHub API response: ${e.message || e}`);
  }
}

function firstLine(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const line = raw.split(/\r?\n/).find((x) => String(x).trim()) || '';
  return String(line).trim();
}

function summarizeReleaseBody(markdownBody) {
  const lines = String(markdownBody || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  if (!lines.length) return 'No release notes text in nightly release.';
  return lines.slice(0, 6).join(' ');
}

async function fetchNightlyRelease(repoSlug) {
  const parsed = splitRepoSlug(repoSlug);
  if (!parsed) {
    throw new Error(`Invalid nightly repository '${repoSlug}'. Use owner/repo.`);
  }
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/tags/nightly`;
  const release = await githubGetJson(url);
  return {
    repository: parsed.slug,
    tagName: String(release.tag_name || 'nightly'),
    name: String(release.name || release.tag_name || 'nightly'),
    publishedAt: String(release.published_at || ''),
    body: String(release.body || ''),
    summary: summarizeReleaseBody(release.body || ''),
    htmlUrl: String(release.html_url || NIGHTLY_RELEASE_WEB_URL),
    assets: Array.isArray(release.assets) ? release.assets.map((asset) => ({
      id: String(asset.id || ''),
      name: String(asset.name || ''),
      browserDownloadUrl: String(asset.browser_download_url || ''),
      contentType: String(asset.content_type || ''),
      size: Number(asset.size || 0),
      downloadCount: Number(asset.download_count || 0),
      updatedAt: String(asset.updated_at || ''),
      createdAt: String(asset.created_at || '')
    })) : []
  };
}

async function fetchCommitDetail(repoSlug, sha) {
  const parsed = splitRepoSlug(repoSlug);
  if (!parsed) return null;
  const cleanSha = String(sha || '').trim();
  if (!cleanSha) return null;
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${cleanSha}`;
  try {
    const detail = await githubGetJson(url);
    const stats = detail && detail.stats ? detail.stats : {};
    return {
      filesChanged: Number(stats.total || 0),
      additions: Number(stats.additions || 0),
      deletions: Number(stats.deletions || 0)
    };
  } catch (_) {
    return null;
  }
}

async function fetchRecentCommits(repoSlug) {
  const parsed = splitRepoSlug(repoSlug);
  if (!parsed) {
    return { repo: String(repoSlug || ''), error: 'Invalid repository slug.', commits: [] };
  }

  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?per_page=4`;
  try {
    const commits = await githubGetJson(url);
    const list = Array.isArray(commits) ? commits.slice(0, 4) : [];
    const enriched = await Promise.all(list.map(async (commit) => {
      const sha = String(commit && commit.sha ? commit.sha : '');
      const detail = await fetchCommitDetail(parsed.slug, sha);
      const commitInfo = commit && commit.commit ? commit.commit : {};
      const authorInfo = commitInfo.author || {};
      const fallbackUrl = (parsed.slug && sha) ? `https://github.com/${parsed.slug}/commit/${sha}` : '';
      return {
        sha: sha ? sha.slice(0, 7) : '',
        fullSha: sha,
        url: String(commit && commit.html_url ? commit.html_url : fallbackUrl),
        message: firstLine(commitInfo.message || ''),
        author: String(authorInfo.name || ''),
        date: String(authorInfo.date || ''),
        stats: detail
      };
    }));
    return { repo: parsed.slug, error: '', commits: enriched };
  } catch (e) {
    return { repo: parsed.slug, error: String(e && e.message ? e.message : e), commits: [] };
  }
}

function readCachedStartupRemoteData(extCtx) {
  const repos = getStartupRepositories();
  const nightlyRepo = getNightlyRepository();
  const commitsKey = JSON.stringify({ repos });
  const nightlyKey = JSON.stringify({ nightlyRepo });

  const commitsCache = extCtx.globalState.get(STARTUP_COMMITS_CACHE_KEY, null);
  const nightlyCache = extCtx.globalState.get(STARTUP_NIGHTLY_CACHE_KEY, null);

  const commitsData = commitsCache
    && typeof commitsCache === 'object'
    && commitsCache.key === commitsKey
    && commitsCache.data
    ? commitsCache.data
    : null;
  const nightlyData = nightlyCache
    && typeof nightlyCache === 'object'
    && nightlyCache.key === nightlyKey
    && nightlyCache.data
    ? nightlyCache.data
    : null;

  return {
    nightlyRepository: nightlyRepo,
    repositories: repos,
    commitsByRepo: commitsData && Array.isArray(commitsData.commitsByRepo) ? commitsData.commitsByRepo : [],
    commitsError: commitsData ? String(commitsData.commitsError || '') : '',
    commitsFetchedAt: commitsData ? String(commitsData.fetchedAt || '') : '',
    nightly: nightlyData ? (nightlyData.nightly || null) : null,
    nightlyError: nightlyData ? String(nightlyData.nightlyError || '') : '',
    nightlyFetchedAt: nightlyData ? String(nightlyData.fetchedAt || '') : ''
  };
}

async function fetchStartupCommitsData(extCtx, forceRefresh) {
  const repos = getStartupRepositories();
  const key = JSON.stringify({ repos });
  const nowMs = Date.now();
  const cached = extCtx.globalState.get(STARTUP_COMMITS_CACHE_KEY, null);
  if (!forceRefresh && cached && typeof cached === 'object'
      && cached.key === key
      && Number(cached.fetchedAtMs || 0) > (nowMs - STARTUP_COMMITS_CACHE_TTL_MS)
      && cached.data) {
    return cached.data;
  }

  let commitsByRepo = [];
  let commitsError = '';
  try {
    commitsByRepo = await Promise.all(repos.map((repo) => fetchRecentCommits(repo)));
  } catch (e) {
    commitsByRepo = [];
    commitsError = String(e && e.message ? e.message : e);
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    repositories: repos,
    commitsByRepo,
    commitsError
  };

  await extCtx.globalState.update(STARTUP_COMMITS_CACHE_KEY, {
    key,
    fetchedAtMs: nowMs,
    data
  });
  return data;
}

async function fetchStartupNightlyData(extCtx, forceRefresh, options) {
  const opts = options || {};
  const installed = !!opts.installed;
  const nightlyRepo = getNightlyRepository();
  const key = JSON.stringify({ nightlyRepo });
  const nowMs = Date.now();
  const cached = extCtx.globalState.get(STARTUP_NIGHTLY_CACHE_KEY, null);
  const hasValidCache = cached
    && typeof cached === 'object'
    && cached.key === key
    && cached.data;

  if (hasValidCache) {
    const ageMs = Math.max(0, nowMs - Number(cached.fetchedAtMs || 0));
    // Once SAL is installed, keep nightly checks to at most once per week.
    if (installed && ageMs < STARTUP_NIGHTLY_INSTALLED_CHECK_TTL_MS) {
      return cached.data;
    }
    if (!installed && !forceRefresh && ageMs < STARTUP_NIGHTLY_CACHE_TTL_MS) {
      return cached.data;
    }
  }

  let nightly = null;
  let nightlyError = '';
  try {
    nightly = await fetchNightlyRelease(nightlyRepo);
  } catch (e) {
    nightlyError = String(e && e.message ? e.message : e);
    if (hasValidCache && cached.data && cached.data.nightly) {
      return Object.assign({}, cached.data, {
        nightlyError: nightlyError
      });
    }
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    nightlyRepository: nightlyRepo,
    nightly,
    nightlyError
  };
  await extCtx.globalState.update(STARTUP_NIGHTLY_CACHE_KEY, {
    key,
    fetchedAtMs: nowMs,
    data
  });
  return data;
}

function readRecentSalFiles(extCtx) {
  const raw = extCtx.globalState.get(RECENT_SAL_FILES_KEY, []);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = String(entry.path || '').trim();
    if (!p) continue;
    out.push({
      path: p,
      name: String(entry.name || path.basename(p)),
      workspacePath: String(entry.workspacePath || ''),
      workspaceName: String(entry.workspaceName || ''),
      lastTouchedAt: String(entry.lastTouchedAt || ''),
      lastEvent: String(entry.lastEvent || '')
    });
  }
  out.sort((a, b) => {
    const ta = a.lastTouchedAt ? Date.parse(a.lastTouchedAt) : 0;
    const tb = b.lastTouchedAt ? Date.parse(b.lastTouchedAt) : 0;
    return tb - ta;
  });
  return out.slice(0, MAX_RECENT_SAL_FILES);
}

async function rememberRecentSalFile(extCtx, filePath, eventType) {
  const absPath = String(filePath || '').trim();
  if (!absPath) return;
  const now = new Date().toISOString();
  let workspacePath = '';
  let workspaceName = '';
  try {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
    if (folder && folder.uri && folder.uri.fsPath) {
      workspacePath = folder.uri.fsPath;
      workspaceName = folder.name || path.basename(folder.uri.fsPath);
    }
  } catch (_) {
    // ignore workspace resolution failures
  }

  const existing = readRecentSalFiles(extCtx);
  const eventName = String(eventType || 'opened');
  const existingIndex = existing.findIndex((item) => path.resolve(item.path) === path.resolve(absPath));
  const newEntry = {
    path: absPath,
    name: path.basename(absPath),
    workspacePath,
    workspaceName,
    lastTouchedAt: now,
    lastEvent: eventName
  };

  let next = [];
  if (existingIndex >= 0 && eventName === 'opened') {
    // Keep ordering stable for open events; save events define "recently updated" priority.
    next = existing.slice();
    const prev = next[existingIndex] || {};
    next[existingIndex] = Object.assign({}, prev, {
      workspacePath,
      workspaceName,
      lastEvent: prev.lastEvent || eventName
    });
  } else {
    next = [newEntry];
    for (const item of existing) {
      if (path.resolve(item.path) === path.resolve(absPath)) continue;
      next.push(item);
    }
  }
  await extCtx.globalState.update(RECENT_SAL_FILES_KEY, next.slice(0, MAX_RECENT_SAL_FILES));
  if (SalStartupPanel.currentPanel) {
    SalStartupPanel.currentPanel.postState(false).catch(() => {});
  }
}

async function maybeTrackRecentSalFile(extCtx, document, eventType) {
  if (!document) return;
  if (document.isUntitled) return;
  const isSalDoc = document.languageId === 'sal' || String(document.fileName || '').toLowerCase().endsWith('.sal');
  if (!isSalDoc) return;
  await rememberRecentSalFile(extCtx, document.fileName, eventType || 'opened');
}

function isPathWithin(parentPath, candidatePath) {
  const parent = path.resolve(String(parentPath || ''));
  const child = path.resolve(String(candidatePath || ''));
  if (!parent || !child) return false;
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function getManagedNightlyInstallRoot(extCtx) {
  return path.join(extCtx.globalStorageUri.fsPath, 'nightly');
}

function isManagedNightlyBinPath(extCtx, binPath) {
  if (!binPath) return false;
  return isPathWithin(getManagedNightlyInstallRoot(extCtx), binPath);
}

function hasSalSmcInBinPath(binPath) {
  const dir = String(binPath || '').trim();
  if (!dir) return false;
  const candidates = process.platform === 'win32'
    ? ['sal-smc.exe', 'sal-smc.cmd', 'sal-smc.bat', 'sal-smc']
    : ['sal-smc'];
  return candidates.some((name) => fs.existsSync(path.join(dir, name)));
}

function pickNightlyAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  if (!list.length) return null;

  const osTokens = process.platform === 'win32'
    ? ['windows', 'win32', 'win', 'mingw']
    : process.platform === 'darwin'
      ? ['darwin', 'mac', 'osx', 'macos']
      : ['linux', 'gnu', 'ubuntu'];
  const archTokens = process.arch === 'arm64'
    ? ['arm64', 'aarch64']
    : ['x86_64', 'amd64', 'x64'];
  const extWeight = (name) => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 3;
    if (lower.endsWith('.zip')) return 2;
    if (lower.endsWith('.tar')) return 1;
    return 0;
  };

  const candidates = list
    .filter((asset) => asset && asset.browserDownloadUrl && asset.name)
    .filter((asset) => !/source\s*code/i.test(String(asset.name)));

  if (!candidates.length) return null;

  const scored = candidates.map((asset) => {
    const name = String(asset.name || '').toLowerCase();
    let score = extWeight(name);
    if (osTokens.some((token) => name.includes(token))) score += 5;
    if (archTokens.some((token) => name.includes(token))) score += 3;
    if (name.includes('nightly')) score += 1;
    return { asset, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].asset;
}

function execFilePromise(command, args, opts) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, opts || {}, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function extractArchive(archivePath, destinationDir) {
  const lower = String(archivePath || '').toLowerCase();
  if (lower.endsWith('.zip')) {
    try {
      await execFilePromise('tar', ['-xf', archivePath, '-C', destinationDir], {});
      return;
    } catch (tarErr) {
      if (process.platform === 'win32') {
        const escapedArchive = String(archivePath).replace(/'/g, "''");
        const escapedDest = String(destinationDir).replace(/'/g, "''");
        await execFilePromise('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDest}' -Force`
        ], {});
        return;
      }
      try {
        await execFilePromise('unzip', ['-oq', archivePath, '-d', destinationDir], {});
      } catch (unzipErr) {
        throw new Error(`Failed to extract ZIP archive (${tarErr.message || tarErr}; ${unzipErr.message || unzipErr}).`);
      }
      return;
    }
  }

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await execFilePromise('tar', ['-xzf', archivePath, '-C', destinationDir], {});
    return;
  }

  if (lower.endsWith('.tar')) {
    await execFilePromise('tar', ['-xf', archivePath, '-C', destinationDir], {});
    return;
  }

  throw new Error(`Unsupported nightly asset format: ${archivePath}`);
}

function findExecutableBinPath(rootDir) {
  const start = String(rootDir || '').trim();
  if (!start || !fs.existsSync(start)) return '';
  const targetNames = process.platform === 'win32'
    ? new Set(['sal-smc.exe', 'sal-smc.cmd', 'sal-smc.bat', 'sal-smc'])
    : new Set(['sal-smc']);

  const queue = [start];
  let visitedDirs = 0;
  while (queue.length) {
    const dir = queue.shift();
    if (!dir) continue;
    visitedDirs += 1;
    if (visitedDirs > 6000) break;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (targetNames.has(entry.name.toLowerCase())) {
          return dir;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '__MACOSX') continue;
        queue.push(full);
      }
    }
  }

  return '';
}

function pruneManagedNightlyInstalls(installRoot, keepPath) {
  if (!installRoot || !fs.existsSync(installRoot)) return;
  let dirs = [];
  try {
    dirs = fs.readdirSync(installRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(installRoot, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch (_) {
          mtimeMs = 0;
        }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (_) {
    return;
  }

  const keep = new Set([path.resolve(String(keepPath || ''))]);
  let keepCount = 0;
  for (const d of dirs) {
    const resolved = path.resolve(d.full);
    if (keep.has(resolved)) {
      keepCount += 1;
      continue;
    }
    if (keepCount < 2) {
      keepCount += 1;
      continue;
    }
    try {
      fs.rmSync(d.full, { recursive: true, force: true });
    } catch (_) {
      // ignore cleanup issues
    }
  }
}

async function installNightlyRelease(extCtx, outputChannel, options) {
  const opts = options || {};
  const configureMode = opts.configureToolchain || 'auto'; // auto | always | never
  const nightlyRepo = getNightlyRepository();
  const release = await fetchNightlyRelease(nightlyRepo);
  const asset = pickNightlyAsset(release.assets);
  if (!asset) {
    throw new Error(`No downloadable nightly asset found for ${process.platform}/${process.arch}.`);
  }

  const globalStorage = extCtx.globalStorageUri.fsPath;
  fs.mkdirSync(globalStorage, { recursive: true });
  const managedRoot = getManagedNightlyInstallRoot(extCtx);
  fs.mkdirSync(managedRoot, { recursive: true });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-nightly-'));
  const archivePath = path.join(tempRoot, asset.name);
  const unpackDir = path.join(tempRoot, 'unpacked');
  fs.mkdirSync(unpackDir, { recursive: true });

  try {
    outputChannel.appendLine(`[nightly] Downloading ${asset.name} from ${asset.browserDownloadUrl}`);
    await downloadToFile(asset.browserDownloadUrl, archivePath, githubHeaders({ Accept: 'application/octet-stream' }), 5);
    outputChannel.appendLine(`[nightly] Extracting ${asset.name}`);
    await extractArchive(archivePath, unpackDir);

    const installDirName = `nightly-${Date.now()}`;
    const installDir = path.join(managedRoot, installDirName);
    fs.mkdirSync(installDir, { recursive: true });
    fs.cpSync(unpackDir, installDir, { recursive: true });

    const finalBinPath = findExecutableBinPath(installDir);
    if (!finalBinPath) {
      throw new Error('Downloaded nightly archive does not contain sal-smc.');
    }

    const cfg = getSalConfiguration();
    const currentBinPath = String(cfg.get('toolchain.binPath') || '').trim();
    const shouldConfigure = configureMode === 'always'
      || (configureMode === 'auto' && (!currentBinPath || isManagedNightlyBinPath(extCtx, currentBinPath)));
    if (shouldConfigure) {
      await cfg.update('toolchain.binPath', finalBinPath, vscode.ConfigurationTarget.Global);
      await cfg.update('toolchain.prependBinPathToPATH', true, vscode.ConfigurationTarget.Global);
    }

    const installState = {
      repository: nightlyRepo,
      tagName: release.tagName,
      publishedAt: release.publishedAt,
      releaseName: release.name,
      htmlUrl: release.htmlUrl,
      assetName: asset.name,
      binPath: finalBinPath,
      installedAt: new Date().toISOString(),
      configuredAsToolchain: shouldConfigure
    };
    await extCtx.globalState.update(NIGHTLY_INSTALLATION_STATE_KEY, installState);
    pruneManagedNightlyInstalls(managedRoot, installDir);

    return { release, asset, binPath: finalBinPath, configured: shouldConfigure };
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {
      // ignore
    }
  }
}

function parseDateFromText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/);
  if (iso && iso[0]) {
    const d = new Date(iso[0]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const named = raw.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+20\d{2}\b/i);
  if (named && named[0]) {
    const d = new Date(named[0]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const slash = raw.match(/\b(\d{1,2}\/\d{1,2}\/20\d{2})\b/);
  if (slash && slash[1]) {
    const d = new Date(slash[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return '';
}

function runCommandCapture(command, args, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs || 5000);
  return new Promise((resolve) => {
    let proc = null;
    let finished = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    try {
      proc = cp.spawn(command, args || [], {
        cwd: opts.cwd,
        env: opts.env || process.env,
        shell: process.platform === 'win32'
      });
    } catch (e) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: String(e && e.message ? e.message : e),
        timedOut: false
      });
      return;
    }

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      try { proc.kill(); } catch (_) { /* ignore */ }
    }, timeoutMs);

    proc.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    proc.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: String(err && err.message ? err.message : err),
        timedOut
      });
    });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: '',
        timedOut
      });
    });
  });
}

async function probeLocalSalBuild(binPath) {
  const cleanBinPath = String(binPath || '').trim();
  const executable = resolveExecutable('sal-smc', cleanBinPath || undefined);
  if (cleanBinPath && !fs.existsSync(executable)) {
    return {
      executablePath: executable,
      versionText: '',
      buildDate: '',
      buildDateSource: '',
      available: false
    };
  }

  const probes = [['--version'], ['-V']];
  for (const argv of probes) {
    const res = await runCommandCapture(executable, argv, { timeoutMs: 4500 });
    if (res.error) continue;
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    const first = firstLine(combined);
    const parsedDate = parseDateFromText(combined);
    if (first || parsedDate) {
      return {
        executablePath: executable,
        versionText: first,
        buildDate: parsedDate,
        buildDateSource: parsedDate ? 'version-output' : '',
        available: true
      };
    }
  }

  if (cleanBinPath && fs.existsSync(executable)) {
    try {
      const stat = fs.statSync(executable);
      return {
        executablePath: executable,
        versionText: '',
        buildDate: stat.mtime.toISOString(),
        buildDateSource: 'binary-mtime',
        available: true
      };
    } catch (_) {
      // ignore
    }
  }

  return {
    executablePath: executable,
    versionText: '',
    buildDate: '',
    buildDateSource: '',
    available: !cleanBinPath
  };
}

async function collectLocalSalStatus(extCtx) {
  const cfg = getSalConfiguration();
  const configuredBinPath = String(cfg.get('toolchain.binPath') || '').trim();
  const installStateRaw = extCtx.globalState.get(NIGHTLY_INSTALLATION_STATE_KEY, null);
  const installState = installStateRaw && typeof installStateRaw === 'object' ? installStateRaw : null;

  let effectiveBinPath = configuredBinPath;
  if (!effectiveBinPath && installState && installState.binPath) {
    effectiveBinPath = String(installState.binPath);
  }

  const probe = await probeLocalSalBuild(effectiveBinPath);
  let buildDate = probe.buildDate || '';
  let buildDateSource = probe.buildDateSource || '';

  if (installState && effectiveBinPath && installState.binPath
      && path.resolve(String(installState.binPath)) === path.resolve(String(effectiveBinPath))
      && installState.publishedAt) {
    buildDate = String(installState.publishedAt);
    buildDateSource = 'managed-nightly';
  }

  return {
    configuredBinPath,
    effectiveBinPath,
    executablePath: probe.executablePath,
    versionText: probe.versionText,
    buildDate,
    buildDateSource,
    available: probe.available,
    managedInstallation: installState
  };
}

function isLocalBuildOutOfDate(localBuildDate, nightlyBuildDate) {
  const localTs = localBuildDate ? Date.parse(localBuildDate) : NaN;
  const nightlyTs = nightlyBuildDate ? Date.parse(nightlyBuildDate) : NaN;
  if (!Number.isFinite(localTs) || !Number.isFinite(nightlyTs)) return false;
  return localTs + 60 * 1000 < nightlyTs;
}

class SalStartupPanel {
  static currentPanel = undefined;

  static createOrShow(extCtx, outputChannel, arg) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    const existing = SalStartupPanel.currentPanel;
    if (existing) {
      existing.panel.reveal(column);
      existing.postState(!!(arg && arg.forceRefresh)).catch(() => {});
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      'salStartupPanel',
      'SAL Startup',
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    const created = new SalStartupPanel(panel, extCtx, outputChannel);
    SalStartupPanel.currentPanel = created;
    created.postState(!!(arg && arg.forceRefresh)).catch(() => {});
    return created;
  }

  constructor(panel, extCtx, outputChannel) {
    this.panel = panel;
    this.extCtx = extCtx;
    this.outputChannel = outputChannel;

    this.panel.onDidDispose(() => this.dispose(), null, this.extCtx.subscriptions);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this._onMessage(msg).catch((e) => {
        const err = String(e && e.message ? e.message : e);
        this._postToast('error', err).catch(() => {});
      }),
      null,
      this.extCtx.subscriptions
    );

    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);
  }

  dispose() {
    if (SalStartupPanel.currentPanel === this) {
      SalStartupPanel.currentPanel = undefined;
    }
  }

  async _postToast(level, message) {
    await this.panel.webview.postMessage({
      type: 'toast',
      level: String(level || 'info'),
      message: String(message || '')
    });
  }

  async _openProjectFolder(projectPath) {
    const raw = String(projectPath || '').trim();
    if (!raw) return;
    if (!fs.existsSync(raw)) {
      throw new Error(`Project folder not found: ${raw}`);
    }
    const uri = vscode.Uri.file(raw);
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
  }

  async _openProjectFile(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return;
    if (!fs.existsSync(raw)) {
      await this._openProjectFolder(path.dirname(raw));
      return;
    }
    const uri = vscode.Uri.file(raw);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async _updateNightlyBuild() {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'SAL: Updating nightly build'
      },
      async () => {
        const result = await installNightlyRelease(this.extCtx, this.outputChannel, { configureToolchain: 'always' });
        await this._postToast('info', `Installed ${result.release.tagName} (${result.asset.name}).`);
      }
    );
    await this.extCtx.globalState.update(STARTUP_NIGHTLY_CACHE_KEY, null);
    await this.postState(true);
  }

  async _collectState(forceRefresh) {
    const local = await collectLocalSalStatus(this.extCtx);
    const remote = readCachedStartupRemoteData(this.extCtx);

    const nightlyBuildDate = remote && remote.nightly ? String(remote.nightly.publishedAt || '') : '';
    const localBuildDate = local ? String(local.buildDate || '') : '';
    const outOfDate = isLocalBuildOutOfDate(localBuildDate, nightlyBuildDate);
    const hasManagedInstall = !!(local && local.managedInstallation && local.managedInstallation.binPath);
    const configuredBinPath = local ? String(local.configuredBinPath || '') : '';
    const configuredPathValid = configuredBinPath ? hasSalSmcInBinPath(configuredBinPath) : false;
    const managedBinPath = hasManagedInstall ? String(local.managedInstallation.binPath || '') : '';
    const managedPathValid = managedBinPath ? hasSalSmcInBinPath(managedBinPath) : false;
    const currentInstallPath = configuredBinPath || managedBinPath || (local ? String(local.effectiveBinPath || '') : '');
    const currentInstallSource = configuredBinPath
      ? 'configured'
      : (managedPathValid ? 'managed-nightly' : 'path');
    const needsConfiguration = configuredBinPath ? !configuredPathValid : !managedPathValid;
    const installed = configuredPathValid || managedPathValid;
    const commitsLoaded = !!((remote && Array.isArray(remote.commitsByRepo) && remote.commitsByRepo.length) || (remote && remote.commitsError));
    const nightlyLoaded = !!((remote && remote.nightly) || (remote && remote.nightlyError));

    return {
      generatedAt: new Date().toISOString(),
      nightlyReleaseUrl: NIGHTLY_RELEASE_WEB_URL,
      recentFiles: readRecentSalFiles(this.extCtx),
      remote,
      remoteMeta: {
        commitsLoaded,
        nightlyLoaded,
        commitsFetchedAt: remote ? String(remote.commitsFetchedAt || '') : '',
        nightlyFetchedAt: remote ? String(remote.nightlyFetchedAt || '') : '',
        installed,
        nightlyCheckCadenceMs: installed ? STARTUP_NIGHTLY_INSTALLED_CHECK_TTL_MS : STARTUP_NIGHTLY_CACHE_TTL_MS
      },
      local,
      versionStatus: {
        localBuildDate,
        nightlyBuildDate,
        outOfDate,
        hasManagedInstall,
        configuredBinPath,
        configuredPathValid,
        managedBinPath,
        managedPathValid,
        currentInstallPath,
        currentInstallSource,
        needsConfiguration
      }
    };
  }

  async _loadCommitsFromGitHub(forceRefresh) {
    await fetchStartupCommitsData(this.extCtx, !!forceRefresh);
    await this.postState(false);
  }

  async _loadNightlyFromGitHub(forceRefresh) {
    const local = await collectLocalSalStatus(this.extCtx);
    const configuredBinPath = String(local && local.configuredBinPath ? local.configuredBinPath : '');
    const configuredPathValid = configuredBinPath ? hasSalSmcInBinPath(configuredBinPath) : false;
    const managedBinPath = local && local.managedInstallation && local.managedInstallation.binPath
      ? String(local.managedInstallation.binPath)
      : '';
    const managedPathValid = managedBinPath ? hasSalSmcInBinPath(managedBinPath) : false;
    const installed = configuredPathValid || managedPathValid;
    await fetchStartupNightlyData(this.extCtx, !!forceRefresh, { installed });
    await this.postState(false);
  }

  async postState(forceRefresh) {
    const state = await this._collectState(!!forceRefresh);
    await this.panel.webview.postMessage({ type: 'state', state });
  }

  async _onMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.postState(message.type === 'refresh');
        break;
      case 'loadCommits':
        await this._loadCommitsFromGitHub(!!(message && message.forceRefresh));
        break;
      case 'loadNightly':
        await this._loadNightlyFromGitHub(!!(message && message.forceRefresh));
        break;
      case 'openProjectFolder':
        await this._openProjectFolder(message.path);
        break;
      case 'openProjectFile':
        await this._openProjectFile(message.path);
        break;
      case 'pickBinPath':
        await pickToolchainBinPathCommand(this.extCtx);
        break;
      case 'openExternal':
        if (message.url) {
          await vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
        }
        break;
      case 'updateNightly':
        await this._updateNightlyBuild();
        break;
      default:
        break;
    }
  }

  _getHtmlForWebview(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>SAL Startup</title>
  <style>
    :root {
      --sal-radius: 10px;
      --sal-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
      --sal-bg: var(--vscode-editorWidget-background);
      --sal-card-bg: var(--vscode-editor-background);
      --sal-warning-bg: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
    }
    body {
      margin: 0;
      padding: 14px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at 90% -10%, rgba(120,120,120,0.12), transparent 40%),
        radial-gradient(circle at 0% 0%, rgba(120,120,120,0.08), transparent 28%),
        var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hero {
      border: 1px solid var(--sal-border);
      border-radius: var(--sal-radius);
      background: linear-gradient(135deg, rgba(127,127,127,0.14), rgba(127,127,127,0.05));
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }
    .hero-title {
      margin: 0;
      font-size: 1.2em;
    }
    .hero-sub {
      margin-top: 4px;
      opacity: 0.85;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    button {
      padding: 6px 11px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.small {
      padding: 2px 7px;
      font-size: 0.9em;
    }
    .warning {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid var(--vscode-editorWarning-foreground);
      border-radius: 8px;
      background: var(--sal-warning-bg);
      padding: 8px 10px;
    }
    .panel {
      border: 1px solid var(--sal-border);
      border-radius: var(--sal-radius);
      background: var(--sal-bg);
      overflow: hidden;
    }
    .panel summary {
      cursor: pointer;
      user-select: none;
      font-weight: 650;
      padding: 10px 12px;
      background: linear-gradient(180deg, rgba(127,127,127,0.12), rgba(127,127,127,0.04));
    }
    .panel .body {
      padding: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .card {
      border: 1px solid var(--sal-border);
      border-radius: 8px;
      background: var(--sal-card-bg);
      padding: 9px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .muted { opacity: 0.8; }
    .small { font-size: 0.9em; }
    .mono { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); }
    .commit-list {
      margin-top: 8px;
      display: grid;
      gap: 7px;
    }
    .commit-line {
      border: 1px dashed var(--sal-border);
      border-radius: 8px;
      padding: 7px 8px;
      background: var(--vscode-editorWidget-background);
    }
    .release-notes {
      max-height: 320px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--sal-border);
      border-radius: 8px;
      background: var(--sal-card-bg);
      padding: 10px;
      margin-top: 8px;
    }
    .status {
      display: none;
      border: 1px solid var(--sal-border);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--sal-bg);
    }
    .status.error {
      border-color: var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
    }
    @media (max-width: 860px) {
      .hero {
        flex-direction: column;
      }
      .actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <h2 class="hero-title">SAL Startup</h2>
        <div class="hero-sub small">Recent projects, latest repository changes, and nightly release status.</div>
        <div id="localInstallInfo" class="small muted" style="margin-top:6px;"></div>
      </div>
      <div class="actions">
        <button id="refreshBtn" class="secondary">Refresh</button>
        <button id="installNightlyBtn">Install / Update Nightly</button>
        <button id="pickBinBtn" class="secondary">Use Existing SAL…</button>
        <button id="openNightlyBtn" class="secondary">Nightly Release</button>
      </div>
    </header>

    <div id="setupBox" class="warning">
      <div id="setupText" class="small"></div>
      <div class="row">
        <button id="setupInstallBtn" class="small">Install Nightly</button>
        <button id="setupPickBtn" class="small secondary">Select Existing SAL</button>
      </div>
    </div>

    <div id="warningBox" class="warning">
      <div id="warningText" class="small"></div>
      <button id="warningUpdateBtn" class="small">Update</button>
    </div>

    <details id="recentFilesPanel" class="panel">
      <summary>Recent SAL Files</summary>
      <div id="recentFiles" class="body grid"></div>
    </details>

    <details id="commitSummaryPanel" class="panel">
      <summary>Latest Commit Changes</summary>
      <div id="commitSummary" class="body grid"></div>
    </details>

    <details id="releaseNotesPanel" class="panel">
      <summary>Nightly Release Notes</summary>
      <div class="body">
        <div id="releaseMeta" class="small muted"></div>
        <div id="releaseSummary" class="small" style="margin-top:6px;"></div>
        <div id="releaseNotes" class="release-notes small mono"></div>
      </div>
    </details>

    <div id="status" class="status small"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = (id) => document.getElementById(id);
    const warningBox = el('warningBox');
    const warningText = el('warningText');
    const warningUpdateBtn = el('warningUpdateBtn');
    const setupBox = el('setupBox');
    const setupText = el('setupText');
    const setupInstallBtn = el('setupInstallBtn');
    const setupPickBtn = el('setupPickBtn');
    const localInstallInfo = el('localInstallInfo');
    const commitSummaryPanel = el('commitSummaryPanel');
    const releaseNotesPanel = el('releaseNotesPanel');
    const recentFiles = el('recentFiles');
    const commitSummary = el('commitSummary');
    const releaseMeta = el('releaseMeta');
    const releaseSummary = el('releaseSummary');
    const releaseNotes = el('releaseNotes');
    const status = el('status');
    const refreshBtn = el('refreshBtn');
    const installNightlyBtn = el('installNightlyBtn');
    const pickBinBtn = el('pickBinBtn');
    const openNightlyBtn = el('openNightlyBtn');
    let currentState = null;
    let commitsRequested = false;
    let nightlyRequested = false;

    function setStatus(message, isError) {
      const msg = String(message || '').trim();
      if (!msg) {
        status.style.display = 'none';
        status.textContent = '';
        status.classList.remove('error');
        return;
      }
      status.style.display = 'block';
      status.textContent = msg;
      status.classList.toggle('error', !!isError);
    }

    function formatDate(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString();
    }

    function renderRecentFiles(state) {
      const files = (state && state.recentFiles) ? state.recentFiles : [];
      recentFiles.innerHTML = '';
      if (!files.length) {
        const empty = document.createElement('div');
        empty.className = 'card muted';
        empty.textContent = 'No recent SAL files yet. Open or save a .sal file to populate this list.';
        recentFiles.appendChild(empty);
        return;
      }

      for (const file of files) {
        const card = document.createElement('div');
        card.className = 'card';

        const top = document.createElement('div');
        top.className = 'row';
        const left = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = file.name || file.path;
        const p = document.createElement('div');
        p.className = 'small mono muted';
        p.textContent = file.path;
        left.appendChild(title);
        left.appendChild(p);
        if (file.workspacePath) {
          const f = document.createElement('div');
          f.className = 'small mono muted';
          f.textContent = 'Workspace: ' + (file.workspaceName || file.workspacePath);
          left.appendChild(f);
        }

        const right = document.createElement('div');
        right.className = 'row';
        const when = document.createElement('span');
        when.className = 'small muted';
        const eventLabel = (file.lastEvent === 'saved') ? 'saved' : 'opened';
        when.textContent = 'Last ' + eventLabel + ': ' + formatDate(file.lastTouchedAt);

        const openFileBtn = document.createElement('button');
        openFileBtn.className = 'small secondary';
        openFileBtn.textContent = 'Open File';
        openFileBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'openProjectFile', path: file.path });
        });
        right.appendChild(when);
        right.appendChild(openFileBtn);
        if (file.workspacePath) {
          const openFolderBtn = document.createElement('button');
          openFolderBtn.className = 'small secondary';
          openFolderBtn.textContent = 'Open Folder';
          openFolderBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openProjectFolder', path: file.workspacePath });
          });
          right.appendChild(openFolderBtn);
        }

        top.appendChild(left);
        top.appendChild(right);
        card.appendChild(top);
        recentFiles.appendChild(card);
      }
    }

    function renderCommitSummary(state) {
      const remote = state ? state.remote : null;
      const meta = state ? state.remoteMeta : null;
      const loaded = !!(meta && meta.commitsLoaded);
      const repos = remote && Array.isArray(remote.commitsByRepo) ? remote.commitsByRepo : [];
      commitSummary.innerHTML = '';
      if (!loaded) {
        const empty = document.createElement('div');
        empty.className = 'card muted';
        empty.textContent = 'Expand this panel to load latest commit data from GitHub.';
        commitSummary.appendChild(empty);
        return;
      }
      if (remote && remote.commitsError) {
        const empty = document.createElement('div');
        empty.className = 'card muted';
        empty.textContent = 'Failed to load commits: ' + remote.commitsError;
        commitSummary.appendChild(empty);
        return;
      }
      if (!repos.length) {
        const empty = document.createElement('div');
        empty.className = 'card muted';
        empty.textContent = 'No commit data available.';
        commitSummary.appendChild(empty);
        return;
      }

      for (const repo of repos) {
        const card = document.createElement('div');
        card.className = 'card';
        const header = document.createElement('div');
        header.className = 'row';
        const h = document.createElement('strong');
        h.textContent = repo.repo || 'repository';
        header.appendChild(h);
        card.appendChild(header);

        if (repo.error) {
          const err = document.createElement('div');
          err.className = 'small muted';
          err.textContent = 'Failed to load commits: ' + repo.error;
          card.appendChild(err);
          commitSummary.appendChild(card);
          continue;
        }

        const list = document.createElement('div');
        list.className = 'commit-list';
        const commits = Array.isArray(repo.commits) ? repo.commits : [];
        if (!commits.length) {
          const none = document.createElement('div');
          none.className = 'small muted';
          none.textContent = 'No recent commits.';
          card.appendChild(none);
        } else {
          for (const c of commits) {
            const row = document.createElement('div');
            row.className = 'commit-line';
            const r1 = document.createElement('div');
            r1.className = 'row';
            const msg = document.createElement('strong');
            msg.textContent = c.message || c.sha || 'commit';
            if (c.url) {
              msg.style.cursor = 'pointer';
              msg.title = 'Open commit in browser';
              msg.addEventListener('click', () => {
                vscode.postMessage({ type: 'openExternal', url: c.url });
              });
            }
            r1.appendChild(msg);
            const actions = document.createElement('div');
            if (c.url) {
              const open = document.createElement('button');
              open.className = 'small secondary';
              open.textContent = c.sha ? ('Commit ' + c.sha) : 'Open Commit';
              open.addEventListener('click', () => {
                vscode.postMessage({ type: 'openExternal', url: c.url });
              });
              actions.appendChild(open);
            }
            r1.appendChild(actions);
            row.appendChild(r1);

            const detail = document.createElement('div');
            detail.className = 'small muted';
            const parts = [];
            if (c.author) parts.push(c.author);
            if (c.date) parts.push(formatDate(c.date));
            if (c.stats) {
              parts.push('files: ' + String(c.stats.filesChanged || 0));
              parts.push('+' + String(c.stats.additions || 0));
              parts.push('-' + String(c.stats.deletions || 0));
            }
            detail.textContent = parts.join(' | ');
            row.appendChild(detail);
            list.appendChild(row);
          }
          card.appendChild(list);
        }
        commitSummary.appendChild(card);
      }

      if (meta && meta.commitsFetchedAt) {
        const foot = document.createElement('div');
        foot.className = 'small muted';
        foot.textContent = 'Last fetched: ' + formatDate(meta.commitsFetchedAt);
        commitSummary.appendChild(foot);
      }
    }

    function renderRelease(state) {
      const remote = state ? state.remote : null;
      const meta = state ? state.remoteMeta : null;
      const release = remote ? remote.nightly : null;
      const loaded = !!(meta && meta.nightlyLoaded);
      if (!loaded) {
        releaseMeta.textContent = 'Expand this panel to load nightly release data from GitHub.';
        releaseSummary.textContent = '';
        releaseNotes.textContent = '';
        return;
      }
      if (remote && remote.nightlyError) {
        releaseMeta.textContent = 'Failed to load nightly release: ' + remote.nightlyError;
        releaseSummary.textContent = '';
        releaseNotes.textContent = '';
        return;
      }
      if (!release) {
        releaseMeta.textContent = 'Nightly release data unavailable.';
        releaseSummary.textContent = '';
        releaseNotes.textContent = '';
        return;
      }

      const parts = [];
      parts.push(release.repository || '');
      parts.push(release.tagName || 'nightly');
      if (release.publishedAt) parts.push('published ' + formatDate(release.publishedAt));
      if (meta && meta.nightlyFetchedAt) parts.push('checked ' + formatDate(meta.nightlyFetchedAt));
      releaseMeta.textContent = parts.filter(Boolean).join(' | ');
      releaseSummary.textContent = release.summary || '';
      releaseNotes.textContent = release.body || 'No release notes text in nightly release.';
    }

    function renderLocalInstallInfo(state) {
      const info = state && state.versionStatus ? state.versionStatus : null;
      if (!info) {
        localInstallInfo.textContent = '';
        return;
      }
      const pathText = info.currentInstallPath ? info.currentInstallPath : 'PATH lookup';
      const source = info.currentInstallSource ? info.currentInstallSource : 'path';
      localInstallInfo.textContent = 'Current SAL location: ' + pathText + ' (' + source + ')';
    }

    function renderSetupWarning(state) {
      const info = state && state.versionStatus ? state.versionStatus : null;
      if (!info || !info.needsConfiguration) {
        setupBox.style.display = 'none';
        setupText.textContent = '';
        return;
      }
      if (info.configuredBinPath && !info.configuredPathValid) {
        setupText.textContent = 'Configured SAL path does not contain sal-smc. Select a valid SAL bin folder or install nightly.';
      } else {
        setupText.textContent = 'SAL is not configured yet. Install nightly or point to an existing SAL bin folder.';
      }
      setupBox.style.display = 'flex';
    }

    function renderVersionWarning(state) {
      const status = state && state.versionStatus ? state.versionStatus : null;
      const local = state && state.local ? state.local : null;
      if (!status || !status.outOfDate) {
        warningBox.style.display = 'none';
        warningText.textContent = '';
        return;
      }
      const localDate = status.localBuildDate ? formatDate(status.localBuildDate) : 'unknown';
      const nightlyDate = status.nightlyBuildDate ? formatDate(status.nightlyBuildDate) : 'unknown';
      const where = local && local.effectiveBinPath ? (' (' + local.effectiveBinPath + ')') : '';
      warningText.textContent = 'Local SAL build is out of sync with nightly. Local: ' + localDate + ' | Nightly: ' + nightlyDate + where;
      warningBox.style.display = 'flex';
    }

    function render(state) {
      currentState = state;
      const remoteMeta = state && state.remoteMeta ? state.remoteMeta : null;
      if (remoteMeta && remoteMeta.commitsLoaded) commitsRequested = true;
      if (remoteMeta && remoteMeta.nightlyLoaded) nightlyRequested = true;
      renderLocalInstallInfo(state);
      renderSetupWarning(state);
      renderVersionWarning(state);
      renderRecentFiles(state);
      renderCommitSummary(state);
      renderRelease(state);
      setStatus('');
    }

    function requestCommits(forceRefresh) {
      if (commitsRequested && !forceRefresh) return;
      commitsRequested = true;
      setStatus('Loading commit data from GitHub…');
      vscode.postMessage({ type: 'loadCommits', forceRefresh: !!forceRefresh });
    }

    function requestNightly(forceRefresh) {
      if (nightlyRequested && !forceRefresh) return;
      nightlyRequested = true;
      setStatus('Loading nightly release data from GitHub…');
      vscode.postMessage({ type: 'loadNightly', forceRefresh: !!forceRefresh });
    }

    commitSummaryPanel.addEventListener('toggle', () => {
      if (commitSummaryPanel.open) {
        requestCommits(false);
      }
    });
    releaseNotesPanel.addEventListener('toggle', () => {
      if (releaseNotesPanel.open) {
        requestNightly(false);
      }
    });

    refreshBtn.addEventListener('click', () => {
      setStatus('Refreshing startup data…');
      vscode.postMessage({ type: 'refresh' });
      if (commitSummaryPanel.open) {
        requestCommits(true);
      }
      if (releaseNotesPanel.open) {
        // Installed setups are still limited to a weekly nightly check.
        requestNightly(true);
      }
    });
    installNightlyBtn.addEventListener('click', () => {
      setStatus('Installing/updating SAL nightly build…');
      vscode.postMessage({ type: 'updateNightly' });
    });
    pickBinBtn.addEventListener('click', () => {
      setStatus('Choose a SAL bin folder…');
      vscode.postMessage({ type: 'pickBinPath' });
    });
    warningUpdateBtn.addEventListener('click', () => {
      setStatus('Updating SAL nightly build…');
      vscode.postMessage({ type: 'updateNightly' });
    });
    setupInstallBtn.addEventListener('click', () => {
      setStatus('Installing/updating SAL nightly build…');
      vscode.postMessage({ type: 'updateNightly' });
    });
    setupPickBtn.addEventListener('click', () => {
      setStatus('Choose a SAL bin folder…');
      vscode.postMessage({ type: 'pickBinPath' });
    });
    openNightlyBtn.addEventListener('click', () => {
      const release = currentState && currentState.remote ? currentState.remote.nightly : null;
      const url = release && release.htmlUrl ? release.htmlUrl : (currentState ? currentState.nightlyReleaseUrl : '');
      if (url) vscode.postMessage({ type: 'openExternal', url });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'state') {
        render(msg.state);
      } else if (msg.type === 'toast') {
        const isError = String(msg.level || '').toLowerCase() === 'error';
        setStatus(msg.message || '', isError);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

// ---------- Commands ----------

async function runCheckerQuickPick(extCtx, outputChannel, diagnostics, arg) {
  // If called from a CodeLens with defaultKind, bias the list to that kind, but still allow all.
  const defaultKind = arg && arg.defaultKind ? String(arg.defaultKind) : undefined;

  const toolItems = Object.values(TOOLS).map(t => ({
    label: t.title,
    description: t.description,
    detail: t.exe,
    toolId: t.id
  }));

  // slight sorting: if defaultKind passed, put tools of that kind first
  toolItems.sort((a, b) => {
    const kindA = TOOLS[a.toolId].targetKind;
    const kindB = TOOLS[b.toolId].targetKind;
    const score = (k) => {
      if (!defaultKind) return 0;
      if (defaultKind === 'assertion' && (k === 'assertion' || k === 'assertionOrContext')) return -1;
      if (defaultKind === 'module' && k === 'module') return -1;
      if (defaultKind === 'context' && k === 'context') return -1;
      return 0;
    };
    return score(kindA) - score(kindB);
  });

  const sel = await vscode.window.showQuickPick(toolItems, {
    title: 'SAL: Pick a tool to run',
    placeHolder: 'Choose a SAL checker/tool…',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!sel) return;
  const tool = TOOLS[sel.toolId];
  await runCliTool(extCtx, outputChannel, diagnostics, tool, arg);
}

async function openInteractive(extCtx, toolKey, arg) {
  const tool = INTERACTIVE_TOOLS[toolKey];
  if (!tool) return;

  const doc = await getDocumentFromArgs(arg);
  const cwd = doc ? path.dirname(doc.fileName) : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || undefined;
  const env = cwd ? buildEnvForDocument(cwd) : Object.assign({}, process.env);

  const term = vscode.window.createTerminal({
    name: tool.title,
    cwd,
    env
  });

  term.show(true);

  // For sal-sim, if we can detect context, start it.
  if (toolKey === 'sim' && doc) {
    const idx = indexSalDocument(doc);
    const ctx = idx.contexts.length ? idx.contexts[0].name : path.basename(doc.fileName, path.extname(doc.fileName));
    term.sendText(`${shellQuote(resolveExecutable(tool.exe))} ${shellQuote(ctx)}`);
  } else {
    term.sendText(shellQuote(resolveExecutable(tool.exe)));
  }
}

async function configureFlagsCommand() {
  const cfg = getSalConfiguration();

  const toolChoices = [
    { label: 'Common (all tools)', key: 'common', configKey: 'common.args' },
    { label: 'sal-wfc', key: 'wfc', configKey: 'tools.wfc.args' },
    { label: 'sal-smc', key: 'smc', configKey: 'tools.smc.args' },
    { label: 'sal-bmc', key: 'bmc', configKey: 'tools.bmc.args' },
    { label: 'sal-inf-bmc', key: 'infBmc', configKey: 'tools.infBmc.args' },
    { label: 'sal-emc', key: 'emc', configKey: 'tools.emc.args' },
    { label: 'sal-wmc', key: 'wmc', configKey: 'tools.wmc.args' },
    { label: 'sal-deadlock-checker', key: 'deadlock', configKey: 'tools.deadlock.args' },
    { label: 'sal-invalid-state-detector', key: 'invalidStates', configKey: 'tools.invalidStates.args' },
    { label: 'sal-path-finder', key: 'pathFinder', configKey: 'tools.pathFinder.args' },
    { label: 'sal-path-explorer', key: 'pathExplorer', configKey: 'tools.pathExplorer.args' },
    { label: 'sal-atg', key: 'atg', configKey: 'tools.atg.args' },
    { label: 'ltl2buchi', key: 'ltl2buchi', configKey: 'tools.ltl2buchi.args' },
    { label: 'sal2bool', key: 'sal2bool', configKey: 'tools.sal2bool.args' }
  ];

  const chosenTool = await vscode.window.showQuickPick(toolChoices, {
    title: 'SAL: Configure flags for…',
    placeHolder: 'Select a tool (or Common)…'
  });

  if (!chosenTool) return;

  const currentArgs = flattenArgs(cfg.get(chosenTool.configKey) || []);

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Add flag…', value: 'add' },
      { label: 'Remove flag…', value: 'remove' },
      { label: 'Clear', value: 'clear' },
      { label: 'Open Settings (JSON)', value: 'openSettings' }
    ],
    { title: `SAL: ${chosenTool.label} flags`, placeHolder: 'Choose an action…' }
  );

  if (!action) return;

  if (action.value === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    return;
  }

  if (action.value === 'clear') {
    await cfg.update(chosenTool.configKey, [], vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`SAL: Cleared ${chosenTool.label} args (workspace settings).`);
    return;
  }

  if (action.value === 'remove') {
    if (currentArgs.length === 0) {
      vscode.window.showInformationMessage('SAL: No args to remove.');
      return;
    }
    const toRemove = await vscode.window.showQuickPick(
      currentArgs.map(a => ({ label: a, picked: false })),
      { canPickMany: true, title: 'Remove which args?', placeHolder: 'Select args to remove…' }
    );
    if (!toRemove) return;
    const removeSet = new Set(toRemove.map(x => x.label));
    const next = currentArgs.filter(a => !removeSet.has(a));
    await cfg.update(chosenTool.configKey, next, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`SAL: Updated ${chosenTool.label} args (workspace settings).`);
    return;
  }

  if (action.value === 'add') {
    const catalog = (FLAG_CATALOGUE[chosenTool.key] || []).concat(FLAG_CATALOGUE.common || []);
    if (catalog.length === 0) {
      const raw = await vscode.window.showInputBox({ prompt: 'Enter an argument to append', placeHolder: '--foo=bar' });
      if (!raw) return;
      const next = currentArgs.concat([raw]);
      await cfg.update(chosenTool.configKey, next, vscode.ConfigurationTarget.Workspace);
      return;
    }

    const pick = await vscode.window.showQuickPick(
      catalog.map(f => ({ label: f.label, description: f.desc, _flag: f })),
      { title: 'Add which flag?', placeHolder: 'Pick a flag…', matchOnDescription: true }
    );

    if (!pick) return;

    const flag = pick._flag;
    let newArgs = [];

    if (flag.kind === 'bool') {
      newArgs = [flag.label];
    } else if (flag.kind === 'number' || flag.kind === 'string') {
      const value = await vscode.window.showInputBox({
        prompt: `Value for ${flag.label}`,
        placeHolder: flag.kind === 'number' ? 'e.g. 10' : 'e.g. kissat',
        validateInput: (v) => {
          if (flag.kind === 'number' && v && isNaN(Number(v))) return 'Enter a number';
          return null;
        }
      });
      if (value === undefined) return;
      newArgs = flagDefToArgs(flag, value);
    } else if (flag.kind === 'enum') {
      const value = await vscode.window.showQuickPick(
        (flag.choices || []).map(c => ({ label: c })),
        { title: `Value for ${flag.label}`, placeHolder: 'Pick a value…' }
      );
      if (!value) return;
      newArgs = flagDefToArgs(flag, value.label);
    } else {
      newArgs = [flag.label];
    }

    const next = currentArgs.concat(newArgs);
    await cfg.update(chosenTool.configKey, next, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`SAL: Added ${newArgs.join(' ')} to ${chosenTool.label} args (workspace settings).`);
  }
}

async function updateNightlyCommand(extCtx, outputChannel) {
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'SAL: Updating nightly build'
      },
      async () => installNightlyRelease(extCtx, outputChannel, { configureToolchain: 'always' })
    );
    await extCtx.globalState.update(STARTUP_NIGHTLY_CACHE_KEY, null);
    if (SalStartupPanel.currentPanel) {
      await SalStartupPanel.currentPanel.postState(true);
    }
    vscode.window.showInformationMessage(
      `SAL: Updated nightly build (${result.release.tagName}, ${result.asset.name}).`
    );
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    outputChannel.appendLine(`[nightly] update failed: ${msg}`);
    vscode.window.showErrorMessage(`SAL: Nightly update failed: ${msg}`);
  }
}

async function pickToolchainBinPathCommand(extCtx) {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this folder as SAL bin path'
  });
  if (!selected || !selected.length) return;

  const chosenPath = selected[0].fsPath;
  if (!chosenPath) return;

  if (!hasSalSmcInBinPath(chosenPath)) {
    const action = await vscode.window.showWarningMessage(
      `No sal-smc executable found under ${chosenPath}. Use this path anyway?`,
      'Use Anyway'
    );
    if (action !== 'Use Anyway') return;
  }

  const cfg = getSalConfiguration();
  await cfg.update('toolchain.binPath', chosenPath, vscode.ConfigurationTarget.Global);
  await cfg.update('toolchain.prependBinPathToPATH', true, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`SAL: toolchain bin path set to ${chosenPath}`);

  if (SalStartupPanel.currentPanel) {
    await SalStartupPanel.currentPanel.postState(true);
  }
}

// ---------- activate/deactivate ----------

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('SAL');
  const diagnostics = vscode.languages.createDiagnosticCollection('sal');
  const runtimeManager = new SalRuntimeManager(outputChannel, diagnostics);

  context.subscriptions.push(outputChannel, diagnostics);

  // CodeLens
  const lensProvider = new SalCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'sal' }, lensProvider)
  );

  // Outline / symbols
  const symbolProvider = new SalDocumentSymbolProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ language: 'sal' }, symbolProvider)
  );

  // Tree view
  const treeProvider = new SalToolsTreeProvider();
  const treeView = vscode.window.createTreeView('salToolsView', { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView);

  // Status bar
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'SAL';
  status.tooltip = 'Run a SAL checker/tool…';
  status.command = 'sal.runChecker';
  context.subscriptions.push(status);

  const updateStatusVisibility = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.languageId === 'sal') {
      status.show();
    } else {
      status.hide();
    }

    // Keep open dashboard panels in sync with the active editor.
    if (editor && editor.document) {
      SalRunConfigPanel.forEachOpenPanel((p) => p.postState({ uri: editor.document.uri }).catch(() => {}));
      maybeTrackRecentSalFile(context, editor.document, 'opened').catch(() => {});
      if (SalStartupPanel.currentPanel) {
        SalStartupPanel.currentPanel.postState(false).catch(() => {});
      }
    }
  };

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    maybeTrackRecentSalFile(context, doc, 'opened').catch(() => {});
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc) {
      SalRunConfigPanel.forEachOpenPanel((p) => p.postState({ uri: doc.uri }).catch(() => {}));
      maybeTrackRecentSalFile(context, doc, 'saved').catch(() => {});
      if (SalStartupPanel.currentPanel) {
        SalStartupPanel.currentPanel.postState(false).catch(() => {});
      }
    }
  }));
  updateStatusVisibility();
  if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
    maybeTrackRecentSalFile(context, vscode.window.activeTextEditor.document, 'opened').catch(() => {});
  }

  // Commands
  context.subscriptions.push(vscode.commands.registerCommand('sal.openStartupPane', (arg) => SalStartupPanel.createOrShow(context, outputChannel, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.updateNightly', () => updateNightlyCommand(context, outputChannel)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.selectToolchainBinPath', () => pickToolchainBinPathCommand(context)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runChecker', (arg) => runCheckerQuickPick(context, outputChannel, diagnostics, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.openRunConfig', (arg) => SalRunConfigPanel.createOrShow(context, context.extensionUri, outputChannel, diagnostics, runtimeManager, 'config', arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.openRuntimeDashboard', (arg) => SalRunConfigPanel.createOrShow(context, context.extensionUri, outputChannel, diagnostics, runtimeManager, 'runtime', arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runWfc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.wfc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runSmc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.smc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runBmc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.bmc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runInfBmc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.infBmc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runEmc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.emc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runWmc', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.wmc, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runDeadlockChecker', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.deadlock, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runInvalidStateDetector', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.invalidStates, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runPathFinder', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.pathFinder, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runPathExplorer', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.pathExplorer, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runAtg', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.atg, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runLtl2Buchi', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.ltl2buchi, arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.runSal2Bool', (arg) => runCliTool(context, outputChannel, diagnostics, TOOLS.sal2bool, arg)));

  context.subscriptions.push(vscode.commands.registerCommand('sal.openSalenv', (arg) => openInteractive(context, 'salenv', arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.openSalenvSafe', (arg) => openInteractive(context, 'salenvSafe', arg)));
  context.subscriptions.push(vscode.commands.registerCommand('sal.openSimulator', (arg) => openInteractive(context, 'sim', arg)));

  context.subscriptions.push(vscode.commands.registerCommand('sal.configureFlags', configureFlagsCommand));

  // Open startup dashboard as soon as the extension is initialized.
  setTimeout(() => {
    SalStartupPanel.createOrShow(context, outputChannel, { forceRefresh: false });
  }, 120);
}

function deactivate() {}

module.exports = { activate, deactivate };
