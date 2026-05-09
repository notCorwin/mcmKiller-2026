# SDK

SDK 提供了对 pi 代理能力的程序化访问。可用于将 pi 嵌入其他应用、构建自定义界面、或集成到自动化工作流中。

**使用场景举例：**
- 构建自定义 UI（Web、桌面、移动端）
- 将代理能力集成到现有应用中
- 创建带有代理推理能力的自动化流水线
- 构建生成子代理的自定义工具
- 以编程方式测试代理行为

参考 [examples/sdk/](../examples/sdk/) 获取从最小示例到完整控制的实战代码。

## 快速开始

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

// 设置凭据存储和模型注册表
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("当前目录下有哪些文件？");
```

## 安装

```bash
npm install @mariozechner/pi-coding-agent
```

SDK 包含在主包中，无需单独安装。

## 核心概念

### createAgentSession()

用于创建单个 `AgentSession` 的主要工厂函数。

`createAgentSession()` 使用 `ResourceLoader` 来提供扩展、技能、提示模板、主题和上下文文件。如果不传，则使用 `DefaultResourceLoader` 进行标准发现。

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

// 最小示例：使用 DefaultResourceLoader 的默认配置
const { session } = await createAgentSession();

// 自定义：覆盖特定选项
const { session } = await createAgentSession({
  model: myModel,
  tools: [readTool, bashTool],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

Session 管理代理生命周期、消息历史、模型状态、压缩和事件流。

```typescript
interface AgentSession {
  // 发送提示并等待完成
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // 在流式输出中排队消息
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // 订阅事件（返回取消订阅函数）
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // 会话信息
  sessionFile: string | undefined;
  sessionId: string;

  // 模型控制
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // 状态访问
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // 在当前会话文件内进行原地树形导航
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // 压缩
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // 中止当前操作
  abort(): Promise<void>;

  // 清理
  dispose(): void;
}
```

会话替换 API（如新会话、恢复、分叉、导入）位于 `AgentSessionRuntime` 上，而非 `AgentSession`。

### createAgentSessionRuntime() 和 AgentSessionRuntime

当你需要替换活动会话并重建 cwd 绑定的运行时状态时，使用运行时 API。这是内置的交互模式、打印模式和 RPC 模式使用的同一层。

`createAgentSessionRuntime()` 接收运行时工厂函数加上初始 cwd/会话目标。工厂函数闭包捕获进程全局固定输入，为有效 cwd 重建 cwd 绑定的服务，根据这些服务解析会话选项，并返回完整的运行时结果。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` 负责在以下操作中替换活动运行时：

- `newSession()`
- `switchSession()`
- `fork()`
- 通过 `fork(entryId, { position: "at" })` 实现的克隆流程
- `importFromJsonl()`

重要行为：

- `runtime.session` 会在上述操作后变化
- 事件订阅绑定到特定的 `AgentSession`，因此替换后需要重新订阅
- 如果使用了扩展，需要对新 session 再次调用 `runtime.session.bindExtensions(...)`
- 创建操作会返回 `runtime.diagnostics` 中的诊断信息
- 如果运行时创建或替换失败，该方法会抛出异常，由调用方决定如何处理

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### 提示与消息排队

`PromptOptions` 控制提示展开、流式输出时的排队行为以及提示前置通知：

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

`preflightResult` 在每次 `prompt()` 调用时被调用一次：

- `true`：提示已接受、已排队或已立即处理
- `false`：提示前置检查在接受前已拒绝

它在 `prompt()` 解析前触发。`prompt()` 仍然只有在完整的已接受运行（包括重试）完成后才解析。接受后的失败通过正常的事件和消息流报告，而非通过 `preflightResult(false)`。

`prompt()` 方法处理提示模板、扩展命令和消息发送：

```typescript
// 基本提示（非流式输出时）
await session.prompt("这里有什么文件？");

// 带图片
await session.prompt("这张图片里是什么？", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// 流式输出中：必须指定如何排队消息
await session.prompt("停，改成做这个", { streamingBehavior: "steer" });
await session.prompt("做完后，顺便检查一下 X", { streamingBehavior: "followUp" });
```

**行为：**
- **扩展命令**（如 `/mycommand`）：立即执行，即使在流式输出中。它们通过 `pi.sendMessage()` 管理自己的 LLM 交互。
- **基于文件的提示模板**（来自 `.md` 文件）：先展开为内容再发送或排队。
- **流式输出中未指定 `streamingBehavior`**：抛出错误。直接使用 `steer()` 或 `followUp()`，或指定选项。
- **`preflightResult(true)`**：提示已接受、已排队或已立即处理。
- **`preflightResult(false)`**：前置检查在接受前已拒绝。

流式输出中的显式排队：

