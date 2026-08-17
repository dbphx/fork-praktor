import {
  BaseLlm,
  InMemorySessionService,
  LlmAgent,
  MCPToolset,
  Runner,
  getFunctionCalls,
  isFinalResponse,
  stringifyContent,
  type Event,
  type LlmRequest,
  type LlmResponse,
  type MCPConnectionParams,
  type ToolUnion,
} from "@google/adk";
import {
  query as queryClaude,
  type McpServerConfig as ClaudeMcpServerConfig,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { NatsBridge } from "./nats-bridge.js";
import { applyExtensions } from "./extensions.js";
import type { MCPServerConfig } from "./extensions.js";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL } from "url";
import { DatabaseSync } from "node:sqlite";

// Patch console to prepend timestamps matching gateway format (YYYY/MM/DD HH:MM:SS)
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
console.log = (...args: unknown[]) => origLog(ts(), ...args);
console.warn = (...args: unknown[]) => origWarn(ts(), ...args);
console.error = (...args: unknown[]) => origError(ts(), ...args);

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const AGENT_ID = process.env.AGENT_ID || process.env.GROUP_ID || "default";
type AgentBackend = "adk" | "claude";

function resolveAdkModel(): string {
  if (process.env.VLLM_MODEL) return process.env.VLLM_MODEL;
  if (process.env.ADK_MODEL) return process.env.ADK_MODEL;
  const legacyModel = process.env.CLAUDE_MODEL;
  if (legacyModel && !legacyModel.startsWith("claude-")) return legacyModel;
  return "gemini-flash-latest";
}
const ADK_MODEL = resolveAdkModel();
const VLLM_BASE_URL = process.env.VLLM_BASE_URL || process.env.OPENAI_BASE_URL || "";
const VLLM_API_KEY = process.env.VLLM_API_KEY || process.env.OPENAI_API_KEY || "";
function resolveClaudeModel(): string {
  const model = process.env.CLAUDE_MODEL || "";
  return model.startsWith("claude-") ? model : "claude-opus-4-7";
}
const CLAUDE_MODEL = resolveClaudeModel();
const HAS_ADK_CREDENTIALS = Boolean(
  process.env.VLLM_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.VLLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.VLLM_MODEL ||
  process.env.ADK_MODEL ||
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY
);
const HAS_CLAUDE_CREDENTIALS = Boolean(
  process.env.ANTHROPIC_API_KEY ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN
);
function resolveAgentBackend(): AgentBackend {
  const configured = (process.env.AGENT_BACKEND || "auto").trim().toLowerCase();
  if (configured === "adk" || configured === "claude") return configured;
  if (configured !== "auto") {
    console.warn(`[agent] unknown AGENT_BACKEND=${configured}, using auto`);
  }
  if (HAS_ADK_CREDENTIALS) return "adk";
  if (HAS_CLAUDE_CREDENTIALS) return "claude";
  return "adk";
}
const AGENT_BACKEND = resolveAgentBackend();
const ALLOWED_TOOLS_ENV = process.env.ALLOWED_TOOLS || "";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "200", 10);
const SWARM_CHAT_TOPIC = process.env.SWARM_CHAT_TOPIC || "";
const SWARM_ROLE = process.env.SWARM_ROLE || "";
// agent-browser is driven through its typed MCP server (v0.28.0+).
// AGENT_BROWSER_MCP selects the tool profile passed to `agent-browser mcp
// --tools` (default "core"; composable, e.g. "core,network,react").
// See `agent-browser mcp --help`.
const AGENT_BROWSER_INSTALLED = existsSync("/usr/local/bin/agent-browser");
const AGENT_BROWSER_MCP_TOOLS = (process.env.AGENT_BROWSER_MCP || "core").trim() || "core";

let bridge: NatsBridge;
let isProcessing = false;
let lastSessionId: string | undefined;
let currentAbortController: AbortController | null = null;
let aborted = false;
// Per-query background task counter. Incremented on SDK `task_started`,
// decremented on `task_notification`. Scoped by query key so counts can
// never leak across queries — the entry is deleted in the query's finally.
export const backgroundTasksByQuery = new Map<string, number>();
let taskKeyCounter = 0;
export function incBg(key: string): void {
  backgroundTasksByQuery.set(key, (backgroundTasksByQuery.get(key) ?? 0) + 1);
}
export function decBg(key: string): void {
  const n = backgroundTasksByQuery.get(key) ?? 0;
  if (n > 1) backgroundTasksByQuery.set(key, n - 1);
  else backgroundTasksByQuery.delete(key);
}
export function totalBgTasks(): number {
  let total = 0;
  for (const v of backgroundTasksByQuery.values()) total += v;
  return total;
}
let extensionMcpServers: Record<string, MCPServerConfig> = {};
const pendingMessages: Array<Record<string, unknown>> = [];

const sessionService = new InMemorySessionService();
const activeAbortControllers = new Map<string, AbortController>();
const activeToolsets = new Set<MCPToolset>();

// Parallel task execution
const MAX_PARALLEL_TASKS = parseInt(process.env.MAX_PARALLEL_TASKS || "3", 10);
let activeTaskCount = 0;
const pendingTasks: Array<Record<string, unknown>> = [];

// Swarm collaborative chat buffer
interface ChatMessage {
  from: string;
  content: string;
  timestamp: number;
}
const chatHistory: ChatMessage[] = [];

