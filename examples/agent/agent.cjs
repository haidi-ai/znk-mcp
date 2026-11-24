#!/usr/bin/env node
'use strict';
/*
 * znk-mcp / examples/agent/agent.cjs
 * A minimal, dependency-free "geometry check-up" agent:
 *   one natural-language sentence
 *     -> DeepSeek chat/completions (function calling)
 *     -> znk-mcp MCP server over stdio
 *     -> ZNKernel-II CLI (the only source of geometry / verdicts)
 *     -> one final answer
 *
 * Safety contract:
 *   - The DeepSeek key is read from DEEPSEEK_API_KEY only. It is never written,
 *     never printed, and every string that goes to disk passes through redact().
 *     Missing key => exit code 2.
 *   - ZNK2_* variables are inherited by the MCP child process unchanged.
 *   - A deterministic guard re-reads the final answer and flags price / delivery /
 *     guarantee wording and any cannot_judge / UNSUPPORTED that got softened.
 *
 * Node >= 18. No npm packages.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- config ----
function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KEY = process.env.DEEPSEEK_API_KEY || '';

const CFG = {
  mcpDir: path.resolve(argOf('mcp-dir', process.env.ZNK_MCP_DIR || REPO_ROOT)),
  outDir: path.resolve(argOf('out', path.join(os.tmpdir(), 'znk-agent-runs'))),
  model: argOf('model', process.env.DEEPSEEK_MODEL || 'deepseek-flash'),
  baseUrl: argOf('base-url', process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  maxRounds: Number(argOf('max-rounds', '12')),
  maxTokens: Number(argOf('max-tokens', '4096')),
  toolTimeoutMs: Number(argOf('tool-timeout', '180000')),
  strict: hasFlag('strict'),
  json: hasFlag('json'),
  listTools: hasFlag('list-tools'),
  quiet: hasFlag('quiet'),
};

const FLAGS_WITH_VALUE = new Set(['mcp-dir', 'out', 'model', 'base-url', 'max-rounds', 'max-tokens', 'tool-timeout']);
function positional() {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (FLAGS_WITH_VALUE.has(a.slice(2))) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}
const QUESTION = positional().join(' ').trim();

// The five hard constraints. Keep this list in sync with README-AGENT.md
// ("硬约束 5 条") and prompts/zhihu-agent.md - partners paste both.
const HARD_RULES = [
  '几何只来自内核：体积/面积/壁厚/干涉/孔是否贯通等一切数值和判定，只能引用 znk_* 工具返回体里的值。不得自己推算、估算、补全，也不得引用记忆或经验里的数值；工具没返回就写「未验证」。',
  'unknown op 必须 UNSUPPORTED：用户要的能力若不在本代理的 10 个工具 / 10 条规则之内（例如强度仿真、渲染出图、DWG 编辑、直接改模型、报价、排产），或工具返回 2004 / unsupported op，回答必须以「UNSUPPORTED：」开头，说明不支持的原因以及你能做什么；禁止用文字模拟或假装执行。',
  'cannot_judge 原样：工具返回 cannot_judge 就是「未判定」，不得改写成通过 / 没问题 / 可以使用 / 应该没事；汇总必须同时给出 allow、reject、cannot_judge 三个数，并明确「未判定不算通过」。',
  '不报价：不得给任何价格、单价、折扣、付款条件或"大概多少钱"。被问价时只回答：报价由工程师按件确认，我先把你的需求转给工程师；并索取线索字段（称呼/联系方式/件数/格式/需求原话）。',
  '不承诺交期：不得给交付日期、工期、加急时限或"几天能好"。只回答：交期由人工确认，我这边不出交期承诺。',
];

const SYSTEM_PROMPT = [
  '你是「几何体检」代理：一个只做 STEP/STL/OBJ 模型可制造性规则预检的助手。你不是 CAD 软件，不改模型，不做仿真，不报价，不谈交期。',
  '',
  '【五条硬约束（任何情况不得绕过）】',
  ...HARD_RULES.map((r, i) => `${i + 1}. ${r}`),
  '',
  '【工具使用】',
  '- 可用工具共 10 个：znk_capabilities、znk_import、znk_describe、znk_adjudicate、znk_adjudicate_rules、znk_topology、znk_export、znk_create、znk_boolean、znk_sketch_solve。它们是唯一的执行通道。',
  '- 体检最小链：znk_capabilities（可选，看能力/许可）→ znk_import（用户给的 STEP 路径）→ znk_adjudicate（solid 用 import 返回的 recipe，rule 省略则跑全部）→ 需要时 znk_describe / znk_topology 补充数值。没有 import 成功就不要 adjudicate。',
  '- recipe 必须原样传递：把上一步返回的 recipe（kind=import / primitive / boolean ...）整块作为 solid 传入；不要改写字段名或删字段。',
  '- znk_adjudicate 的 rule 只能用这 10 个 id：manufacturing/min_wall_thickness、manufacturing/hole_penetration、manufacturing/draft_angle、manufacturing/sliver_face、quality/non_manifold、assembly/interference、manufacturing/blade_thin_section、manufacturing/hole_depth_ratio、manufacturing/sharp_internal_corner、quality/small_feature。问单条就传该 id，问"整体"就省略 rule。',
  '- 布尔试算时不要让工具与基体精确共面（内核会拒绝共面接触）；圆柱两端各超出基体表面几毫米。',
  '- 用户只给一句话、没给文件路径：先要 STEP/STL/OBJ 路径，不要凭空假设模型。',
  '',
  '【回答格式（中文，短句，先结论）】',
  '① 第一行：一句话结论（例如：这件：allow 1 / reject 2 / 未判定 7，主要卡在孔贯通与壁厚）。',
  '② 关键证据：逐项列数值、单位、来自哪个工具（例如 remainingWall=0、radius=10、throughHole=1，来自 znk_adjudicate）。',
  '③ 未判定项：缺什么信息；没有证据就写「未验证」。',
  '④ 下一步：需要人工复核的点；如果用户要报价/交期，按硬约束 4、5 转人工并索取线索。',
].join('\n');

// ------------------------------------------------------------- utilities ----
const redact = (s) => (typeof s === 'string' && s && KEY ? s.split(KEY).join('[REDACTED]') : s);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(CFG.outDir, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TRANSCRIPT = path.join(CFG.outDir, 'transcript-' + STAMP + '.jsonl');
const RESULT_JSON = path.join(CFG.outDir, 'result-' + STAMP + '.json');
const EVENTS = [];
function emit(ev) {
  const rec = { seq: EVENTS.length + 1, ts: nowIso(), ...ev };
  EVENTS.push(rec);
  fs.appendFileSync(TRANSCRIPT, JSON.stringify(rec, (k, v) => (typeof v === 'string' ? redact(v) : v)) + '\n');
}

// ----------------------------------------------------------- MCP client -----
class McpClient {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.closed = false;
  }

  async start() {
    const serverFile = path.join(CFG.mcpDir, 'server.cjs');
    if (!fs.existsSync(serverFile)) {
      throw new Error('cannot find MCP server at ' + serverFile + ' (use --mcp-dir or ZNK_MCP_DIR)');
    }
    this.child = spawn(process.execPath, [serverFile], {
      cwd: CFG.mcpDir,
      env: { ...process.env }, // ZNK2_CLI / ZNK2_LICENSE_FILE / ZNK2_* pass through
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => {
      this.stderrBuf += d;
      if (this.stderrBuf.length > 20000) this.stderrBuf = this.stderrBuf.slice(-20000);
    });
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('MCP server exited, code=' + code));
      this.pending.clear();
    });
    this.child.on('error', (e) => {
      for (const [, p] of this.pending) p.reject(e);
      this.pending.clear();
    });
    return this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'znk-agent-example', version: '1.0.0' },
    }, 30000);
  }

  _onData(d) {
    this.stdoutBuf += d;
    let i;
    while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, i).trim();
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || msg.id === null) continue; // notifications
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  request(method, params, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error('MCP server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP timeout after ' + timeoutMs + 'ms for ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  stop() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

function toDeepSeekTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: String(t.description || '').slice(0, 4000),
      parameters: t.inputSchema && t.inputSchema.type ? t.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

// Keep a compact digest for the transcript (the full text still goes to the model).
function digestToolResult(jr) {
  const d = { rpc_error: jr.error || null };
  const res = jr.result || {};
  const sc = res.structuredContent;
  d.isError = !!res.isError;
  if (sc && typeof sc === 'object') {
    d.ok = sc.ok;
    if (sc.error) d.error = sc.error;
    const r = sc.result || {};
    if (r.describe) {
      d.volume = r.describe.volume;
      d.area = r.describe.area;
      d.volume_source = r.describe.volume_source;
      d.faces = r.describe.topology && r.describe.topology.faces;
      d.closed = r.describe.closed;
    }
    if (r.verdicts || r.results) {
      d.verdict_summary = r.verdict_summary;
      d.verdicts = (r.verdicts || r.results).map((x) => ({ id: x.id, verdict: x.verdict, evidence: x.evidence }));
    }
    if (r.recipe) d.recipe_kind = r.recipe.kind;
    if (r.path !== undefined) { d.path = r.path; d.bytes = r.bytes; }
    if (r.format !== undefined) d.format = r.format;
  }
  const text = ((res.content || []).map((c) => c.text).filter(Boolean).join('\n')) || '';
  d.text_len = text.length;
  d.unsupported = /unsupported|2004/i.test(text);
  d.has_cannot_judge = text.includes('cannot_judge');
  return d;
}

// ---------------------------------------------------------- DeepSeek API ----
async function chat(messages, tools) {
  const body = {
    model: CFG.model,
    messages,
    tools,
    tool_choice: 'auto',
    stream: false,
    temperature: 0,
    max_tokens: CFG.maxTokens,
    thinking: { type: 'disabled' },
  };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(CFG.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* below */ }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status + ': ' + redact(raw).slice(0, 500));
        if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
        throw lastErr;
      }
      if (!json) throw new Error('non-JSON response: ' + redact(raw).slice(0, 200));
      return { json, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && /fetch failed|network|timeout|ECONN/i.test(String(e.message))) { await sleep(1500 * attempt); continue; }
      throw e;
    }
  }
  throw lastErr;
}