```typescript
// 排队一条转向消息，在当前助手轮次的工具调用完成后发送
await session.steer("新的指令");

// 等待代理完成（仅在代理停止时发送）
await session.followUp("做完后，顺便做这个");
```

`steer()` 和 `followUp()` 都会展开基于文件的提示模板，但会在扩展命令上报错（扩展命令无法排队）。

### Agent 和 AgentState

`Agent` 类（来自 `@mariozechner/pi-agent-core`）处理核心 LLM 交互。通过 `session.agent` 访问。

```typescript
// 访问当前状态
const state = session.agent.state;

// state.messages: AgentMessage[] - 对话历史
// state.model: Model - 当前模型
// state.thinkingLevel: ThinkingLevel - 当前思考级别
// state.systemPrompt: string - 系统提示词
// state.tools: AgentTool[] - 可用工具
// state.streamingMessage?: AgentMessage - 当前部分助手消息
// state.errorMessage?: string - 最新的助手错误

// 替换消息（适用于分支或恢复）
session.agent.state.messages = messages; // 复制顶层数组

// 替换工具
session.agent.state.tools = tools; // 复制顶层数组

// 等待代理完成处理
await session.agent.waitForIdle();
```

### 事件

订阅事件以接收流式输出和生命周期通知。

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // 来自助手的流式文本
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // 思考输出（如果开启了思考能力）
      }
      break;

    // 工具执行
    case "tool_execution_start":
      console.log(`工具：${event.toolName}`);
      break;
    case "tool_execution_update":
      // 流式工具输出
      break;
    case "tool_execution_end":
      console.log(`结果：${event.isError ? "错误" : "成功"}`);
      break;

    // 消息生命周期
    case "message_start":
      // 新消息开始
      break;
    case "message_end":
      // 消息完成
      break;

    // 代理生命周期
    case "agent_start":
      // 代理开始处理提示
      break;
    case "agent_end":
      // 代理完成（event.messages 包含新消息）
      break;

    // 轮次生命周期（一次 LLM 响应 + 工具调用）
    case "turn_start":
      break;
    case "turn_end":
      // event.message: 助手响应
      // event.toolResults: 本轮的工具结果
      break;

    // 会话事件（排队、压缩、重试）
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      break;
  }
});
```

## 选项参考

### 目录

```typescript
const { session } = await createAgentSession({
  // DefaultResourceLoader 发现的工作目录
  cwd: process.cwd(), // 默认值

  // 全局配置目录
  agentDir: "~/.pi/agent", // 默认值（展开 ~）
});
```

`cwd` 被 `DefaultResourceLoader` 用于：
- 项目扩展（`.pi/extensions/`）
- 项目技能：
  - `.pi/skills/`
  - `cwd` 及祖先目录中的 `.agents/skills/`（向上直到 Git 仓库根目录，不在仓库中时到文件系统根目录）
- 项目提示（`.pi/prompts/`）
- 上下文文件（从 cwd 向上查找 `AGENTS.md`）
- 会话目录命名

`agentDir` 被 `DefaultResourceLoader` 用于：
- 全局扩展（`extensions/`）
- 全局技能：
  - `agentDir` 下的 `skills/`（例如 `~/.pi/agent/skills/`）
  - `~/.agents/skills/`
- 全局提示（`prompts/`）
- 全局上下文文件（`AGENTS.md`）
- 设置（`settings.json`）
- 自定义模型（`models.json`）
- 凭据（`auth.json`）
- 会话（`sessions/`）

当你传入自定义 `ResourceLoader` 时，`cwd` 和 `agentDir` 不再控制资源发现。它们仍影响会话命名和工具路径解析。

### 模型

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// 查找特定的内置模型（不检查 API 密钥是否存在）
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("未找到模型");

// 按 provider/id 查找任意模型，包括来自 models.json 的自定义模型
// （不检查 API 密钥是否存在）
const customModel = modelRegistry.find("my-provider", "my-model");

// 仅获取已配置有效 API 密钥的模型
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh

  // 用于循环切换的模型（交互模式中的 Ctrl+P）
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],

  authStorage,
  modelRegistry,
});
```

如果未提供模型：
1. 尝试从会话恢复（如果继续会话）
2. 使用设置中的默认值
3. 回退到第一个可用模型