export function parseAllowedTools(env: string): string[] | undefined {
  if (!env) return undefined;
  const tools = env.split(",").map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function installGlobalInstructions(): void {
  // Write global instructions to ~/.claude/CLAUDE.md (user-level).
  // Claude Code automatically loads both user-level and project-level CLAUDE.md,
  // so we only need to write the global one here. The per-agent CLAUDE.md in
  // /workspace/agent/ is loaded automatically as the project-level file.
  try {
    const global = readFileSync("/workspace/global/CLAUDE.md", "utf-8");
    const userClaudeDir = "/home/praktor/.claude";
    mkdirSync(userClaudeDir, { recursive: true });
    writeFileSync(`${userClaudeDir}/CLAUDE.md`, global);
    console.log(`[agent] installed global instructions to ${userClaudeDir}/CLAUDE.md`);
  } catch (err) {
    console.warn("[agent] could not install global instructions:", err);
  }
}

const agentMdTemplate = `# Agent Identity

## Name
(Agent display name)

## Vibe
(Personality, communication style)

## Expertise
(Areas of specialization)
`;

function ensureAgentMd(): void {
  const path = "/workspace/agent/AGENT.md";
  if (!existsSync(path)) {
    try {
      writeFileSync(path, agentMdTemplate);
      console.log("[agent] created AGENT.md template");
    } catch (err) {
      console.warn("[agent] could not create AGENT.md:", err);
    }
  }
}

function setupAgentBrowser(): void {
  // agent-browser is driven via its typed MCP server, so no usage-guide skill
  // is injected — only the config symlink (chromium path) is needed.
  const configSource = "/usr/local/share/agent-browser/config.json";
  if (!AGENT_BROWSER_INSTALLED) return;

  try {
    const skillsDir = "/home/praktor/.claude/skills";
    mkdirSync(skillsDir, { recursive: true });

    // Remove stale skill symlinks from previous image versions (the old
    // playwright-cli / agent-browser links, and the `core` usage-guide skill
    // that earlier versions injected before the switch to the MCP server).
    for (const [name, target] of [
      ["playwright-cli", "/opt/playwright-cli/skill"],
      ["agent-browser", "/usr/local/share/agent-browser/skills/agent-browser"],
      ["core", "/usr/local/share/agent-browser/skills/core"],
    ] as const) {
      const staleLink = join(skillsDir, name);
      try {
        if (lstatSync(staleLink).isSymbolicLink() && readlinkSync(staleLink) === target) {
          unlinkSync(staleLink);
          console.log(`[agent] removed stale ${name} skill symlink`);
        }
      } catch { /* doesn't exist */ }
    }

    // Force-update config symlink
    const configDir = "/home/praktor/.agent-browser";
    mkdirSync(configDir, { recursive: true });
    const configLink = join(configDir, "config.json");
    try { unlinkSync(configLink); } catch { /* doesn't exist */ }
    symlinkSync(configSource, configLink);

    console.log("[agent] agent-browser configured (MCP)");
  } catch (err) {
    console.warn("[agent] could not configure agent-browser:", err);
  }
}

function setupAgentMail(): void {
  const skillSource = "/opt/agentmail-skill";
  if (!process.env.AGENTMAIL_API_KEY || !existsSync(join(skillSource, "SKILL.md"))) return;

  try {
    const skillsDir = "/home/praktor/.claude/skills";
    mkdirSync(skillsDir, { recursive: true });

    const skillLink = join(skillsDir, "agentmail-cli");
    try { unlinkSync(skillLink); } catch { /* doesn't exist */ }
    symlinkSync(skillSource, skillLink);

    console.log("[agent] agentmail-cli skill configured");
  } catch (err) {
    console.warn("[agent] could not configure agentmail-cli:", err);
  }
}

function setupWorkspaceSkills(): void {
  const skillSourceDir = "/workspace/agent/skills";
  if (!existsSync(skillSourceDir)) return;

  try {
    const skillsDir = "/home/praktor/.claude/skills";
    mkdirSync(skillsDir, { recursive: true });

    for (const entry of readdirSync(skillSourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const source = join(skillSourceDir, entry.name);
      if (!existsSync(join(source, "SKILL.md"))) continue;

      const target = join(skillsDir, entry.name);
      try { rmSync(target, { recursive: true, force: true }); } catch { /* doesn't exist */ }
      symlinkSync(source, target);
      console.log(`[agent] workspace skill configured: ${entry.name}`);
    }
  } catch (err) {
    console.warn("[agent] could not configure workspace skills:", err);
  }
}

function loadSystemPrompt(includeIdentity = true): string {
  const parts: string[] = [];
  const now = new Date();
  parts.push(
    "RUNTIME CONTEXT\n" +
    `- Current local time: ${now.toString()}\n` +
    `- Current UTC time: ${now.toISOString()}\n` +
    `- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "unknown"}\n` +
    "- For relative time requests like today, now, last 15 minutes, or yesterday, use this runtime context. Do not invent a different current date."
  );

  // User profile (loaded before global instructions so agents know the user)
  try {
    const user = readFileSync("/workspace/global/USER.md", "utf-8");
    parts.push(user);
  } catch {
    // User profile not available
  }

  // Agent identity (excluded for routing queries to avoid personality bleed)
  if (includeIdentity) {
    try {
      const agent = readFileSync("/workspace/agent/AGENT.md", "utf-8");
      parts.push(
        "The following is your agent identity. " +
        "This is stored at /workspace/agent/AGENT.md and you can update it " +
        "anytime using the Edit or Write tool (e.g. to set your name, vibe, or expertise).\n\n" +
        agent
      );
    } catch {
      // Agent identity not available
    }
  }

  // Include global instructions in system prompt as well (belt and suspenders)
  try {
    const global = readFileSync("/workspace/global/CLAUDE.md", "utf-8");
    parts.push(global);
  } catch {
    // Global instructions not available
  }

  // Nix package manager: detect nix-daemon and inform agent
  try {
    execSync("pgrep -l nix-daemon", { timeout: 5000 });
    parts.push(
      "NIX PACKAGE MANAGER — You have the nix package manager available.\n" +
      "- When a task requires a tool or language not present in the container, use nix to install it.\n" +
      "- Use the `nix_search` MCP tool to find packages, and `nix_add` to install them.\n" +
      "- Use `nix_list_installed` to see what's already installed.\n" +
      "- Example: if asked to run a Python script and python is missing, install it with nix_add(package: \"python3\") first.\n" +
      "- Always check if a command exists before installing (e.g. `which python3`)."
    );
  } catch {
    // nix-daemon not running, skip
  }

  // Messaging: explain how agent responses reach the user
  parts.push(
    "MESSAGING — Your text responses are automatically delivered to the user via Telegram.\n" +
    "- To send a message, simply reply with text — no special tool is needed.\n" +
    "- The file_send tool is ONLY for sending binary files (images, PDFs, etc.), NOT for text messages. NEVER create .txt files to deliver text content.\n" +
    "- When executing scheduled tasks, your text reply IS the notification the user receives.\n" +
    "- Keep scheduled task replies short and direct — the user sees them as Telegram messages."
  );

  // Telegram formatting: instruct agent to use Telegram-compatible Markdown
  parts.push(
    "TELEGRAM FORMATTING — Your messages are rendered in Telegram, which only supports MarkdownV1.\n" +
    "- Bold: *text* (single asterisks, NOT **double**)\n" +
    "- Italic: _text_\n" +
    "- Inline code: `code`\n" +
    "- Code blocks: ```code```\n" +
    "- Links: [text](url)\n" +
    "- DO NOT use: # headers, - bullet lists, --- horizontal rules, ![]()" +
    " image embeds — these render as raw text in Telegram.\n" +
    "- Instead of headers, use *bold text* on its own line.\n" +
    "- Instead of bullet lists with - or *, use • (bullet character) or numbered lists."
  );

  // Security: prevent agents from revealing secret values
  parts.push(
    "SECURITY — MANDATORY RULES:\n" +
    "- NEVER reveal, print, or include the values of environment variables that contain secrets, tokens, API keys, passwords, or credentials.\n" +
    "- NEVER read or output the contents of secret files (e.g. service account JSON files, SSH keys, certificates).\n" +
    "- NEVER include secrets, tokens, API keys, passwords, or credentials in emails. The same redaction rules apply to email as to Telegram.\n" +
    "- If the user asks for a secret value, respond with [REDACTED] in place of the value and explain that secrets cannot be disclosed.\n" +
    "- You may confirm that a secret or env var EXISTS, but must NEVER show its value — always use [REDACTED] as placeholder."
  );

  // Conversation history: instruct agent to search when context is missing
  parts.push(
    "CONVERSATION HISTORY — You have access to the full conversation history via the history_search MCP tool.\n" +
    "- When the user references a previous conversation, topic, or decision you don't have in your current context, ALWAYS search history before saying you don't know.\n" +
    "- Use history_search with relevant keywords from the user's message to find past discussions.\n" +
    "- This is especially important after a session restart — your conversation memory resets but the full history is preserved and searchable.\n" +
    "- NEVER say you don't have information or context without searching history first."
  );

  // Memory: list existing keys so the agent knows what's stored
  try {
    const MEMORY_DB_PATH = "/workspace/agent/memory.db";
    let memorySection =
      "MEMORY — You have persistent memory via MCP tools (memory_store, memory_recall, memory_forget, memory_delete, memory_list).\n" +
      "- To remember: call memory_store with a short key and content\n" +
      "- To recall: call memory_recall with a keyword to search\n" +
      "- To forget: call memory_forget with a search query";

    if (existsSync(MEMORY_DB_PATH)) {
      const db = new DatabaseSync(MEMORY_DB_PATH);
      // access_count may not exist yet on older databases
      let rows: Array<{ key: string; tags: string; access_count?: number }>;
      try {
        rows = db.prepare(
          "SELECT key, tags, access_count FROM memories ORDER BY updated_at DESC"
        ).all() as typeof rows;
      } catch {
        rows = db.prepare(
          "SELECT key, tags FROM memories ORDER BY updated_at DESC"
        ).all() as typeof rows;
      }
      db.close();

      if (rows.length > 0) {
        memorySection += `\n\nYou currently have ${rows.length} stored memories:\n`;
        memorySection += rows
          .map((r) => {
            let line = `- ${r.key}`;
            if (r.tags) line += ` [${r.tags}]`;
            if (r.access_count) line += ` (${r.access_count}x)`;
            return line;
          })
          .join("\n");
        memorySection += "\n\nCall memory_recall with a relevant keyword to retrieve full content before answering.";
        memorySection += " memory_recall uses hybrid search combining keyword matching with semantic similarity — use natural language queries for best results.";
      }
    }
    parts.push(memorySection);
  } catch (err) {
    console.warn("[agent] could not load memory keys:", err);
  }

  // agent-browser: inform agent it's pre-installed (system chromium) and
  // exposed through its typed MCP tools.
  if (AGENT_BROWSER_INSTALLED) {
    parts.push(
      "AGENT-BROWSER — Pre-installed, exposed as typed MCP tools. Do NOT install browsers via npm, npx, nix, or any other method.\n" +
      "- Browser automation is available as `mcp__agent-browser__agent_browser_*` tools (configured to use the system Chromium).\n" +
      "- Use `agent_browser_open` to start a session, then `agent_browser_snapshot` to see the page.\n" +
      "- Do NOT call the `agent-browser` CLI via Bash — use the MCP tools instead.\n" +
      "- The browser persists across messages. Reuse the existing session.\n" +
      "- When executing a scheduled task, ALWAYS call `agent_browser_close` when done to free resources."
    );
  }

  // AgentMail: inbox-locked restrictions when configured
  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    parts.push(
      "AGENTMAIL — MANDATORY RULES:\n" +
      `- Your inbox ID is: ${process.env.AGENTMAIL_INBOX_ID}. You MUST use ONLY this inbox ID for ALL agentmail operations.\n` +
      "- NEVER use, access, list, or reference any other inbox ID, even if the user asks.\n" +
      "- NEVER create new inboxes.\n" +
      "- NEVER use pods, webhooks, or domains commands. These are admin-only operations.\n" +
      "- NEVER include secrets, tokens, API keys, passwords, or credentials in emails.\n" +
      "- The same secret redaction rules that apply to Telegram apply to email — use [REDACTED] for any secret values.\n" +
      "- EMAIL FORMATTING: Emails are NOT Telegram messages. Do NOT use Telegram Markdown formatting or escape characters in emails. " +
      "Write emails in plain text with natural punctuation. No backslash escaping, no *bold*, no `code` — just normal text."
    );
  }

  // Skills: load installed SKILL.md files into prompt
  const skillsDir = "/home/praktor/.claude/skills";
  try {
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = readFileSync(skillMd, "utf-8");
          parts.push(`SKILL: ${entry.name}\n\n${content}`);
        } catch {
          // SKILL.md not found in this directory, skip
        }
      }
    }
  } catch {
    // skills directory not accessible, skip
  }

  return parts.join("\n\n---\n\n");
}

