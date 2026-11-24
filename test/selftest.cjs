#!/usr/bin/env node
/*
 * znk-mcp self-test — spawns server.cjs, speaks JSON-RPC 2.0 over stdio,
 * and asserts the MCP surface plus a real create → describe → adjudicate
 * round-trip against znk2_cli.
 *
 * Usage:
 *   node test/selftest.cjs
 *   set ZNK_MCP_SELFTEST_LOG=D:\ai-crew-data\t0750\selftest-transcript.jsonl
 *
 * Exit code 0 + "SELFTEST PASS n/n" means every assertion passed.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const SERVER = path.join(__dirname, '..', 'server.cjs');
const LOG_PATH = process.env.ZNK_MCP_SELFTEST_LOG || '';
const EXPECTED_CHECKS = 28;
const REQUEST_TIMEOUT_MS = 70_000;

const checks = [];
let passed = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  if (ok) passed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
}

function transcript(direction, payload) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), direction, payload })}\n`,
      'utf8',
    );
  } catch {
    /* diagnostics only */
  }
}

function main() {
  if (!fs.existsSync(SERVER)) {
    console.error(`server not found: ${SERVER}`);
    process.exit(1);
  }
  if (!process.env.ZNK2_CLI) {
    console.error('[selftest] ZNK2_CLI is not set; set it to the znk2_cli executable.');
  }
  if (!process.env.ZNK2_LICENSE_FILE) {
    console.error('[selftest] ZNK2_LICENSE_FILE is not set; geometry assertions will fail with CLI 1004.');
  }
  if (LOG_PATH) {
    try {
      fs.writeFileSync(LOG_PATH, '', 'utf8');
    } catch {
      /* ignore */
    }
  }

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ZNK2_ALLOWED_ROOTS: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      console.error(`[selftest] non-JSON server line: ${text.slice(0, 300)}`);
      return;
    }
    transcript('server->client', message);
    if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    closed = true;
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`server exited (code=${code}, signal=${signal}) before response id=${id}`));
    }
    pending.clear();
  });

  function send(message) {
    if (closed) throw new Error('server already exited');
    transcript('client->server', message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    send(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS} ms: ${method} (id=${id})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  }

  async function callTool(name, args) {
    const response = await request('tools/call', { name, arguments: args });
    return response;
  }

  async function run() {
    // 1-3: initialize
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'znk-mcp-selftest', version: '1.0.0' },
    });
    check(
      'initialize returns a supported protocolVersion',
      init.result && ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'].includes(init.result.protocolVersion),
      init.result && init.result.protocolVersion,
    );
    check(
      'initialize reports serverInfo.name=znk-mcp',
      init.result && init.result.serverInfo && init.result.serverInfo.name === 'znk-mcp',
      init.result && init.result.serverInfo && init.result.serverInfo.name,
    );
    check(
      'initialize advertises tools capability',
      init.result && init.result.capabilities && init.result.capabilities.tools && init.result.capabilities.tools.listChanged === false,
    );
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // 4-6: tools/list
    const listed = await request('tools/list', {});
    const tools = (listed.result && listed.result.tools) || [];
    const expectedNames = [
      'znk_create',
      'znk_boolean',
      'znk_describe',
      'znk_import',
      'znk_export',
      'znk_adjudicate',
      'znk_adjudicate_rules',
      'znk_topology',
      'znk_capabilities',
      'znk_sketch_solve',
    ];
    check('tools/list returns exactly 10 tools', tools.length === 10, `got ${tools.length}`);
    check(
      'tool names match the contract',
      expectedNames.every((name) => tools.some((tool) => tool.name === name)),
      tools.map((tool) => tool.name).join(','),
    );
    check(
      'every tool has an object inputSchema',
      tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'),
    );

    // 7: ping
    const ping = await request('ping', {});
    check('ping returns an empty result', ping.result && Object.keys(ping.result).length === 0, JSON.stringify(ping.result));

    // 8-10: create
    const created = await callTool('znk_create', {
      primitive: 'box',
      params: { lo: [0, 0, 0], hi: [10, 20, 30] },
    });
    const createdSc = created.result && created.result.structuredContent;
    check(
      'znk_create succeeds',
      created.result && created.result.isError === false && createdSc && createdSc.ok === true,
      createdSc && createdSc.error && createdSc.error.message,
    );
    const volume = createdSc && createdSc.result && createdSc.result.describe && createdSc.result.describe.volume;
    check('znk_create returns volume > 0', typeof volume === 'number' && volume > 0, volume);
    const recipe = createdSc && createdSc.result && createdSc.result.recipe;
    check('znk_create returns a replayable recipe', recipe && recipe.kind === 'primitive' && recipe.primitive === 'box');

    // 11-12: describe
    const described = await callTool('znk_describe', { solid: recipe });
    const describedSc = described.result && described.result.structuredContent;
    const describedVolume = describedSc && describedSc.result && describedSc.result.volume;
    check(
      'znk_describe succeeds on the returned recipe',
      described.result && described.result.isError === false && describedSc && describedSc.ok === true,
      describedSc && describedSc.error && describedSc.error.message,
    );
    check(
      'znk_describe returns the same positive volume',
      typeof describedVolume === 'number' && Math.abs(describedVolume - volume) < 1e-6,
      describedVolume,
    );

    // 13-14: boolean
    const booleanResponse = await callTool('znk_boolean', {
      operation: 'subtract',
      a: recipe,
      b: {
        kind: 'primitive',
        primitive: 'cylinder',
        params: { center: [5, 10, -5], axis: [0, 0, 1], radius: 2, height: 40 },
      },
    });
    const booleanSc = booleanResponse.result && booleanResponse.result.structuredContent;
    const booleanVolume = booleanSc && booleanSc.result && booleanSc.result.describe && booleanSc.result.describe.volume;
    check(
      'znk_boolean subtract succeeds and returns a recipe',
      booleanResponse.result.isError === false &&
        booleanSc &&
        booleanSc.ok === true &&
        booleanSc.result.recipe &&
        booleanSc.result.recipe.kind === 'boolean',
      booleanSc && booleanSc.error && booleanSc.error.message,
    );
    check(
      'znk_boolean subtract reduces the volume',
      typeof booleanVolume === 'number' && booleanVolume > 0 && booleanVolume < volume,
      booleanVolume,
    );

    // 15-17: adjudicate (all 10 rules)
    const adjudicated = await callTool('znk_adjudicate', { solid: recipe });
    const adjudicatedSc = adjudicated.result && adjudicated.result.structuredContent;
    const adjudicatedResult = adjudicatedSc && adjudicatedSc.result;
    const adjudicatedRows = (adjudicatedResult && adjudicatedResult.results) || [];
    check(
      'znk_adjudicate runs all 10 rules',
      adjudicatedSc && adjudicatedSc.ok === true && adjudicatedRows.length === 10,
      `rows=${adjudicatedRows.length}`,
    );
    const verdicts = adjudicatedRows.map((row) => row.verdict);
    check(
      'every adjudication verdict is allow|reject|cannot_judge',
      verdicts.length === 10 && verdicts.every((verdict) => ['allow', 'reject', 'cannot_judge'].includes(verdict)),
      verdicts.join(','),
    );
    const cannotJudge = verdicts.filter((verdict) => verdict === 'cannot_judge').length;
    check(
      'cannot_judge is preserved (not folded into allow)',
      adjudicatedResult &&
        adjudicatedResult.verdict_summary &&
        adjudicatedResult.verdict_summary.cannot_judge === cannotJudge &&
        adjudicatedResult.policy &&
        String(adjudicatedResult.policy.cannot_judge).includes('NOT an allow'),
      `summary=${JSON.stringify(adjudicatedResult && adjudicatedResult.verdict_summary)}`,
    );

    // 18-19: adjudicate rules
    const rulesResponse = await callTool('znk_adjudicate_rules', {});
    const rulesSc = rulesResponse.result && rulesResponse.result.structuredContent;
    const rulesResult = rulesSc && rulesSc.result;
    check(
      'znk_adjudicate_rules lists 10 rules',
      rulesSc && rulesSc.ok === true && rulesResult && rulesResult.count === 10 && rulesResult.rules.length === 10,
      rulesResult && rulesResult.count,
    );
    check(
      'znk_adjudicate_rules advertises three verdicts',
      rulesResult &&
        Array.isArray(rulesResult.verdicts) &&
        rulesResult.verdicts.join(',') === 'allow,reject,cannot_judge',
      rulesResult && rulesResult.verdicts && rulesResult.verdicts.join(','),
    );

    // 20-21: topology
    const topologyResponse = await callTool('znk_topology', { solid: recipe });
    const topologySc = topologyResponse.result && topologyResponse.result.structuredContent;
    const topology = topologySc && topologySc.result && topologySc.result.topology;
    check(
      'znk_topology returns body-level counts',
      topologySc && topologySc.ok === true && topology && topology.faces === 6 && topology.valid === true,
      topology && `faces=${topology.faces}`,
    );
    const topologyEntity = await callTool('znk_topology', { solid: recipe, entity: 'face:0' });
    const topologyEntitySc = topologyEntity.result && topologyEntity.result.structuredContent;
    check(
      'znk_topology entity query returns an explicit 1003 (no fabricated data)',
      topologyEntity.result.isError === true &&
        topologyEntitySc &&
        topologyEntitySc.ok === false &&
        topologyEntitySc.error &&
        topologyEntitySc.error.code === 1003,
      topologyEntitySc && topologyEntitySc.error && topologyEntitySc.error.message,
    );

    // 22: capabilities
    const capabilitiesResponse = await callTool('znk_capabilities', {});
    const capabilitiesSc = capabilitiesResponse.result && capabilitiesResponse.result.structuredContent;
    check(
      'znk_capabilities reports a kernel version',
      capabilitiesSc &&
        capabilitiesSc.ok === true &&
        capabilitiesSc.result &&
        typeof capabilitiesSc.result.kernel_version === 'string' &&
        capabilitiesSc.result.kernel_version.length > 0,
      capabilitiesSc && capabilitiesSc.result && capabilitiesSc.result.kernel_version,
    );

    // 23: sketch solve
    const sketchResponse = await callTool('znk_sketch_solve', {
      request: { type: 'horizontal', a_pos: [0, 0], a_dir: [0.7071, 0.7071] },
    });
    const sketchSc = sketchResponse.result && sketchResponse.result.structuredContent;
    check(
      'znk_sketch_solve converges on a horizontal constraint',
      sketchSc &&
        sketchSc.ok === true &&
        sketchSc.result &&
        sketchSc.result.ok === true &&
        Array.isArray(sketchSc.result.b_dir) &&
        Math.abs(sketchSc.result.b_dir[1]) < 1e-6,
      JSON.stringify(sketchSc && sketchSc.result),
    );

    // 24-25: export + import round-trip
    const stlPath = path.join(os.tmpdir(), `znk-mcp-selftest-${process.pid}.stl`);
    try {
      const exported = await callTool('znk_export', { solid: recipe, format: 'stl', path: stlPath });
      const exportedSc = exported.result && exported.result.structuredContent;
      check(
        'znk_export writes a non-empty STL',
        exported.result.isError === false &&
          exportedSc &&
          exportedSc.ok === true &&
          fs.existsSync(stlPath) &&
          fs.statSync(stlPath).size > 0,
        exportedSc && exportedSc.error && exportedSc.error.message,
      );
      const imported = await callTool('znk_import', { path: stlPath, with_mass: true });
      const importedSc = imported.result && imported.result.structuredContent;
      check(
        'znk_import returns an imported body and a chainable recipe',
        imported.result.isError === false &&
          importedSc &&
          importedSc.ok === true &&
          importedSc.result &&
          importedSc.result.imported === true &&
          importedSc.result.recipe &&
          importedSc.result.recipe.kind === 'import',
        importedSc && importedSc.error && importedSc.error.message,
      );
    } finally {
      try {
        fs.unlinkSync(stlPath);
      } catch {
        /* not created */
      }
    }

    // 26: invalid tool argument -> CLI error passthrough
    const invalid = await callTool('znk_create', { primitive: 'banana', params: {} });
    const invalidSc = invalid.result && invalid.result.structuredContent;
    check(
      'invalid primitive returns CLI error 1003 (not swallowed)',
      invalid.result.isError === true &&
        invalidSc &&
        invalidSc.ok === false &&
        invalidSc.error &&
        invalidSc.error.code === 1003,
      invalidSc && invalidSc.error && `${invalidSc.error.code} ${invalidSc.error.message}`,
    );

    // 27: unknown method
    const unknownMethod = await request('does/not/exist', {});
    check(
      'unknown method returns JSON-RPC -32601',
      unknownMethod.error && unknownMethod.error.code === -32601,
      unknownMethod.error && unknownMethod.error.message,
    );

    // 28: unknown tool
    const unknownTool = await request('tools/call', { name: 'not_a_znk_tool', arguments: {} });
    check(
      'unknown tool returns JSON-RPC -32602',
      unknownTool.error && unknownTool.error.code === -32602,
      unknownTool.error && unknownTool.error.message,
    );
  }

  run()
    .catch((error) => {
      check('selftest completed without an exception', false, error && error.message ? error.message : String(error));
    })
    .finally(() => {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 300);
      const failed = checks.filter((item) => !item.ok).length;
      const total = checks.length;
      const ok = failed === 0 && total === EXPECTED_CHECKS;
      console.log(
        `SELFTEST ${ok ? 'PASS' : 'FAIL'} ${passed}/${total}${total === EXPECTED_CHECKS ? '' : ` (expected ${EXPECTED_CHECKS} checks)`}`,
      );
      if (LOG_PATH) console.log(`transcript: ${LOG_PATH}`);
      process.exit(ok ? 0 : 1);
    });
}

main();
