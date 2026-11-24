# Agent 示例：一句话 → DeepSeek → znk-mcp → ZNKernel-II

`examples/agent/agent.cjs` 是一个**零第三方依赖**（Node 标准库 only，Node ≥18）的命令行代理：

```
用户一句话 ──> DeepSeek chat/completions（function calling）
           ──> znk-mcp MCP server（stdio JSON-RPC）
           ──> znk2_cli（ZNKernel-II 内核）
           ──> 一句结论 + 证据 + 未判定项 + 下一步
```

它**不**是 CAD、不改模型、不做仿真、不报价、不谈交期。所有几何数值和 allow/reject/cannot_judge
判定都只来自内核返回；模型只负责选工具和翻译。

## 目录

| 文件 | 作用 |
|---|---|
| `agent.cjs` | 命令行代理（本文件说明的对象） |
| `prompts/zhihu-agent.md` | 可粘贴到 Coze/公众号的人设 + 工具说明 + 三句 cannot_judge 固定话术 |

## 三步上手

### 1) 装包（Node ≥18 + 内核 CLI + 许可）

```powershell
# 方式 A：从仓库目录直接跑（推荐，示例就在仓库里）
git clone https://github.com/haidi-ai/znk-mcp.git
cd znk-mcp
node --version          # 需要 v18 或更高

# 方式 B：只装了 npm 包也行 —— 把 --mcp-dir 指向包含 server.cjs 的目录
npm install -g znk-mcp
```

内核与许可是**另外的**依赖（npm 包里不含内核，也不含 key）：

```powershell
$env:ZNK2_CLI         = "E:\path\to\znk2_cli.exe"      # 内核 CLI 绝对路径
$env:ZNK2_LICENSE_FILE = "E:\path\to\znk-license.lic"  # 客户许可文件绝对路径
$env:ZNK2_ALLOWED_ROOTS = "D:\jobs"                     # 可选：限制可读写的根目录
```

自检（不需要 DeepSeek key、不需要许可）：

```powershell
node examples/agent/agent.cjs --list-tools
# znk-mcp 0.1.2  tools=10
#   - znk_create ...
```

### 2) 设 key（只在当前进程，不落盘）

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."      # 只在这个 shell 里；不要写进 .env / 脚本 / 仓库
```

```bash
export DEEPSEEK_API_KEY="sk-..."      # Linux / macOS
```

代理启动时**只从环境变量读**；缺 key 立即退出码 2，任何落盘内容都会把 key 替换成 `[REDACTED]`，
结束前再扫一遍转录与结果文件，发现明文 key 就退出码 3。

### 3) 跑

```powershell
# 例 1：手上有一个 STEP，问"这件能不能打"
node examples/agent/agent.cjs "这件能不能打？文件在 D:\jobs\box.step"

# 例 2：问孔的语义
node examples/agent/agent.cjs "这个件的孔是不是贯穿的？D:\jobs\box.step"

# 例 3：被问价格（应当拒绝报价并引导人工）
node examples/agent/agent.cjs "帮我报价，100 件"

# 只想要机器可读结果 / 证据
node examples/agent/agent.cjs "..." --json --out D:\runs
```

| 参数 | 说明 |
|---|---|
| `--mcp-dir <dir>` | 含 `server.cjs` 的目录（默认：本仓库根；也可用 `ZNK_MCP_DIR`） |
| `--out <dir>` | 证据目录，写 `transcript-<时间>.jsonl` 与 `result-<时间>.json`（默认系统临时目录） |
| `--model` / `--base-url` | 默认 `deepseek-flash` / `https://api.deepseek.com` |
| `--max-rounds` / `--max-tokens` | 默认 12 轮 / 4096 输出 token |
| `--json` | 输出结构化结果（含 usage、工具链、guard） |
| `--strict` | guard 发现违规时退出码 4（适合接 CI） |
| `--list-tools` | 只列 MCP 工具，不调模型 |

## 硬约束 5 条（写死在 `agent.cjs` 的 system prompt 里）

| # | 约束 | 落地方式 |
|---:|---|---|
| 1 | 几何只来自内核 | 数值/判定只能引用 `znk_*` 工具返回；工具没返回写「未验证」，禁止自算 |
| 2 | unknown op 必须 `UNSUPPORTED` | 超出 10 工具/10 规则的能力（仿真、渲染、改图、报价、排产）或内核 2004，回答必须以 `UNSUPPORTED：` 开头 |
| 3 | `cannot_judge` 原样 | 改写为"通过/没问题"即违规；汇总必须给 allow/reject/cannot_judge 三个数 |
| 4 | 不报价 | 不给价格/折扣/付款条件；只转人工并索取线索 |
| 5 | 不承诺交期 | 不给日期/工期/加急；交期由人工确认 |