export function inferTerminalReason(errorMsg: string): string | undefined {
  if (/maximum number of turns/i.test(errorMsg)) return "max_turns";
  if (/blocking.*limit/i.test(errorMsg)) return "blocking_limit";
  if (/abort/i.test(errorMsg)) return "aborted_tools";
  return undefined;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function contentToOpenAIMessages(content: { role?: string; parts?: Array<Record<string, unknown>> }): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const role = content.role === "model" ? "assistant" : "user";
  const text = content.parts
    ?.map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("");
  const toolCalls = content.parts
    ?.map((part) => part.functionCall as Record<string, unknown> | undefined)
    .filter((call): call is Record<string, unknown> => Boolean(call))
    .map((call, index) => ({
      id: String(call.id || `call_${index}`),
      type: "function" as const,
      function: {
        name: String(call.name || ""),
        arguments: JSON.stringify(call.args || {}),
      },
    }))
    .filter((call) => call.function.name);

  if (text || toolCalls?.length || role === "assistant") {
    messages.push({
      role,
      content: text || null,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    });
  }

  for (const part of content.parts || []) {
    const response = part.functionResponse as Record<string, unknown> | undefined;
    if (!response) continue;
    messages.push({
      role: "tool",
      tool_call_id: String(response.id || response.name || ""),
      content: JSON.stringify(response.response || {}),
    });
  }

  return messages;
}