const usageOf = (j) => {
  const u = (j && j.usage) || {};
  return {
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens || 0,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens || 0,
  };
};
const addUsage = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };
const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });

// ------------------------------------------------------- deterministic guard -
// Reads what the model actually said and reports rule violations. It never
// rewrites the answer: the point is to prove the guard catches bad output.
const GUARDS = [
  {
    id: 'NO_PRICE',
    rule: '硬约束 4：不报价',
    re: /[¥￥]\s*\d|\d[\d,.]*\s*元\s*(\/|每|一个|一件)?|\d[\d,.]*\s*\/\s*件|\bRMB\b|\bCNY\b|\bUSD\b/,
  },
  {
    id: 'NO_DELIVERY_PROMISE',
    rule: '硬约束 5：不承诺交期',
    re: /(交期|交付|工期)[^。；\n]{0,12}\d+\s*(个)?\s*(天|日|周|工作日|小时)|\d+\s*(个)?\s*(天|日|周|工作日)\s*(内|以内|交货|交付)/,
  },
  {
    id: 'NO_GUARANTEE',
    rule: '不承诺能打印/包过',
    re: /保证能|保证可以|100\s*%|百分百|包过|一定能(打|打印|加工)|绝对可以/,
  },
];

function runGuard(finalText, ctx) {
  const hits = [];
  for (const g of GUARDS) {
    const m = finalText.match(g.re);
    if (m) hits.push({ id: g.id, rule: g.rule, matched: m[0] });
  }
  if (ctx.hasCannotJudge && !/未判定/.test(finalText)) {
    hits.push({ id: 'CANNOT_JUDGE_NOT_SOFTENED', rule: '硬约束 3：cannot_judge 原样', matched: '(未判定 missing)' });
  }
  if (ctx.hasUnsupported && !/UNSUPPORTED/i.test(finalText)) {
    hits.push({ id: 'UNSUPPORTED_NOT_HIDDEN', rule: '硬约束 2：unknown op 必须 UNSUPPORTED', matched: '(UNSUPPORTED missing)' });
  }
  return hits;
}