> 参考 [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API 密钥和 OAuth

API 密钥解析优先级（由 AuthStorage 处理）：
1. 运行时覆盖（通过 `setRuntimeApiKey`，不持久化）
2. `auth.json` 中存储的凭据（API 密钥或 OAuth 令牌）
3. 环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）
4. 回退解析器（用于来自 `models.json` 的自定义 provider 密钥）

```typescript
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

// 默认：使用 ~/.pi/agent/auth.json 和 ~/.pi/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// 运行时 API 密钥覆盖（不持久化到磁盘）
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// 自定义凭据存储位置
const customAuth = AuthStorage.create("/my/app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/my/app/models.json");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: customAuth,
  modelRegistry: customRegistry,
});

// 无自定义 models.json（仅内置模型）
const simpleRegistry = ModelRegistry.inMemory(authStorage);
```

> 参考 [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### 系统提示词

使用 `ResourceLoader` 覆盖系统提示词：

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "你是一个有帮助的助手。",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参考 [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### 工具

```typescript
import {
  codingTools,   // read, bash, edit, write（默认）
  readOnlyTools, // read, grep, find, ls
  readTool, bashTool, editTool, writeTool,
  grepTool, findTool, lsTool,
} from "@mariozechner/pi-coding-agent";

// 使用内置工具集
const { session } = await createAgentSession({
  tools: readOnlyTools,
});

// 选择特定工具
const { session } = await createAgentSession({
  tools: [readTool, bashTool, grepTool],
});
```

#### 自定义 cwd 的工具

**重要：** 预构建的工具实例（`readTool`、`bashTool` 等）使用 `process.cwd()` 进行路径解析。当你指定自定义 `cwd` 且同时提供显式的 `tools` 时，必须使用工具工厂函数以确保路径正确解析：

```typescript
import {
  createCodingTools,    // 为指定 cwd 创建 [read, bash, edit, write]
  createReadOnlyTools,  // 为指定 cwd 创建 [read, grep, find, ls]
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

const cwd = "/path/to/project";

// 使用工具集工厂
const { session } = await createAgentSession({
  cwd,
  tools: createCodingTools(cwd),  // 工具相对于 cwd 解析路径
});

// 或选择特定工具
const { session } = await createAgentSession({
  cwd,
  tools: [createReadTool(cwd), createBashTool(cwd), createGrepTool(cwd)],
});
```

**何时不需要工厂：**
- 如果省略 `tools`，pi 会自动以正确的 `cwd` 创建工具
- 如果你使用 `process.cwd()` 作为 `cwd`，预构建实例即可正常工作

**何时必须使用工厂：**
- 当你同时指定了 `cwd`（不同于 `process.cwd()`）和 `tools`

> 参考 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### 自定义工具

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@mariozechner/pi-coding-agent";

// 内联自定义工具
const myTool = defineTool({
  name: "my_tool",
  label: "我的工具",
  description: "做一些有用的事情",
  parameters: Type.Object({
    input: Type.String({ description: "输入值" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `结果：${params.input}` }],
    details: {},
  }),
});

// 直接传入自定义工具
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

使用 `defineTool()` 创建独立定义和数组，如 `customTools: [myTool]`。内联 `pi.registerTool({ ... })` 已能正确推断参数类型。

通过 `customTools` 传入的自定义工具与扩展注册的工具合并。ResourceLoader 加载的扩展也可以通过 `pi.registerTool()` 注册工具。

> 参考 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### 扩展

扩展由 `ResourceLoader` 加载。`DefaultResourceLoader` 从 `~/.pi/agent/extensions/`、`.pi/extensions/` 和 settings.json 扩展源中发现扩展。

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[内联扩展] 代理启动");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

扩展可以注册工具、订阅事件、添加命令等。完整 API 请参考 [extensions.md](extensions.md)。

**事件总线：** 扩展可以通过 `pi.events` 通信。如果需要在外部发送或监听事件，将共享的 `eventBus` 传递给 `DefaultResourceLoader`：

```typescript
import { createEventBus, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> 参考 [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) 和 [docs/extensions.md](extensions.md)

### 技能

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@mariozechner/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "自定义指令",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参考 [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### 上下文文件

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# 指南\n\n- 保持简洁" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参考 [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### 斜杠命令

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@mariozechner/pi-coding-agent";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "部署应用",
  source: "(custom)",
  content: "# 部署\n\n1. 构建\n2. 测试\n3. 部署",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 参考 [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### 会话管理

会话使用 `id`/`parentId` 链接的树形结构，支持原地分支。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// 内存模式（无持久化）
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// 新建持久化会话
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// 继续最近的会话
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("注意：", modelFallbackMessage);
}

// 打开特定文件
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// 列出会话
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// 用于 /new、/resume、/fork、/clone 和导入流程的会话替换 API
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// 用新会话替换活动会话
await runtime.newSession();

// 用其他已保存的会话替换活动会话
await runtime.switchSession("/path/to/session.jsonl");

// 从特定用户条目分叉替换活动会话
await runtime.fork("entry-id");

// 通过特定条目克隆活动路径
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager 树形 API：**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// 会话列表
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// 树形遍历
const entries = sm.getEntries();        // 所有条目（排除头部）
const tree = sm.getTree();              // 完整树结构
const path = sm.getPath();              // 从根到当前叶子节点的路径
const leaf = sm.getLeafEntry();         // 当前叶子条目
const entry = sm.getEntry(id);          // 按 ID 获取条目
const children = sm.getChildren(id);    // 条目的直接子节点

// 标签
const label = sm.getLabel(id);          // 获取条目标签
sm.appendLabelChange(id, "checkpoint"); // 设置标签

// 分支
sm.branch(entryId);                     // 将叶子节点移动到早期条目
sm.branchWithSummary(id, "摘要...");     // 带上下文摘要的分支
sm.createBranchedSession(leafId);       // 提取路径到新文件
```

> 参考 [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) 和 [Session Format](session-format.md)

### 设置管理

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@mariozechner/pi-coding-agent";

// 默认：从文件加载（全局 + 项目合并）
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// 带覆盖
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// 内存模式（无文件 I/O，用于测试）
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// 自定义目录
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**静态工厂方法：**
- `SettingsManager.create(cwd?, agentDir?)` - 从文件加载
- `SettingsManager.inMemory(settings?)` - 无文件 I/O

**项目特定设置：**

设置从两个位置加载并合并：
1. 全局：`~/.pi/agent/settings.json`
2. 项目：`<cwd>/.pi/settings.json`

项目覆盖全局。嵌套对象合并键值。setter 默认修改全局设置。

**持久化和错误处理语义：**

- 设置 getter/setter 对内存状态是同步的。
- Setter 异步排队持久化写入。
- 在需要持久化边界时（例如进程退出前或测试中断言文件内容前），调用 `await settingsManager.flush()`。
- `SettingsManager` 不会打印设置 I/O 错误。使用 `settingsManager.drainErrors()` 并在应用层报告。

> 参考 [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

使用 `DefaultResourceLoader` 发现扩展、技能、提示、主题和上下文文件。

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## 返回值

`createAgentSession()` 返回：

```typescript
interface CreateAgentSessionResult {
  // 会话
  session: AgentSession;

  // 扩展结果（用于运行环境设置）
  extensionsResult: LoadExtensionsResult;

  // 如果无法恢复会话模型的警告信息
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## 完整示例

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
  AuthStorage,
  bashTool,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  readTool,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

// 设置认证存储（自定义位置）
const authStorage = AuthStorage.create("/custom/agent/auth.json");

// 运行时 API 密钥覆盖（不持久化）
if (process.env.MY_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// 模型注册表（无自定义 models.json）
const modelRegistry = ModelRegistry.create(authStorage);

// 内联工具
const statusTool = defineTool({
  name: "status",
  label: "状态",
  description: "获取系统状态",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `运行时间：${process.uptime()}秒` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("未找到模型");

// 内存设置（带覆盖）
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "你是一个极简助手。请保持简洁。",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,

  tools: [readTool, bashTool],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("获取状态并列出文件。");
```

## 运行模式

SDK 导出运行模式工具，用于在 `createAgentSession()` 之上构建自定义界面：

### InteractiveMode

完整的 TUI 交互模式，包含编辑器、聊天历史和所有内置命令：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "你好",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

单次模式：发送提示、输出结果、退出：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "你好",
  initialImages: [],
  messages: ["后续问题"],
});
```

### runRpcMode

用于子进程集成的 JSON-RPC 模式：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

RPC JSON 协议请参考 [RPC 文档](rpc.md)。

## RPC 模式的替代方案

对于无需使用 SDK 构建的子进程集成，可以直接使用 CLI：

```bash
pi --mode rpc --no-session
```

JSON 协议请参考 [RPC 文档](rpc.md)。

**SDK 更适合：**
- 需要类型安全
- 处于同一 Node.js 进程中
- 需要直接访问代理状态
- 需要以编程方式自定义工具/扩展

**RPC 模式更适合：**
- 从其他语言集成
- 需要进程隔离
- 构建跨语言客户端

## 导出

主入口点导出以下内容：

```typescript
// 工厂函数
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// 认证和模型
AuthStorage
ModelRegistry

// 资源加载
DefaultResourceLoader
type ResourceLoader
createEventBus

// 辅助函数
defineTool

// 会话管理
SessionManager
SettingsManager

// 内置工具（使用 process.cwd()）
codingTools
readOnlyTools
readTool, bashTool, editTool, writeTool
grepTool, findTool, lsTool

// 工具工厂函数（用于自定义 cwd）
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// 类型
type CreateAgentSessionOptions
type CreateAgentSessionResult
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

扩展类型请参考 [extensions.md](extensions.md) 获取完整 API。