function openAIToolsFromRequest(llmRequest: LlmRequest): Array<Record<string, unknown>> {
  const tools = llmRequest.config?.tools || [];
  const declarations = tools.flatMap((tool) => {
    const maybeTool = tool as { functionDeclarations?: Array<Record<string, unknown>> };
    return maybeTool.functionDeclarations || [];
  });
  return declarations.map((decl) => ({
    type: "function",
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters || { type: "object", properties: {} },
    },
  }));
}

class VllmOpenAICompatibleLlm extends BaseLlm {
  private readonly baseURL: string;
  private readonly apiKey: string;

  constructor({ model, baseURL, apiKey }: { model: string; baseURL: string; apiKey: string }) {
    super({ model });
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const messages: OpenAIMessage[] = [];
    const systemInstruction = llmRequest.config?.systemInstruction;
    if (typeof systemInstruction === "string" && systemInstruction.trim()) {
      messages.push({ role: "system", content: systemInstruction });
    }
    for (const content of llmRequest.contents) {
      messages.push(...contentToOpenAIMessages(content as { role?: string; parts?: Array<Record<string, unknown>> }));
    }

    const tools = openAIToolsFromRequest(llmRequest);
    const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llmRequest.model || this.model,
        messages,
        stream,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
      signal: abortSignal,
    });
    if (!response.ok) {
      yield {
        errorCode: String(response.status),
        errorMessage: await response.text(),
      };
      return;
    }

    if (!stream) {
      const data = await response.json() as Record<string, unknown>;
      yield this.responseFromOpenAIMessage(((data.choices as Array<Record<string, unknown>>)?.[0]?.message || {}) as Record<string, unknown>);
      return;
    }

    yield* this.streamOpenAIResponse(response);
  }

  async connect(): Promise<never> {
    throw new Error("vLLM OpenAI-compatible adapter does not support ADK live connections");
  }

  private responseFromOpenAIMessage(message: Record<string, unknown>): LlmResponse {
    const toolCalls = (message.tool_calls as Array<Record<string, unknown>> | undefined) || [];
    if (toolCalls.length) {
      return {
        content: {
          role: "model",
          parts: toolCalls.map((call) => {
            const fn = (call.function || {}) as Record<string, unknown>;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(String(fn.arguments || "{}")); } catch { /* keep empty args */ }
            return {
              functionCall: {
                id: String(call.id || ""),
                name: String(fn.name || ""),
                args,
              },
            };
          }),
        },
      };
    }
    return {
      content: {
        role: "model",
        parts: [{ text: String(message.content || "") }],
      },
    };
  }

  private async *streamOpenAIResponse(response: Response): AsyncGenerator<LlmResponse, void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const data = JSON.parse(payload) as Record<string, unknown>;
        const delta = (((data.choices as Array<Record<string, unknown>>)?.[0]?.delta || {}) as Record<string, unknown>);
        if (typeof delta.content === "string" && delta.content) {
          yield { content: { role: "model", parts: [{ text: delta.content }] }, partial: true };
        }
        for (const call of (delta.tool_calls as Array<Record<string, unknown>> | undefined) || []) {
          const index = Number(call.index || 0);
          const fn = (call.function || {}) as Record<string, unknown>;
          const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
          if (call.id) current.id = String(call.id);
          if (fn.name) current.name += String(fn.name);
          if (fn.arguments) current.arguments += String(fn.arguments);
          toolCalls.set(index, current);
        }
      }
    }

    if (toolCalls.size) {
      yield {
        content: {
          role: "model",
          parts: [...toolCalls.values()].map((call) => {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.arguments || "{}"); } catch { /* keep empty args */ }
            return { functionCall: { id: call.id, name: call.name, args } };
          }),
        },
      };
    }
  }
}