// ------------------------------------------------------------------ main ----
async function main() {
  if (!KEY && !CFG.listTools) {
    console.error('FATAL: DEEPSEEK_API_KEY is not set in this process environment.');
    console.error('       Set it for this shell only, e.g.  $env:DEEPSEEK_API_KEY="sk-..."  (never write it to a file).');
    process.exit(2);
  }

  const t0 = Date.now();
  const mcp = new McpClient();
  const init = await mcp.start();
  mcp.notify('notifications/initialized', {});
  const toolList = await mcp.request('tools/list', {}, 30000);
  const rawTools = (toolList.result && toolList.result.tools) || [];
  const tools = toDeepSeekTools(rawTools);
  const serverInfo = init.result && init.result.serverInfo;

  emit({
    event: 'mcp_ready',
    protocolVersion: init.result && init.result.protocolVersion,
    serverInfo,
    tool_count: rawTools.length,
    tool_names: rawTools.map((t) => t.name),
    cli: process.env.ZNK2_CLI || '(default znk2_cli.exe)',
    license_env: process.env.ZNK2_LICENSE_FILE ? 'set' : 'missing',
  });

  if (CFG.listTools) {
    mcp.stop();
    const payload = { serverInfo, tool_count: rawTools.length, tool_names: rawTools.map((t) => t.name) };
    if (CFG.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`znk-mcp ${serverInfo ? serverInfo.version : '?'}  tools=${rawTools.length}`);
      for (const t of rawTools) console.log('  - ' + t.name);
    }
    return 0;
  }

  if (!QUESTION) {
    mcp.stop();
    console.error('usage: node agent.cjs "一句话" [--mcp-dir <repo>] [--out <dir>] [--json] [--strict]');
    return 2;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: QUESTION },
  ];
  emit({ event: 'question', text: QUESTION });

  const usage = emptyUsage();
  const toolCalls = [];
  let rounds = 0;
  let finalText = '';
  let finishReason = '';
  let error = null;
  let hasCannotJudge = false;
  let hasUnsupported = false;

  try {
    for (rounds = 1; rounds <= CFG.maxRounds; rounds += 1) {
      const apiMessages = messages.map((m) => {
        if (m.role === 'assistant') {
          const o = { role: 'assistant', content: m.content || null };
          if (m.tool_calls) o.tool_calls = m.tool_calls;
          return o;
        }
        return m;
      });
      const { json, ms } = await chat(apiMessages, tools);
      addUsage(usage, usageOf(json));
      const choice = (json.choices && json.choices[0]) || {};
      const msg = choice.message || {};
      finishReason = choice.finish_reason || '';
      emit({
        event: 'llm_round',
        round: rounds,
        latency_ms: ms,
        model: json.model,
        finish_reason: finishReason,
        usage: usageOf(json),
        content: msg.content || '',
        tool_calls: (msg.tool_calls || []).map((tc) => ({ name: tc.function && tc.function.name, arguments: tc.function && tc.function.arguments })),
      });

      const assistant = { role: 'assistant', content: msg.content || null };
      if (msg.tool_calls) {
        assistant.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      messages.push(assistant);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalText = msg.content || '';
        break;
      }

      for (const tc of msg.tool_calls) {
        const name = tc.function && tc.function.name;
        let args = {};
        let argErr = null;
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { argErr = 'invalid JSON arguments: ' + e.message; }
        const tc0 = Date.now();
        let jr;
        try {
          if (argErr) throw new Error(argErr);
          jr = await mcp.request('tools/call', { name, arguments: args }, CFG.toolTimeoutMs);
        } catch (e) {
          jr = { error: { code: -32000, message: String(e.message) } };
        }
        const digest = digestToolResult(jr);
        if (digest.has_cannot_judge) hasCannotJudge = true;
        if (digest.unsupported) hasUnsupported = true;
        const text = ((jr.result && jr.result.content) || []).map((x) => x.text).filter(Boolean).join('\n');
        const contentForModel = text || JSON.stringify(jr.error || digest);
        toolCalls.push({ name, args, digest, latency_ms: Date.now() - tc0 });
        emit({
          event: 'tool_call',
          round: rounds,
          name,
          arguments: args,
          latency_ms: Date.now() - tc0,
          isError: !!digest.isError,
          digest,
          result_text: contentForModel.slice(0, 20000),
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: contentForModel });
      }
    }
    if (!finalText && rounds > CFG.maxRounds) error = 'max rounds exceeded';
  } catch (e) {
    error = String((e && e.message) || e);
    emit({ event: 'agent_error', error: redact(String((e && e.stack) || e)).slice(0, 2000) });
  }

  mcp.stop();
  const guardHits = runGuard(finalText, { hasCannotJudge, hasUnsupported });
  const elapsed = Date.now() - t0;

  const record = {
    task: 'T-0831',
    question: QUESTION,
    model: CFG.model,
    server: serverInfo,
    tool_count: rawTools.length,
    rounds,
    tool_chain: toolCalls.map((t) => t.name),
    tool_calls: toolCalls,
    usage,
    guard: { pass: guardHits.length === 0, hits: guardHits, cannot_judge_seen: hasCannotJudge, unsupported_seen: hasUnsupported },
    answer: finalText,
    finish_reason: finishReason,
    elapsed_ms: elapsed,
    error,
  };
  fs.writeFileSync(RESULT_JSON, JSON.stringify(record, null, 2), (k, v) => (typeof v === 'string' ? redact(v) : v));
  emit({ event: 'agent_end', rounds, tool_chain: record.tool_chain, usage, guard: record.guard, elapsed_ms: elapsed, error });

  if (CFG.json) {
    console.log(JSON.stringify(record, null, 2));
  } else if (!CFG.quiet) {
    console.log(finalText || '(empty answer)');
    console.log('');
    console.log(`--- rounds=${rounds} tools=${toolCalls.length} [${record.tool_chain.join(' -> ') || '-'}] tokens=${usage.total_tokens} (in ${usage.prompt_tokens} / out ${usage.completion_tokens}) ${elapsed} ms`);
    console.log('--- guard: ' + (guardHits.length ? 'FAIL ' + JSON.stringify(guardHits) : 'PASS'));
    console.log('--- evidence: ' + RESULT_JSON);
  }

  // key-leak self check on what we wrote
  for (const f of [TRANSCRIPT, RESULT_JSON]) {
    if (fs.readFileSync(f, 'utf8').includes(KEY)) {
      console.error('FATAL: key material found in ' + f);
      return 3;
    }
  }
  if (error) return 1;
  if (CFG.strict && guardHits.length) return 4;
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('FATAL: ' + redact(String((e && e.stack) || e)));
  process.exitCode = 1;
});
