#!/usr/bin/env node
/*
 * znk-mcp — zero-dependency MCP stdio server for ZNKernel-II.
 *
 * Transport : JSON-RPC 2.0 over stdin/stdout, one JSON object per line
 *             (newline-delimited; the MCP stdio framing).
 * Backend   : the official `znk2_cli` executable, spawned once per tool call
 *             with `--json -` and the request written to stdin.
 * License   : read from the process environment only (ZNK2_LICENSE_FILE,
 *             ZNK2_REVOKE_LIST). Nothing is embedded in this file.
 *
 * This is a TOOL LAYER, not a DeepSeek Harness plugin and not an official
 * DeepSeek/Anthropic product. Any MCP client (DeepSeek-based or otherwise)
 * that can spawn a stdio server can use it.
 */
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// identity / protocol
// ---------------------------------------------------------------------------
const SERVER_NAME = 'znk-mcp';

// The reported serverInfo.version is read from package.json so it can never
// drift from the published package version again (T-0808). If the manifest is
// unreadable the server still starts, but says so instead of inventing a
// version number.
function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === 'string' && parsed.version.trim() !== '') {
      return parsed.version.trim();
    }
  } catch {
    /* fall through to the honest placeholder below */
  }
  return '0.0.0-unknown';
}

const SERVER_VERSION = readPackageVersion();
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// ---------------------------------------------------------------------------
// configuration (environment only)
// ---------------------------------------------------------------------------
function envString(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function envInt(name, fallback, min, max) {
  const raw = envString(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const CLI_PATH = envString('ZNK2_CLI') || 'znk2_cli.exe';
const TIMEOUT_MS = envInt('ZNK2_TIMEOUT_MS', 60_000, 1, 60_000);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // znk2-cli max_request_bytes mirror
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// demo mode (ZNK_DEMO=1)
// ---------------------------------------------------------------------------
// Replays three recorded, self-built sample verdicts so that the three-valued
// contract is visible without a license. Demo mode never spawns znk2_cli,
// never reads a .lic file and never accepts a user file. The recorded rows come
// from the official ZNKernel-II 2.29.1 distribution CLI; see demo/README.md.
const DEMO_MODE = /^(1|true|yes|on)$/i.test(envString('ZNK_DEMO'));
const DEMO_KEYS = ['C01', 'C05', 'C06'];
const DEMO_FILES = {
  C01: 'c01-flange',
  C05: 'c05-pipe-fitting',
  C06: 'c06-thin-wall-box',
};
const DEMO_DIR = path.join(__dirname, 'demo', 'samples');
const DEMO_ALLOWED_TOOLS = ['znk_capabilities', 'znk_adjudicate', 'znk_adjudicate_rules'];
const demoCache = new Map();

function demoSamplePath(key, ext) {
  return path.join(DEMO_DIR, `${DEMO_FILES[key]}${ext}`);
}

// Accept "C01", "c01" or "c01-flange"; anything else is not a demo sample.
function demoKeyFromArg(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  for (const key of DEMO_KEYS) {
    if (value === key.toLowerCase()) return key;
    if (value === DEMO_FILES[key]) return key;
  }
  return null;
}

function loadDemoSample(key) {
  if (demoCache.has(key)) return demoCache.get(key);
  try {
    const parsed = JSON.parse(fs.readFileSync(demoSamplePath(key, '.verdicts.json'), 'utf8'));
    demoCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function demoUnavailable(toolName) {
  return errorEnvelope(
    'DEMO_MODE',
    `znk-mcp is running in demo mode (ZNK_DEMO=1): "${toolName}" needs the ZNKernel-II kernel and a license. ` +
      'Demo mode only replays three built-in samples. Call znk_capabilities for the sample list, or ' +
      'znk_adjudicate with {"sample":"C01"|"C05"|"C06"}. Drop ZNK_DEMO and set ZNK2_CLI + ZNK2_LICENSE_FILE for the full tool set.',
    { mode: 'demo', tools_available: DEMO_ALLOWED_TOOLS },
  );
}

function parseRoots(raw) {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((item) => item.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

const ALLOWED_ROOTS = parseRoots(envString('ZNK2_ALLOWED_ROOTS'));
const REQUESTED_EXPORT_DIR = path.resolve(
  envString('ZNK2_EXPORT_DIR') ||
    (ALLOWED_ROOTS.length > 0
      ? path.join(ALLOWED_ROOTS[0], 'znk_exports')
      : path.join(process.cwd(), 'znk_exports')),
);
const EXPORT_DIR =
  ALLOWED_ROOTS.length > 0 && !pathAllowed(REQUESTED_EXPORT_DIR)
    ? path.join(ALLOWED_ROOTS[0], 'znk_exports')
    : REQUESTED_EXPORT_DIR;
const IMPORT_CACHE_DIR =
  ALLOWED_ROOTS.length > 0
    ? path.join(ALLOWED_ROOTS[0], '.znk-mcp-imports')
    : path.join(os.tmpdir(), 'znk-mcp-imports');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorEnvelope(code, message, extra) {
  return {
    schema: 'znk-mcp/1',
    ok: false,
    error: Object.assign({ code, message, origin: 'znk-mcp' }, extra || {}),
  };
}

function inputError(message, extra) {
  return errorEnvelope('INVALID_ARGUMENT', message, extra);
}

function pathAllowed(candidate) {
  if (ALLOWED_ROOTS.length === 0) return true;
  const win = process.platform === 'win32';
  const child = win ? candidate.toLowerCase() : candidate;
  return ALLOWED_ROOTS.some((root) => {
    const rel = path.relative(win ? root.toLowerCase() : root, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function resolveUserPath(raw, label) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: inputError(`${label} must be a non-empty string path`) };
  }
  let value = raw.trim();
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  const absolute = path.resolve(value);
  if (!pathAllowed(absolute)) {
    return {
      error: errorEnvelope(
        'PATH_NOT_ALLOWED',
        `${label} is outside ZNK2_ALLOWED_ROOTS: ${absolute}`,
        { path: absolute, allowed_roots: ALLOWED_ROOTS },
      ),
    };
  }
  return { path: absolute };
}

// Recipes can carry a `file` (import recipe) or `path` field. When an
// allow-list is configured, walk the whole argument graph so a nested recipe
// cannot bypass it.
function checkRecipeFiles(value, label, seen, depth) {
  const visited = seen || new Set();
  const level = depth === undefined ? 0 : depth;
  if (level > 32 || value === null || typeof value !== 'object') return null;
  if (visited.has(value)) return null;
  visited.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const failure = checkRecipeFiles(value[i], `${label}[${i}]`, visited, level + 1);
      if (failure) return failure;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if ((key === 'file' || key === 'path') && typeof child === 'string' && child.trim() !== '') {
      const resolved = resolveUserPath(child, `${label}.${key}`);
      if (resolved.error) return resolved.error;
    }
    const failure = checkRecipeFiles(child, `${label}.${key}`, visited, level + 1);
    if (failure) return failure;
  }
  return null;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '_');
}

function extensionFor(format) {
  switch ((format || '').toLowerCase()) {
    case 'step':
    case 'stp':
      return '.step';
    case 'stl':
      return '.stl';
    case 'obj':
      return '.obj';
    case 'iges':
    case 'igs':
      return '.iges';
    case 'dxf':
      return '.dxf';
    case 'dwg':
      return '.dwg';
    case 'znk':
      return '.znk';
    default:
      return '.step';
  }
}

function makeImportCacheDir() {
  try {
    fs.mkdirSync(IMPORT_CACHE_DIR, { recursive: true });
  } catch {
    /* the CLI will report a concrete I/O error if the directory is unusable */
  }
}

function cleanupImportCache() {
  makeImportCacheDir();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(IMPORT_CACHE_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('import-')) continue;
    const file = path.join(IMPORT_CACHE_DIR, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      /* best effort only */
    }
  }
}

function writeImportText(text, format) {
  makeImportCacheDir();
  const file = path.join(
    IMPORT_CACHE_DIR,
    `import-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extensionFor(format)}`,
  );
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// znk2_cli bridge
// ---------------------------------------------------------------------------
function parseCliOutput(stdout, stderr) {
  const raw = stdout.trim();
  if (!raw) {
    return {
      parsed: null,
      failure: errorEnvelope(
        'CLI_NO_OUTPUT',
        `znk2_cli produced no stdout${stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 2000)})` : ''}`,
        { cli: CLI_PATH },
      ),
    };
  }
  try {
    return { parsed: JSON.parse(raw), failure: null };
  } catch {
    // Tolerate a stray non-JSON line before/after the envelope.
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return { parsed: JSON.parse(lines[i]), failure: null };
      } catch {
        /* keep trying */
      }
    }
    return {
      parsed: null,
      failure: errorEnvelope(
        'CLI_BAD_JSON',
        'znk2_cli stdout was not valid JSON',
        { cli: CLI_PATH, stdout_tail: raw.slice(-2000) },
      ),
    };
  }
}

function runCli(request, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? TIMEOUT_MS : opts.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let hardTimer = null;
    let timedOut = false;
    let tooLarge = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child = null;

    const finish = (envelope) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(envelope);
    };

    const killChild = () => {
      if (!child) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };

    try {
      child = spawn(CLI_PATH, ['--json', '-'], {
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(
        errorEnvelope('CLI_NOT_FOUND', `cannot spawn znk2_cli: ${error && error.message ? error.message : String(error)}`, {
          cli: CLI_PATH,
        }),
      );
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killChild();
      // Resolve even if the OS never delivers a close event.
      hardTimer = setTimeout(() => {
        finish(
          errorEnvelope('TIMEOUT', `znk2_cli did not finish within ${timeoutMs} ms`, {
            cli: CLI_PATH,
            timeout_ms: timeoutMs,
          }),
        );
      }, 500);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      if (settled || tooLarge) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        killChild();
        return;
      }
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      stderr += chunk.slice(0, MAX_DIAGNOSTIC_BYTES);
    });

    child.stdin.on('error', () => {
      /* EPIPE when the CLI exits early; the close handler reports the cause */
    });

    child.on('error', (error) => {
      finish(
        errorEnvelope('CLI_NOT_FOUND', `cannot spawn znk2_cli: ${error && error.message ? error.message : String(error)}`, {
          cli: CLI_PATH,
        }),
      );
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(
          errorEnvelope('TIMEOUT', `znk2_cli did not finish within ${timeoutMs} ms`, {
            cli: CLI_PATH,
            timeout_ms: timeoutMs,
          }),
        );
        return;
      }
      if (tooLarge) {
        finish(
          errorEnvelope('OUTPUT_TOO_LARGE', `znk2_cli output exceeded ${MAX_OUTPUT_BYTES} bytes`, {
            cli: CLI_PATH,
            limit_bytes: MAX_OUTPUT_BYTES,
          }),
        );
        return;
      }
      const decoded = parseCliOutput(stdout, stderr);
      if (decoded.failure) {
        decoded.failure.exit_code = typeof code === 'number' ? code : null;
        decoded.failure.signal = signal || null;
        finish(decoded.failure);
        return;
      }
      finish(decoded.parsed);
    });

    try {
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    } catch (error) {
      killChild();
      finish(
        errorEnvelope('CLI_STDIN_ERROR', `cannot write to znk2_cli stdin: ${error && error.message ? error.message : String(error)}`, {
          cli: CLI_PATH,
        }),
      );
    }
  });
}

// Serialize CLI calls: the internal license allows max_concurrent=2 and a
// single MCP client rarely needs parallel subprocesses. Serial is predictable.
let cliChain = Promise.resolve();
function runCliQueued(request, options) {
  const next = cliChain.then(
    () => runCli(request, options),
    () => runCli(request, options),
  );
  cliChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// JSON Schema fragments
// ---------------------------------------------------------------------------
const RECIPE_SCHEMA = {
  type: 'object',
  description:
    'Replayable ZNK solid recipe. Accepts either a recipe {kind:"primitive"|"boolean"|"transform"|"import",...} or a whole previous tool result (the CLI unwraps recipe/result.recipe).',
  properties: {
    kind: { type: 'string', enum: ['primitive', 'boolean', 'transform', 'import', 'abi_body'] },
    primitive: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone', 'torus'] },
    op: { type: 'string', enum: ['union', 'subtract', 'intersect'] },
    params: { type: 'object', additionalProperties: true },
    a: { type: 'object', additionalProperties: true },
    b: { type: 'object', additionalProperties: true },
    file: { type: 'string' },
    recipe: { type: 'object', additionalProperties: true },
    result: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
};

const EMPTY_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

// Rule ids from znk2_cli 2.29.1 `capabilities.adjudicate.rules` (20 ids).
// Older kernels expose a subset (2.28.1: the first 10); the enum is static
// because tools/list must answer without spawning the kernel.
const RULE_IDS = [
  'manufacturing/min_wall_thickness',
  'manufacturing/hole_penetration',
  'manufacturing/draft_angle',
  'manufacturing/sliver_face',
  'quality/non_manifold',
  'assembly/interference',
  'manufacturing/blade_thin_section',
  'manufacturing/hole_depth_ratio',
  'manufacturing/sharp_internal_corner',
  'quality/small_feature',
  'manufacturing/undercut',
  'manufacturing/min_hole_diameter',
  'manufacturing/wall_thickness_uniformity',
  'quality/stress_concentration_corner',
  'manufacturing/missing_fillet',
  'manufacturing/bridge_span',
  'manufacturing/overhang_angle',
  'manufacturing/step_height_ratio',
  'manufacturing/residual_wall',
  'quality/opening_radius',
];

const PRIMITIVES = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
const BOOLEAN_OPS = ['union', 'subtract', 'intersect'];
const EXPORT_FORMATS = ['stl', 'obj', 'step'];

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------
async function toolCreate(args) {
  const request = {
    op: 'create',
    primitive: args.primitive,
    params: isObject(args.params) ? args.params : {},
  };
  if (args.tessellate !== undefined) request.tessellate = Boolean(args.tessellate);
  return runCliQueued(request);
}

async function toolBoolean(args) {
  const recipeError = checkRecipeFiles(args.a, 'a') || checkRecipeFiles(args.b, 'b');
  if (recipeError) return recipeError;
  const request = {
    op: 'boolean',
    operation: args.operation,
    a: args.a,
    b: args.b,
  };
  if (args.tessellate !== undefined) request.tessellate = Boolean(args.tessellate);
  return runCliQueued(request);
}

async function toolDescribe(args) {
  const recipeError = checkRecipeFiles(args.solid, 'solid');
  if (recipeError) return recipeError;
  const request = { op: 'describe', solid: args.solid };
  if (args.tessellate !== undefined) request.tessellate = Boolean(args.tessellate);
  return runCliQueued(request);
}

async function toolImport(args) {
  const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
  const hasText = typeof args.text === 'string';
  if (hasPath && hasText) {
    return inputError('znk_import accepts path or text, not both');
  }
  if (!hasPath && !hasText) {
    return inputError('znk_import requires path or text');
  }
  if (hasText && args.text.length === 0) {
    return inputError('znk_import text must not be empty');
  }

  let file;
  let temporary = false;
  if (hasPath) {
    const resolved = resolveUserPath(args.path, 'path');
    if (resolved.error) return resolved.error;
    file = resolved.path;
  } else {
    file = writeImportText(args.text, args.format);
    temporary = true;
  }

  const request = { op: 'import', file };
  if (args.with_mass !== undefined) request.with_mass = Boolean(args.with_mass);
  const envelope = await runCliQueued(request);
  if (envelope && envelope.ok === true && isObject(envelope.result)) {
    const result = envelope.result;
    result.recipe = {
      kind: 'import',
      file,
      format: typeof result.format === 'string' ? result.format : args.format || 'step',
    };
    if (temporary) {
      result.recipe.temporary = true;
      result.recipe.note = 'text import: the server keeps this temporary file for the session/lifetime cache (7-day cleanup)';
    }
  }
  return envelope;
}

function defaultExportPath(format) {
  const ext = extensionFor(format);
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  } catch {
    /* let the CLI report the concrete filesystem error */
  }
  return path.join(
    EXPORT_DIR,
    `znk_${timestamp()}_${crypto.randomBytes(3).toString('hex')}${ext}`,
  );
}

async function toolExport(args) {
  const request = { op: 'export', format: args.format };
  const hasSolid = isObject(args.solid);
  const hasFile = typeof args.file === 'string' && args.file.trim() !== '';
  if (hasSolid && hasFile) {
    return inputError('znk_export accepts solid or file, not both');
  }
  if (hasSolid) {
    const recipeError = checkRecipeFiles(args.solid, 'solid');
    if (recipeError) return recipeError;
    request.solid = args.solid;
  } else if (hasFile) {
    const resolved = resolveUserPath(args.file, 'file');
    if (resolved.error) return resolved.error;
    request.file = resolved.path;
  } else {
    return inputError('znk_export requires a solid recipe or file');
  }

  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const resolved = resolveUserPath(args.path, 'path');
    if (resolved.error) return resolved.error;
    request.path = resolved.path;
  } else {
    request.path = defaultExportPath(args.format);
  }

  if (args.binary !== undefined) request.binary = Boolean(args.binary);
  if (Number.isFinite(Number(args.chord_tol))) request.chord_tol = Number(args.chord_tol);
  if (Number.isFinite(Number(args.angle_tol))) request.angle_tol = Number(args.angle_tol);
  if (typeof args.schema === 'string') request.schema = args.schema;
  if (typeof args.length_unit === 'string') request.length_unit = args.length_unit;
  return runCliQueued(request);
}

// Replay a recorded adjudication. The envelope keeps the CLI shape so a client
// does not need a demo-specific code path; the `demo` block says exactly what
// was and was not executed.
function demoAdjudicate(args) {
  const key = demoKeyFromArg(args.sample);
  if (!key) {
    const hasGeometry = isObject(args.solid) || (typeof args.file === 'string' && args.file.trim() !== '');
    return errorEnvelope(
      'DEMO_MODE_INPUT',
      hasGeometry
        ? 'demo mode does not accept a user file or recipe; demo mode only replays the 3 recorded samples, pass {"sample":"C01"|"C05"|"C06"}'
        : 'demo mode: znk_adjudicate requires {"sample":"C01"|"C05"|"C06"}',
      { mode: 'demo', samples: DEMO_KEYS },
    );
  }
  const recorded = loadDemoSample(key);
  if (!recorded || !isObject(recorded.result)) {
    return errorEnvelope('DEMO_SAMPLE_MISSING', `demo sample ${key} could not be read from package demo/samples`, {
      sample: key,
      expected_file: `demo/samples/${DEMO_FILES[key]}.verdicts.json`,
    });
  }
  const result = Object.assign({}, recorded.result, {
    body: { file: `demo/samples/${DEMO_FILES[key]}.step` },
  });
  return {
    schema: 'znk-mcp/1',
    ok: true,
    mode: 'demo',
    demo: {
      sample: key,
      step: `demo/samples/${DEMO_FILES[key]}.step`,
      replay: true,
      recorded_kernel_version:
        result.trace && typeof result.trace.kernelVersion === 'string' ? result.trace.kernelVersion : null,
      note:
        'Verbatim replay of a recorded znk2_cli adjudicate run. The kernel is not loaded, no license is read, ' +
        'and the rows were not re-computed from your input.',
    },
    result,
  };
}

async function toolAdjudicate(args) {
  if (DEMO_MODE) return demoAdjudicate(args);
  const request = { op: 'adjudicate' };
  const hasSolid = isObject(args.solid);
  const hasFile = typeof args.file === 'string' && args.file.trim() !== '';
  if (hasSolid) {
    const recipeError = checkRecipeFiles(args.solid, 'solid');
    if (recipeError) return recipeError;
    request.solid = args.solid;
  }
  if (hasFile) {
    const resolved = resolveUserPath(args.file, 'file');
    if (resolved.error) return resolved.error;
    request.file = resolved.path;
  }
  if (typeof args.rule === 'string' && args.rule !== '') request.rule = args.rule;
  if (isObject(args.params)) request.params = args.params;
  if (Number.isFinite(Number(args.tolerance))) request.tolerance = Number(args.tolerance);
  if (Array.isArray(args.otherBodies)) {
    for (let i = 0; i < args.otherBodies.length; i += 1) {
      const failure = checkRecipeFiles(args.otherBodies[i], `otherBodies[${i}]`);
      if (failure) return failure;
    }
    request.other_solids = args.otherBodies;
  }
  if (Array.isArray(args.otherFiles)) {
    const files = [];
    for (let i = 0; i < args.otherFiles.length; i += 1) {
      const resolved = resolveUserPath(args.otherFiles[i], `otherFiles[${i}]`);
      if (resolved.error) return resolved.error;
      files.push(resolved.path);
    }
    request.other_files = files;
  }
  return runCliQueued(request);
}

// Demo rule list: derived from the recorded samples so the ids/rule versions a
// user sees here match what znk_adjudicate replays.
function demoRuleList() {
  const byId = new Map();
  for (const key of DEMO_KEYS) {
    const recorded = loadDemoSample(key);
    const rows = recorded && isObject(recorded.result) && Array.isArray(recorded.result.results)
      ? recorded.result.results
      : [];
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || byId.has(row.id)) continue;
      byId.set(row.id, {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        rule_version: row.rule_version,
        description: row.message,
        demo_source: key,
      });
    }
  }
  const rules = Array.from(byId.values());
  return {
    schema: 'znk-mcp/1',
    ok: true,
    mode: 'demo',
    demo: {
      replay: true,
      note: 'Rule metadata extracted from the 3 recorded demo samples; the kernel registry of the recording has 20 rules.',
    },
    result: {
      count: rules.length,
      rules,
      verdicts: ['allow', 'reject', 'cannot_judge'],
    },
  };
}

async function toolAdjudicateRules() {
  if (DEMO_MODE) return demoRuleList();
  return runCliQueued({ op: 'adjudicate', list_rules: true });
}

async function toolTopology(args) {
  if (!isObject(args.solid)) {
    return inputError('znk_topology: solid must be a recipe object');
  }
  const recipeError = checkRecipeFiles(args.solid, 'solid');
  if (recipeError) return recipeError;
  if (args.entity !== undefined || args.entity_id !== undefined) {
    return errorEnvelope(
      1003,
      'znk_topology: entity-level topology (face/edge/vertex geometry + adjacency) is not exposed by znk2_cli 2.28.1; this tool layer is CLI-only and reports body-level counts. Use znk_describe for counts, or the DSH ABI plugin for entity queries.',
      { feature: 'zn2_entity_topology', cli: CLI_PATH },
    );
  }
  const envelope = await runCliQueued({ op: 'describe', solid: args.solid, tessellate: false });
  if (!envelope || envelope.ok !== true || !isObject(envelope.result)) return envelope;
  const described = envelope.result;
  return {
    schema: 'znk-mcp/1',
    ok: true,
    result: {
      source: 'znk2_cli describe',
      revision: null,
      revision_note: 'znk2_cli does not expose zn2_solid_revision; revision is not fabricated.',
      topology: described.topology,
      bbox: described.bbox,
      closed: described.closed,
      volume_source: described.volume_source,
      entity_level: {
        supported: false,
        reason: 'znk2_cli 2.28.1 exposes body-level topology counts only.',
      },
    },
  };
}

async function toolCapabilities() {
  if (DEMO_MODE) {
    const samples = DEMO_KEYS.map((key) => {
      const recorded = loadDemoSample(key);
      const result = recorded && isObject(recorded.result) ? recorded.result : null;
      return {
        sample: key,
        id: `${DEMO_FILES[key]}`,
        step: `demo/samples/${DEMO_FILES[key]}.step`,
        verdict_summary: result ? result.verdict_summary : null,
        recorded_kernel_version:
          result && result.trace && typeof result.trace.kernelVersion === 'string' ? result.trace.kernelVersion : null,
      };
    });
    return {
      schema: 'znk-mcp/1',
      ok: true,
      mode: 'demo',
      demo: {
        enabled: true,
        why:
          'ZNK_DEMO=1 replays 3 recorded read-only samples so the allow/reject/cannot_judge contract is visible ' +
          'without a license. The kernel is not loaded, no .lic file is read and no user file is accepted.',
        samples,
      },
      result: {
        kernel_version: null,
        kernel_note: 'demo mode does not load znk2_cli; recorded_kernel_version says which kernel produced the rows',
        cli_version: null,
        protocol: 'znk-mcp/1',
        tools: TOOLS.length,
        primitives: PRIMITIVES,
        boolean_ops: BOOLEAN_OPS,
        export_formats: EXPORT_FORMATS,
        license: {
          required: false,
          status: 'demo',
          note: 'demo replays recorded verdicts; no license key is read, printed or embedded',
        },
        limits: [
          'demo mode: znk_adjudicate only accepts {"sample":"C01"|"C05"|"C06"} (recorded rows)',
          'demo mode: every geometry-producing tool returns error DEMO_MODE',
          'unset ZNK_DEMO and set ZNK2_CLI + ZNK2_LICENSE_FILE for the full tool set',
        ],
      },
    };
  }
  return runCliQueued({ op: 'capabilities' });
}

async function toolSketchSolve(args) {
  const request = { op: 'sketch_solve', request: args.request };
  if (args.batch !== undefined) request.batch = Boolean(args.batch);
  return runCliQueued(request);
}

// ---------------------------------------------------------------------------
// MCP tool catalogue (exactly 10)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'znk_create',
    description:
      'Create one analytic solid in ZNKernel-II. primitive = box | cylinder | sphere | cone | torus. params: box {lo:[x,y,z],hi:[x,y,z]}; cylinder {center,axis,radius,height}; sphere {center,radius}; cone {base_center,axis,base_radius,height}; torus {center,axis,major_radius,minor_radius}. Units are model units (mm by convention). Returns kernel measurements, a tessellation summary and a replayable recipe for chaining. Set tessellate=false to skip the mesh summary.',
    inputSchema: {
      type: 'object',
      properties: {
        primitive: { type: 'string', enum: PRIMITIVES, description: 'solid primitive kind' },
        params: { type: 'object', description: 'primitive parameters', additionalProperties: true },
        tessellate: { type: 'boolean', description: 'also tessellate and report mesh stats (default true)' },
      },
      required: ['primitive', 'params'],
      additionalProperties: false,
    },
    handler: toolCreate,
  },
  {
    name: 'znk_boolean',
    description:
      'Boolean operation between two solids: operation = union | subtract (a minus b) | intersect. a and b are recipes from znk_create / znk_boolean / znk_import; a whole previous tool result is also accepted. Planar polyhedra are exact; curved bodies may use the tessellated curved-CSG fallback (method/volume_source says so). Returns measurements plus a new replayable recipe. Kernel errors (e.g. 2001 Degenerate, 2004 Coincident, 2009 BooleanFailed) are passed through unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: BOOLEAN_OPS, description: 'union | subtract (a-b) | intersect' },
        a: { ...RECIPE_SCHEMA, description: 'first operand recipe or previous tool result' },
        b: { ...RECIPE_SCHEMA, description: 'second operand recipe or previous tool result' },
        tessellate: { type: 'boolean', description: 'also tessellate the result (default true)' },
      },
      required: ['operation', 'a', 'b'],
      additionalProperties: false,
    },
    handler: toolBoolean,
  },
  {
    name: 'znk_describe',
    description:
      'Measure an existing solid: volume, surface area, bounding box, centroid, B-rep topology counts (vertices/edges/coedges/loops/faces/shells, Euler characteristic), closed/watertight flag and volume_source (analytic | approximated | open_shell). Set tessellate=true to add triangle count and mesh watertightness. Pass the recipe returned by znk_create / znk_boolean / znk_import.',
    inputSchema: {
      type: 'object',
      properties: {
        solid: { ...RECIPE_SCHEMA, description: 'solid recipe or previous tool result' },
        tessellate: { type: 'boolean', description: 'also tessellate and report mesh stats (default false)' },
      },
      required: ['solid'],
      additionalProperties: false,
    },
    handler: toolDescribe,
  },
  {
    name: 'znk_import',
    description:
      'Import STEP / IGES / DXF / DWG / STL / OBJ / ZNK through znk2_cli (content-probed; extension is not trusted) and return body measurements plus a replayable recipe {kind:"import",file}. Use path or inline text (STEP text is written to a server-side temporary file kept for 7 days); format is an optional hint. Default import path is fast (volume/area/centroid are null); set with_mass=true to measure mass properties. Import does not modify the source file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute or server-relative file path to import' },
        text: { type: 'string', description: 'inline file text (for example STEP), instead of path' },
        format: {
          type: 'string',
          enum: ['step', 'stp', 'iges', 'igs', 'dxf', 'dwg', 'stl', 'obj', 'znk'],
          description: 'optional extension hint for inline text (content probe wins)',
        },
        with_mass: { type: 'boolean', description: 'measure volume/area/centroid (slower; default false)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: toolImport,
  },
  {
    name: 'znk_export',
    description:
      'Export a solid to stl | obj | step. Pass a recipe (solid) or an imported file (file), plus an optional output path. STL defaults to binary (set binary=false for ASCII); STEP supports schema AP203/AP214/AP242 and length_unit m|mm (extensions are routed by znk2_cli and round-trip verified). When path is omitted the server writes under ZNK2_EXPORT_DIR (default: <cwd>/znk_exports). Returns the absolute path, byte size and mesh/round-trip stats.',
    inputSchema: {
      type: 'object',
      properties: {
        solid: { ...RECIPE_SCHEMA, description: 'solid recipe or previous tool result' },
        file: { type: 'string', description: 'imported file to export (alternative to solid)' },
        format: { type: 'string', enum: EXPORT_FORMATS, description: 'stl | obj | step' },
        path: { type: 'string', description: 'output file path (optional)' },
        binary: { type: 'boolean', description: 'STL only: binary (default true) or ASCII' },
        chord_tol: { type: 'number', description: 'tessellation chord tolerance; <=0 = 1e-3 * bbox diagonal' },
        angle_tol: { type: 'number', description: 'tessellation angle tolerance in radians (default 0.2)' },
        schema: { type: 'string', enum: ['AP203', 'AP214', 'AP242'], description: 'STEP schema (default AP242)' },
        length_unit: { type: 'string', enum: ['m', 'mm'], description: 'STEP length unit (default m)' },
      },
      required: ['format'],
      additionalProperties: false,
    },
    handler: toolExport,
  },
  {
    name: 'znk_adjudicate',
    description:
      'Run the ZNKernel-II rule registry over a solid (20 rule ids in the 2.29.1 registry; older kernels expose fewer) and return the raw three-valued verdicts: allow | reject | cannot_judge. cannot_judge means UNDECIDED and is never mapped to allow; the response keeps verdict_summary and policy unchanged. Input: solid recipe or file (one of them), optional rule id (omit = run every rule the kernel exposes), params, tolerance, otherBodies (recipes) and otherFiles (paths, for assembly/interference). With ZNK_DEMO=1 pass {"sample":"C01"|"C05"|"C06"} instead to replay one of the 3 recorded samples; no kernel and no license are used in demo mode.',
    inputSchema: {
      type: 'object',
      properties: {
        sample: {
          type: 'string',
          enum: ['C01', 'C05', 'C06'],
          description: 'demo mode only (ZNK_DEMO=1): replay a recorded sample instead of a solid/file',
        },
        solid: { ...RECIPE_SCHEMA, description: 'solid recipe or previous tool result' },
        file: { type: 'string', description: 'imported file to adjudicate (alternative to solid)' },
        rule: { type: 'string', enum: RULE_IDS, description: 'one kernel rule id (see znk_adjudicate_rules); omit to run every rule the kernel exposes' },
        params: { type: 'object', description: 'rule parameters (passed to the kernel unchanged)', additionalProperties: true },
        tolerance: { type: 'number', description: 'optional kernel tolerance' },
        otherBodies: {
          type: 'array',
          items: { ...RECIPE_SCHEMA },
          description: 'additional bodies as recipes (mapped to other_solids)',
        },
        otherFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'additional bodies as file paths (mapped to other_files)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: toolAdjudicate,
  },
  {
    name: 'znk_adjudicate_rules',
    description:
      'List the ZNKernel-II adjudication rules (id, namespace, name, rule_version, description, defaultParams) and the three accepted verdicts. This produces no geometry. Like every kernel operation it requires ZNK2_LICENSE_FILE; a missing license returns CLI error 1004. Under ZNK_DEMO=1 it instead lists the rules present in the 3 recorded demo samples, with no license.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: toolAdjudicateRules,
  },
  {
    name: 'znk_topology',
    description:
      'Read B-rep topology counts for a solid through znk2_cli describe: solids/shells/faces/loops/coedges/edges/vertices, Euler characteristic, shell Euler values, validity/issue_count, bbox and closed flag. This CLI-only tool layer reports body-level counts; entity-level face/edge/vertex geometry and adjacency (zn2_entity_topology) are NOT exposed by znk2_cli 2.28.1 and return an explicit NotSupported (1003) instead of fabricated data.',
    inputSchema: {
      type: 'object',
      properties: {
        solid: { ...RECIPE_SCHEMA, description: 'solid recipe or previous tool result' },
        entity: {
          type: 'string',
          description: 'entity reference; accepted by the schema but unsupported by the CLI backend (returns 1003)',
        },
        entity_id: { type: 'number', description: 'raw entity id; unsupported by the CLI backend (returns 1003)' },
      },
      required: ['solid'],
      additionalProperties: false,
    },
    handler: toolTopology,
  },
  {
    name: 'znk_capabilities',
    description:
      'Report ZNKernel-II capabilities before modeling: kernel/CLI version, ABI symbols, implemented/unsupported feature families, primitives, boolean ops, export formats, tessellation/sketch support, protection and license status, and limits. No geometry. Works without a license (license.status will say missing). Under ZNK_DEMO=1 it lists the 3 recorded demo samples instead of loading the kernel.',
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: toolCapabilities,
  },
  {
    name: 'znk_sketch_solve',
    description:
      'Solve 2D sketch constraints with the ZNKernel-II LM solver. request is the legacy JSON contract: single constraint {type,a_pos,a_dir,b_pos,b_dir,value} or system {op:"solve_system",entities:[...],constraints:[...],options:{...}}. Batch mode ({constraints:[...]} or batch=true) returns kernel 9002 on the official CLI and is passed through. Returns {ok,residual,iterations,converged,positions} or {ok:false,error:{code,message}}.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          description: 'single-constraint or solve_system request object',
          additionalProperties: true,
        },
        batch: { type: 'boolean', description: 'batch form; returns 9002 on the official CLI' },
      },
      required: ['request'],
      additionalProperties: false,
    },
    handler: toolSketchSolve,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// MCP result shaping
// ---------------------------------------------------------------------------
function toolResult(envelope) {
  const isError = !envelope || envelope.ok === false;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    structuredContent: envelope,
    isError,
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// ---------------------------------------------------------------------------
// MCP method dispatch
// ---------------------------------------------------------------------------
function negotiateProtocolVersion(params) {
  const requested =
    params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION;
}

async function dispatch(message) {
  const id = message.id;
  const method = message.method;

  switch (method) {
    case 'initialize': {
      const params = isObject(message.params) ? message.params : {};
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'ZNKernel-II geometry tool layer. Call znk_capabilities first when unsure. Recipes returned by znk_create/znk_boolean/znk_import are replayable and can be passed to znk_describe/znk_export/znk_adjudicate/znk_topology. Adjudication is three-valued: cannot_judge is UNDECIDED, never an allow. Kernel error codes are passed through unchanged. Requires ZNK2_CLI and ZNK2_LICENSE_FILE in the server environment. With ZNK_DEMO=1 the server replays 3 recorded samples for znk_adjudicate ({"sample":"C01"|"C05"|"C06"}) and needs no license.',
      });
    }
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case 'tools/call': {
      const params = isObject(message.params) ? message.params : null;
      if (!params) {
        return jsonRpcError(id, RPC.INVALID_PARAMS, 'tools/call params must be an object');
      }
      if (typeof params.name !== 'string' || params.name === '') {
        return jsonRpcError(id, RPC.INVALID_PARAMS, 'tools/call params.name must be a non-empty string');
      }
      const tool = TOOL_BY_NAME.get(params.name);
      if (!tool) {
        return jsonRpcError(id, RPC.INVALID_PARAMS, `Unknown tool: ${params.name}`);
      }
      let args = params.arguments;
      if (args === undefined || args === null) args = {};
      if (!isObject(args)) {
        return jsonRpcError(id, RPC.INVALID_PARAMS, 'tools/call params.arguments must be an object');
      }
      if (DEMO_MODE && !DEMO_ALLOWED_TOOLS.includes(tool.name)) {
        return jsonRpcResult(id, toolResult(demoUnavailable(tool.name)));
      }
      try {
        const envelope = await tool.handler(args);
        return jsonRpcResult(id, toolResult(envelope));
      } catch (error) {
        const envelope = errorEnvelope(
          'INTERNAL_ERROR',
          error && error.message ? error.message : String(error),
          { tool: tool.name, stack: error && error.stack ? String(error.stack).split('\n').slice(0, 5) : undefined },
        );
        return jsonRpcResult(id, toolResult(envelope));
      }
    }
    default:
      return jsonRpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function isNotification(message) {
  return message.id === undefined || message.id === null;
}

function validateRequest(message) {
  if (!isObject(message)) return 'request must be a JSON object';
  if (message.jsonrpc !== '2.0') return 'jsonrpc must be "2.0"';
  if (typeof message.method !== 'string' || message.method === '') return 'method must be a non-empty string';
  return null;
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------
function writeMessage(object) {
  try {
    process.stdout.write(`${JSON.stringify(object)}\n`);
  } catch (error) {
    process.stderr.write(`[znk-mcp] stdout write failed: ${error && error.message ? error.message : error}\n`);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    writeMessage(jsonRpcError(null, RPC.PARSE_ERROR, `Parse error: ${error && error.message ? error.message : error}`));
    return;
  }

  if (Array.isArray(message)) {
    writeMessage(jsonRpcError(null, RPC.INVALID_REQUEST, 'JSON-RPC batch requests are not supported by MCP stdio'));
    return;
  }

  const validation = validateRequest(message);
  if (validation) {
    // Notifications never receive a response, even malformed ones.
    if (isNotification(message)) return;
    writeMessage(jsonRpcError(message.id, RPC.INVALID_REQUEST, validation));
    return;
  }

  if (isNotification(message)) {
    // notifications/initialized, notifications/cancelled, ... : no response.
    return;
  }

  try {
    const response = await dispatch(message);
    writeMessage(response);
  } catch (error) {
    writeMessage(
      jsonRpcError(
        message.id,
        RPC.INTERNAL_ERROR,
        error && error.message ? error.message : String(error),
      ),
    );
  }
}

function main() {
  cleanupImportCache();

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  rl.on('line', (line) => {
    // Do not await here: dispatch itself serializes only the CLI calls.
    handleLine(line).catch((error) => {
      process.stderr.write(`[znk-mcp] unhandled line error: ${error && error.message ? error.message : error}\n`);
    });
  });

  rl.on('close', () => {
    process.exitCode = 0;
  });

  process.stdout.on('error', () => {
    /* the client closed stdout; nothing useful to do */
  });

  process.stderr.write(
    `[znk-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready; ${
      DEMO_MODE ? `mode=demo (ZNK_DEMO=1, samples ${DEMO_KEYS.join('/')}, no license used)` : `cli=${CLI_PATH}`
    }; timeout_ms=${TIMEOUT_MS}; protocol=${LATEST_PROTOCOL_VERSION}\n`,
  );
  if (DEMO_MODE) {
    process.stderr.write(
      '[znk-mcp] demo mode: znk_capabilities / znk_adjudicate / znk_adjudicate_rules replay 3 recorded samples; ' +
        'all other tools return DEMO_MODE. Unset ZNK_DEMO and set ZNK2_CLI + ZNK2_LICENSE_FILE for the full tool set.\n',
    );
  } else if (!envString('ZNK2_LICENSE_FILE')) {
    process.stderr.write(
      '[znk-mcp] warning: ZNK2_LICENSE_FILE is not set; geometry tools will return znk2_cli error 1004. ' +
        'Set it in the MCP client env; no license is embedded in this server. For a license-free look at the ' +
        'three verdicts, run with ZNK_DEMO=1 instead (npx -y znk-mcp@0.1.3).\n',
    );
  }
  if (envString('ZNK2_REVOKE_LIST')) {
    process.stderr.write('[znk-mcp] revocation list configured via ZNK2_REVOKE_LIST (value not logged)\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  TOOLS,
  TOOL_BY_NAME,
  RULE_IDS,
  runCli,
  dispatch,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
};