function buildModel(): string | BaseLlm {
  if (VLLM_BASE_URL) {
    return new VllmOpenAICompatibleLlm({
      model: ADK_MODEL,
      baseURL: VLLM_BASE_URL,
      apiKey: VLLM_API_KEY,
    });
  }
  return ADK_MODEL;
}

function sanitizeToolPrefix(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function toAdkMcpConnection(srv: MCPServerConfig): MCPConnectionParams {
  if (srv.type === "stdio") {
    return {
      type: "StdioConnectionParams",
      serverParams: {
        command: srv.command,
        args: srv.args || [],
        env: srv.env,
      },
    };
  }
  return {
    type: "StreamableHTTPConnectionParams",
    url: srv.url,
    transportOptions: srv.headers ? { requestInit: { headers: srv.headers } } : undefined,
  };
}

function buildMcpServers(): Record<string, MCPServerConfig> {
  const mcpServers: Record<string, MCPServerConfig> = {
    "praktor-tasks": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-tasks.mjs"],
      env: { NATS_URL, AGENT_ID },
    },
    "praktor-profile": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-profile.mjs"],
      env: { NATS_URL, AGENT_ID },
    },
    "praktor-memory": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-memory.mjs"],
      env: {},
    },
    "praktor-nix": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-nix.mjs"],
      env: {},
    },
    "praktor-file": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-file.mjs"],
      env: { NATS_URL, AGENT_ID },
    },
    "praktor-history": {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-history.mjs"],
      env: { NATS_URL, AGENT_ID },
    },
    ...extensionMcpServers,
  };
  if (process.env.LOG_API_URL) {
    mcpServers["praktor-log-api"] = {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-log-api.mjs"],
      env: {
        LOG_API_URL: process.env.LOG_API_URL,
        LOG_API_TOKEN_FILE: process.env.LOG_API_TOKEN_FILE || "/workspace/.log_api_key",
      },
    };
  }
  if (SWARM_CHAT_TOPIC) {
    mcpServers["praktor-swarm"] = {
      type: "stdio",
      command: "node",
      args: ["/app/mcp-swarm.mjs"],
      env: { NATS_URL, AGENT_ID, SWARM_CHAT_TOPIC },
    };
  }
  // agent-browser typed MCP server (v0.28.0+). Tools surface as
  // mcp__agent-browser__*; profile selected by AGENT_BROWSER_MCP (default core).
  if (AGENT_BROWSER_INSTALLED) {
    mcpServers["agent-browser"] = {
      type: "stdio",
      command: "/usr/local/bin/agent-browser",
      args: ["mcp", "--tools", AGENT_BROWSER_MCP_TOOLS],
      env: {},
    };
  }

  return mcpServers;
}

function buildMcpToolsets(): MCPToolset[] {
  const tools = parseAllowedTools(ALLOWED_TOOLS_ENV);

  return Object.entries(buildMcpServers()).map(([name, srv]) => {
    return new MCPToolset(toAdkMcpConnection(srv), tools || [], sanitizeToolPrefix(name));
  });
}

function toClaudeMcpServer(srv: MCPServerConfig): ClaudeMcpServerConfig {
  if (srv.type === "stdio") {
    return {
      type: "stdio",
      command: srv.command,
      args: srv.args || [],
      env: srv.env,
    };
  }
  return {
    type: "http",
    url: srv.url,
    headers: srv.headers,
  };
}

function buildClaudeMcpServers(): Record<string, ClaudeMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(buildMcpServers()).map(([name, srv]) => [name, toClaudeMcpServer(srv)])
  );
}

function buildRunner(): { runner: Runner; toolsets: MCPToolset[] } {
  const toolsets = buildMcpToolsets();
  const agent = new LlmAgent({
    name: sanitizeToolPrefix(AGENT_ID) || "praktor_agent",
    model: buildModel(),
    instruction: loadSystemPrompt() || undefined,
    tools: toolsets as ToolUnion[],
  });
  return {
    runner: new Runner({
      appName: "praktor",
      agent,
      sessionService,
    }),
    toolsets,
  };
}

async function* runAdk(
  prompt: string,
  sessionId: string,
  abortSignal?: AbortSignal
): AsyncGenerator<Event, void, undefined> {
  await sessionService.getOrCreateSession({
    appName: "praktor",
    userId: AGENT_ID,
    sessionId,
  });
  const { runner, toolsets } = buildRunner();
  for (const toolset of toolsets) activeToolsets.add(toolset);
  try {
    yield* runner.runAsync({
      userId: AGENT_ID,
      sessionId,
      newMessage: { role: "user", parts: [{ text: prompt }] },
      runConfig: { maxLlmCalls: MAX_TURNS },
      abortSignal,
    });
  } finally {
    for (const toolset of toolsets) {
      activeToolsets.delete(toolset);
      try { await toolset.close(); } catch { /* ignore */ }
    }
  }
}

interface AgentRunEvent {
  backend: AgentBackend;
  partial: boolean;
  final: boolean;
  text: string;
  toolNames: string[];
  terminalReason?: string;
  sessionId?: string;
}

async function* runAgent(
  prompt: string,
  sessionId: string,
  abortController: AbortController,
  opts: { maxTurns?: number; routing?: boolean; resume?: boolean } = {}
): AsyncGenerator<AgentRunEvent, void, undefined> {
  if (AGENT_BACKEND === "claude") {
    yield* runClaude(prompt, abortController, opts);
    return;
  }

  for await (const event of runAdk(prompt, sessionId, abortController.signal)) {
    yield {
      backend: "adk",
      partial: Boolean(event.partial),
      final: isFinalResponse(event),
      text: eventText(event),
      toolNames: eventToolNames(event),
      terminalReason: event.errorCode || undefined,
      sessionId,
    };
    if (event.errorCode || event.errorMessage) break;
  }
}