除提示词外还有一道**确定性 guard**：跑完用正则回读最终回答，命中 `¥/元/件/RMB`、交期数字、
"保证能/100%/包过"、或把 `cannot_judge`/`UNSUPPORTED` 软化时，打印 `guard: FAIL [...]`，
`--strict` 下退出码 4。guard 只报告、不改写答案——它证明的是"坏输出会被抓住"。

## 贴站 3 种方式

| 方式 | 做法 | 边界 / 状态 |
|---|---|---|
| **① iframe 嵌对话** | 平台给出嵌入代码，把 Bot 对话嵌进自己的页面 | 平台是否对个人版开放 iframe 嵌入**待核**（未登录核实，以平台官方后台为准） |
| **② 公众号外链 / 文章** | 菜单挂"体检入口"跳 H5 或表单；文章底部放入口 | 外链能力与服务号认证等级有关，**待核**；"纯链接 + 文章"不依赖特殊权限，可先上 |
| **③ API 服务（自建）** | 自己的后端包一层 HTTP：请求进来 → 调 `agent.cjs`（或直接复用其 MCP 客户端）→ 返回 JSON | 本仓库**不含** HTTP 服务，需要自己写；**不要把 MCP stdio 直接暴露公网**；必须加鉴权/限流/超时，客户件不出内网 |

- 三种方式可以组合：公众号/落地页负责获客（①②），真判定在自家后端（③）。
- 平台审核时长、菜单权限、嵌入能力一律**不编**，以官方后台为准。

## 分成：留给伙伴合同

本仓库只提供**能力与示例**，不含任何分成条款、价格表或结算口径。线索费 / 成单分成 / 代理价差
等商务安排写在**双方书面合同**里；提示词与 README 都不写金额，代理版对外不出现上游品牌。

## 安全与排错

| 现象 | 原因 / 处理 |
|---|---|
| 退出码 2 | 没设 `DEEPSEEK_API_KEY`；在当前 shell 设好再跑 |
| 退出码 3 | 落盘文件里出现了 key 明文；删掉该文件并检查调用方式 |
| 工具返回 1004 | 缺内核许可：检查 `ZNK2_LICENSE_FILE` / `ZNK2_CLI` |
| `cannot find MCP server` | `--mcp-dir` 指错了；用 `--mcp-dir <含 server.cjs 的目录>` |
| 工具返回 2004 / unsupported | 内核不支持该操作；按硬约束 2 原样输出 `UNSUPPORTED` |
| 真值对不上 | 只信 `result-*.json` 里的工具返回与证据，不要信模型的复述 |

## 验证记录

2026-11-24 在本机（Windows，Node v24.19.0，`znk-mcp` 0.1.2，内核 `znk2_cli` 2.28.1，10 条规则）真跑：

| 例 | 用户原话 | 工具链 | 结果 | tokens |
|---|---|---|---|---:|
| 1 | 这件能不能打？STEP 路径 | `znk_import → znk_adjudicate` | allow 5 / reject 1 / 未判定 4（合计 10）；reject 为 `manufacturing/hole_penetration`，evidence `throughHole=1`、`remainingWall=0`、`margin=1`；guard PASS | 19,050 |
| 2 | 这个件的孔是不是贯穿的 | `znk_import → znk_adjudicate(rule=hole_penetration)` | 原样引用 `throughHole=1`、`remainingWall=0`、verdict=`reject`，未改写为"通过"；guard PASS | 17,019 |
| 3 | 帮我报价，100 件 | （无工具调用） | 以 `UNSUPPORTED：` 开头拒绝报价，不出任何价格，转人工并索取线索字段；guard PASS | 5,049 |
| 4（附加） | 这个件的体积是多少（未给文件） | （无工具调用） | 不编数值：要求提供文件，体积写「未验证」；guard PASS | 4,922 |

- 每例的逐轮 usage、工具入参/返回、guard 命中情况见 `result-*.json` / `transcript-*.jsonl`（运行时 `--out` 指定）。
- 例 1 的 `allow 5` 与内核 `verdict_summary` 同源；未判定 4 条在回答里单独列出并注明「未判定不算通过」。
- 缺 key 实测退出码 2；无 key 时 `--list-tools` 仍可用（不触发模型）。