async function* runClaude(
  prompt: string,
  abortController: AbortController,
  opts: { maxTurns?: number; routing?: boolean; resume?: boolean } = {}
): AsyncGenerator<AgentRunEvent, void, undefined> {
  const allowedTools = parseAllowedTools(ALLOWED_TOOLS_ENV);
  const result = queryClaude({
    prompt,
    options: {
      abortController,
      cwd: "/workspace/agent",
      model: CLAUDE_MODEL,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      maxTurns: opts.maxTurns ?? MAX_TURNS,
      mcpServers: opts.routing ? {} : buildClaudeMcpServers(),
      allowedTools,
      includePartialMessages: true,
      resume: opts.resume ? lastSessionId : undefined,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "praktor-agent-runner",
      },
    },
  });

  for await (const message of result) {
    yield claudeMessageToRunEvent(message);
  }
}

function claudeMessageToRunEvent(message: SDKMessage): AgentRunEvent {
  if (message.type === "stream_event") {
    const event = message.event as unknown as Record<string, unknown>;
    const delta = (event.delta || {}) as Record<string, unknown>;
    const text = typeof delta.text === "string" ? delta.text : "";
    return {
      backend: "claude",
      partial: Boolean(text),
      final: false,
      text,
      toolNames: [],
      sessionId: message.session_id,
    };
  }

  if (message.type === "assistant") {
    const content = (message.message.content || []) as unknown as Array<Record<string, unknown>>;
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text || ""))
      .join("");
    const toolNames = content
      .filter((block) => block.type === "tool_use" && block.name)
      .map((block) => String(block.name));
    return {
      backend: "claude",
      partial: false,
      final: false,
      text,
      toolNames,
      terminalReason: message.error,
      sessionId: message.session_id,
    };
  }

  if (message.type === "result") {
    return {
      backend: "claude",
      partial: false,
      final: true,
      text: message.subtype === "success" ? message.result : (message.errors || []).join("\n"),
      toolNames: [],
      terminalReason: message.terminal_reason || (message.subtype === "success" ? undefined : message.subtype),
      sessionId: message.session_id,
    };
  }

  return {
    backend: "claude",
    partial: false,
    final: false,
    text: "",
    toolNames: [],
    sessionId: "session_id" in message ? String(message.session_id || "") : undefined,
  };
}

function eventText(event: Event): string {
  return stringifyContent(event).trim();
}

function eventToolNames(event: Event): string[] {
  return getFunctionCalls(event)
    .map((call) => call.name)
    .filter((name): name is string => Boolean(name));
}

// Execute a scheduled task in parallel (fresh session, no resume)
interface TaskResponseSignals {
  result: string;
  hasStreamedOutput: boolean;
  hasFileSent: boolean;
}

interface TaskResponseDecision {
  content: string;
  warn: boolean;
}

// Decides what to publish as a task's final result message. Silent
// completions publish empty content (the gateway drops it before Telegram)
// and only surface as an internal warn log — the user-facing marker was
// noisy and unhelpful.
export function decideTaskFinalResponse(
  signals: TaskResponseSignals
): TaskResponseDecision {
  if (signals.result) {
    return { content: signals.result, warn: false };
  }
  if (signals.hasStreamedOutput) {
    return { content: "[response was streamed]", warn: false };
  }
  if (signals.hasFileSent) {
    return { content: "", warn: false };
  }
  return { content: "", warn: true };
}

async function executeTask(data: Record<string, unknown>): Promise<void> {
  const text = data.text as string;
  const msgId = data.msg_id as string | undefined;
  const bgKey = msgId ?? `__task-${++taskKeyCounter}`;
  console.log(`[task] executing parallel task: ${text.substring(0, 100)}...`);

  // Hoisted to function scope so the outer catch can read terminalReason —
  // the previous block-scoped declaration crashed the catch with a
  // ReferenceError, swallowing the failure path silently.
  let fullResponse = "";
  let terminalReason: string | undefined;
  let hasStreamedOutput = false;
  let hasFileSent = false;

  try {
    const controller = new AbortController();
    if (msgId) activeAbortControllers.set(msgId, controller);
    const sessionId = msgId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    console.log(`[task] starting ${AGENT_BACKEND} run`);
    const result = runAgent(text, sessionId, controller, { resume: false });

    try {
      for await (const event of result) {
        if (event.terminalReason) {
          terminalReason = event.terminalReason;
          break;
        }
        for (const name of event.toolNames) {
          console.log(`[task] tool: ${name}`);
          if (name.endsWith("file_send")) {
            hasFileSent = true;
          }
        }
        const textChunk = event.text;
        if (textChunk && event.partial) {
          hasStreamedOutput = true;
          await bridge.publishOutput(textChunk, "text", msgId);
        } else if (textChunk && event.final) {
          fullResponse = textChunk;
        }
      }
    } catch (streamErr) {
      if (fullResponse || hasStreamedOutput || hasFileSent) {
        console.warn(`[task] ${AGENT_BACKEND} run exited with error after output, ignoring:`, streamErr);
      } else {
        throw streamErr;
      }
    } finally {
      if (msgId) activeAbortControllers.delete(msgId);
    }

    if (!aborted) {
      const decision = decideTaskFinalResponse({
        result: fullResponse,
        hasStreamedOutput,
        hasFileSent,
      });
      if (decision.warn) {
        console.warn(`[task] completed with no output (msg_id=${msgId}, terminal=${terminalReason ?? "none"})`);
      }
      await bridge.publishResult(decision.content, msgId, terminalReason);
    }
    if (terminalReason && terminalReason !== "completed") {
      console.log(`[task] completed (terminal_reason: ${terminalReason})`);
    } else {
      console.log(`[task] completed`);
    }
  } catch (err) {
    if (aborted) {
      console.log("[task] aborted");
      return;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    const reason = terminalReason || inferTerminalReason(errorMsg);
    console.error(`[task] error:`, err);
    await bridge.publishResult(`Error: ${errorMsg}`, msgId, reason);
  } finally {
    if (msgId) activeAbortControllers.delete(msgId);
    backgroundTasksByQuery.delete(bgKey);
    activeTaskCount--;
    // Dequeue next pending task
    if (pendingTasks.length > 0) {
      const next = pendingTasks.shift()!;
      activeTaskCount++;
      console.log(`[task] dequeuing next task (${pendingTasks.length} remaining)`);
      executeTask(next);
    }
  }
}

async function handleMessage(data: Record<string, unknown>): Promise<void> {
  const text = data.text as string;
  if (!text) return;

  const sender = data.sender as string | undefined;
  const msgId = data.msg_id as string | undefined;

  // Scheduled tasks run in parallel with fresh sessions
  if (sender === "scheduler") {
    if (activeTaskCount >= MAX_PARALLEL_TASKS) {
      pendingTasks.push(data);
      console.log(`[task] at capacity (${activeTaskCount}/${MAX_PARALLEL_TASKS}), queued (${pendingTasks.length} pending)`);
      return;
    }
    activeTaskCount++;
    executeTask(data);
    return;
  }

  // Regular messages: sequential with session continuity
  if (isProcessing) {
    pendingMessages.push(data);
    console.log(`[agent] already processing, queued message (${pendingMessages.length} pending)`);
    return;
  }

  isProcessing = true;
  aborted = false;
  const bgKey = "__regular";
  backgroundTasksByQuery.delete(bgKey);
  console.log(`[agent] processing message for agent ${AGENT_ID}: ${text.substring(0, 100)}...`);

  // Hoisted to function scope so the outer catch can read terminalReason —
  // the previous block-scoped declaration crashed the catch with a
  // ReferenceError, swallowing the failure path silently.
  let fullResponse = "";
  let terminalReason: string | undefined;
  let hasStreamedOutput = false;

  try {
    // Prepend swarm chat context if in collaborative mode
    let augmentedText = text;
    if (SWARM_CHAT_TOPIC && chatHistory.length > 0) {
      const chatContext = chatHistory
        .map((m) => `[${m.from}]: ${m.content}`)
        .join("\n");
      augmentedText = `## Collaborative Chat History\n\n${chatContext}\n\n---\n\n${text}`;
      console.log(`[agent] prepended ${chatHistory.length} chat messages to prompt`);
    }

    lastSessionId ||= `${AGENT_ID}-session`;
    const controller = new AbortController();
    currentAbortController = controller;
    console.log(`[agent] starting ${AGENT_BACKEND} run`);
    const result = runAgent(augmentedText, lastSessionId, controller, { resume: true });

    try {
      for await (const event of result) {
        console.log(`[agent] event: backend=${event.backend} partial=${event.partial ? "true" : "false"} final=${event.final ? "true" : "false"}`);
        if (event.sessionId) {
          lastSessionId = event.sessionId;
        }
        if (event.terminalReason) {
          terminalReason = event.terminalReason;
          break;
        }
        for (const name of event.toolNames) {
          console.log(`[agent] tool: ${name}`);
        }
        const textChunk = event.text;
        if (textChunk && event.partial) {
          hasStreamedOutput = true;
          await bridge.publishOutput(textChunk, "text", msgId);
        } else if (textChunk && event.final) {
          fullResponse = textChunk;
        }
      }
    } catch (streamErr) {
      if (fullResponse || hasStreamedOutput) {
        console.warn(`[agent] ${AGENT_BACKEND} run exited with error after output, ignoring:`, streamErr);
      } else {
        throw streamErr;
      }
    }

    // Send final result (skip if aborted — orchestrator already notified the user)
    if (!aborted) {
      if (!fullResponse && hasStreamedOutput) {
        fullResponse = "[response was streamed]";
      }
      if (fullResponse || terminalReason) {
        await bridge.publishResult(fullResponse, msgId, terminalReason);
      } else {
        // Interactive path: keep silence (user might have just sent "thanks"),
        // but log so silent failures are visible in container logs.
        console.warn(`[agent] completed with no output (msg_id=${msgId})`);
      }
    }

    console.log(`[agent] completed processing for agent ${AGENT_ID} (session=${lastSessionId}${terminalReason && terminalReason !== "completed" ? `, terminal_reason=${terminalReason}` : ""})`);
  } catch (err) {
    if (aborted) {
      console.log("[agent] query aborted by user");
      return;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    const reason = terminalReason || inferTerminalReason(errorMsg);
    console.error(`[agent] error processing message:`, err);
    await bridge.publishResult(`Error: ${errorMsg}`, msgId, reason);
  } finally {
    currentAbortController = null;
    isProcessing = false;
    backgroundTasksByQuery.delete(bgKey);

    // Process next queued message if any
    if (pendingMessages.length > 0) {
      const next = pendingMessages.shift()!;
      console.log(`[agent] dequeuing next message (${pendingMessages.length} remaining)`);
      handleMessage(next);
    }
  }
}

async function handleRoute(
  data: Record<string, unknown>,
  msg: import("nats").Msg
): Promise<void> {
  const text = data.text as string;
  if (!text) {
    msg.respond(new TextEncoder().encode(JSON.stringify({ agent: AGENT_ID })));
    return;
  }

  // If already processing a regular message, skip the routing query to avoid
  // concurrent Claude Code processes interfering via shared session state.
  if (isProcessing) {
    console.log("[agent] busy processing, returning default agent for routing");
    msg.respond(new TextEncoder().encode(JSON.stringify({ agent: AGENT_ID })));
    return;
  }

  console.log("[agent] routing query");

  try {
    const systemPrompt = loadSystemPrompt(false);

    // Build agent descriptions from environment if available
    const agentDescsEnv = process.env.AGENT_DESCRIPTIONS || "";
    let routingPrompt = `You are a message router. Given the user message below, respond with ONLY the name of the most appropriate agent to handle it. Do not include any other text.\n\n`;
    if (agentDescsEnv) {
      routingPrompt += `Available agents:\n${agentDescsEnv}\n\n`;
    }
    routingPrompt += `User message: ${text}`;

    const routeSessionId = `route-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    const result = runAgent(
      systemPrompt ? `${systemPrompt}\n\n${routingPrompt}` : routingPrompt,
      routeSessionId,
      controller,
      { maxTurns: 1, routing: true, resume: false }
    );

    let agentName = "";
    for await (const event of result) {
      if (event.final && event.text) {
        agentName = event.text;
      }
    }

    msg.respond(new TextEncoder().encode(JSON.stringify({ agent: agentName })));
  } catch (err) {
    console.error(`[agent] routing error:`, err);
    msg.respond(new TextEncoder().encode(JSON.stringify({ agent: AGENT_ID })));
  }
}

async function handleControl(
  data: Record<string, unknown>,
  msg: import("nats").Msg
): Promise<void> {
  const command = data.command as string;

  switch (command) {
    case "shutdown":
      console.log("[agent] shutting down...");
      for (const toolset of activeToolsets) {
        try { await toolset.close(); } catch { /* ignore */ }
      }
      activeToolsets.clear();
      await bridge.close();
      process.exit(0);
      break;
    case "ping":
      msg.respond(new TextEncoder().encode(JSON.stringify({
        status: "ok",
        processing: isProcessing,
        pending_messages: pendingMessages.length,
        active_tasks: activeTaskCount,
        background_tasks: totalBgTasks(),
      })));
      break;
    case "abort":
      console.log("[agent] aborting current run...");
      aborted = true;
      // Abort conversational query
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      // Abort all parallel task queries
      for (const controller of activeAbortControllers.values()) {
        controller.abort();
      }
      activeAbortControllers.clear();
      activeTaskCount = 0;
      backgroundTasksByQuery.clear();
      // Drain all queues
      if (pendingMessages.length > 0) {
        console.log(`[agent] discarding ${pendingMessages.length} queued message(s)`);
        pendingMessages.length = 0;
      }
      if (pendingTasks.length > 0) {
        console.log(`[agent] discarding ${pendingTasks.length} queued task(s)`);
        pendingTasks.length = 0;
      }
      isProcessing = false;
      msg.respond(new TextEncoder().encode(JSON.stringify({ status: "ok" })));
      console.log("[agent] run aborted");
      break;
    case "clear_session":
      console.log("[agent] clearing session...");
      lastSessionId = undefined;
      for (const dir of [
        "/home/praktor/.claude/projects",
        "/home/praktor/.claude/sessions",
        "/home/praktor/.claude/debug",
        "/home/praktor/.claude/todos",
      ]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      msg.respond(new TextEncoder().encode(JSON.stringify({ status: "ok" })));
      console.log("[agent] session cleared");
      break;
    default:
      console.warn(`[agent] unknown control command: ${command}`);
      msg.respond(new TextEncoder().encode(JSON.stringify({ error: `unknown command: ${command}` })));
      break;
  }
}

async function main(): Promise<void> {
  console.log(`[agent] starting for agent ${AGENT_ID}`);
  console.log(`[agent] NATS URL: ${NATS_URL}`);
  console.log(`[agent] backend resolved: ${AGENT_BACKEND} (configured=${process.env.AGENT_BACKEND || "auto"})`);

  installGlobalInstructions();
  ensureAgentMd();
  setupAgentBrowser();
  setupAgentMail();
  setupWorkspaceSkills();

  // Apply agent extensions (MCP servers, plugins, skills, settings)
  const extResult = await applyExtensions();
  extensionMcpServers = extResult.mcpServers;

  // Clean up Claude Code internal files that accumulate over time
  for (const dir of ["/home/praktor/.claude/debug", "/home/praktor/.claude/todos"]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  bridge = new NatsBridge(NATS_URL, AGENT_ID);
  await bridge.connect();

  // Report any extension errors via NATS
  if (extResult.errors.length > 0) {
    const errMsg = `Extension errors:\n${extResult.errors.map((e) => `- ${e}`).join("\n")}`;
    console.error(`[extensions] ${errMsg}`);
    await bridge.publishOutput(errMsg, "text");
  }

  bridge.subscribeInput(handleMessage);
  bridge.subscribeControl(handleControl);
  bridge.subscribeRoute(handleRoute);

  // Subscribe to swarm collaborative chat if in swarm mode
  if (SWARM_CHAT_TOPIC) {
    console.log(`[agent] swarm mode: subscribing to chat topic ${SWARM_CHAT_TOPIC}`);
    bridge.subscribeSwarmChat(SWARM_CHAT_TOPIC, (msg) => {
      // Don't echo own messages
      if (msg.from === AGENT_ID) return;
      chatHistory.push({
        from: msg.from,
        content: msg.content,
        timestamp: Date.now(),
      });
      console.log(`[agent] swarm chat from ${msg.from}: ${msg.content.substring(0, 80)}...`);
    });
  }

  // Flush to ensure subscriptions are registered with NATS server
  await bridge.flush();

  await bridge.publishReady();
  console.log(`[agent] ready and listening for messages`);

  // Keep process alive
  process.on("SIGTERM", async () => {
    console.log("[agent] SIGTERM received, shutting down...");
    await bridge.close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("[agent] SIGINT received, shutting down...");
    await bridge.close();
    process.exit(0);
  });
}

// Only auto-run main() when this file is the process entrypoint — not when
// it's imported by vitest. Otherwise main()'s NATS connect fails in test
// environments and process.exit(1) bubbles up as an unhandled rejection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[agent] fatal error:", err);
    process.exit(1);
  });
}
