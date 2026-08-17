import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { pathToFileURL } from "url";

const LOG_API_URL = process.env.LOG_API_URL || "";
const TOKEN_PATH = process.env.LOG_API_TOKEN_FILE || "/workspace/.log_api_key";
const MAX_RESPONSE_CHARS = 24000;

const server = new McpServer({
  name: "praktor-log-api",
  version: "1.0.0",
});

function readToken(): string {
  return readFileSync(TOKEN_PATH, "utf-8").trim();
}

function appendParam(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  url.searchParams.set(key, String(value));
}

function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n... truncated ${text.length - MAX_RESPONSE_CHARS} chars`;
}

server.tool(
  "log_search",
  "Query the configured Log API using the vault bearer token. Use this for log_analyzer requests that need log data. from and to are required RFC3339/ISO timestamps. For user-facing log searches, prefer UTC+7 timestamps like 2026-08-16T19:30:00+07:00; UTC Z timestamps are also accepted when needed.",
  {
    from: z.string().describe("Required start timestamp, RFC3339/ISO-8601. Prefer UTC+7 for log_analyzer, e.g. 2026-08-16T19:20:00+07:00. UTC Z is also valid."),
    to: z.string().describe("Required end timestamp, RFC3339/ISO-8601. Prefer UTC+7 for log_analyzer, e.g. 2026-08-16T19:35:00+07:00. UTC Z is also valid."),
    pageSize: z.number().int().positive().max(1000).optional().describe("Requested page size. Sent as page.size."),
    pageTotal: z.boolean().optional().describe("Whether to ask the API for total count. Sent as page.total."),
    secsEngineMatchedFilter: z.string().optional().describe("Optional secsEngineMatchedFilter, e.g. SEMF_MATCHED."),
    method: z.enum(["GET", "POST"]).optional().describe("HTTP method. Default GET."),
    extraQueryJson: z.string().optional().describe("Optional JSON object of additional query/body fields."),
  },
  async ({ from, to, pageSize, pageTotal, secsEngineMatchedFilter, method, extraQueryJson }) => {
    if (!LOG_API_URL) {
      return { content: [{ type: "text" as const, text: "Error: LOG_API_URL is not configured." }] };
    }

    let token: string;
    try {
      token = readToken();
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: cannot read bearer token at ${TOKEN_PATH}: ${err}` }] };
    }
    if (!token) {
      return { content: [{ type: "text" as const, text: `Error: bearer token file ${TOKEN_PATH} is empty.` }] };
    }

    let extra: Record<string, unknown> = {};
    if (extraQueryJson && extraQueryJson.trim()) {
      try {
        const parsed = JSON.parse(extraQueryJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { content: [{ type: "text" as const, text: "Error: extraQueryJson must be a JSON object." }] };
        }
        extra = parsed as Record<string, unknown>;
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: invalid extraQueryJson: ${err}` }] };
      }
    }

    const selectedMethod = method || "GET";
    const baseParams: Record<string, unknown> = {
      from,
      to,
      ...(pageSize ? { "page.size": pageSize } : {}),
      ...(pageTotal !== undefined ? { "page.total": pageTotal } : {}),
      ...(secsEngineMatchedFilter ? { secsEngineMatchedFilter } : {}),
      ...extra,
    };

    const url = new URL(LOG_API_URL);
    const init: RequestInit = {
      method: selectedMethod,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    };
    if (selectedMethod === "GET") {
      for (const [key, value] of Object.entries(baseParams)) appendParam(url, key, value);
    } else {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(baseParams);
    }

    const started = Date.now();
    let response: Response;
    try {
      console.error(`[mcp-log-api] request method=${selectedMethod} url=${selectedMethod === "GET" ? url.toString() : LOG_API_URL} body=${selectedMethod === "POST" ? JSON.stringify(baseParams) : ""}`);
      response = await fetch(url, init);
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: Log API request failed: ${err}` }] };
    }
    const body = await response.text();
    const elapsedMs = Date.now() - started;
    console.error(`[mcp-log-api] response status=${response.status} elapsedMs=${elapsedMs} bytes=${body.length}`);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: response.ok,
              status: response.status,
              statusText: response.statusText,
              elapsedMs,
              queryTimezone: "UTC+7",
              displayTimezone: "Asia/Ho_Chi_Minh (+07:00)",
              note: "Show user-facing log windows and timestamps in UTC+7 unless the user requested another timezone.",
              url: selectedMethod === "GET" ? url.toString() : LOG_API_URL,
              body: truncate(body),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("MCP log API server error:", err);
    process.exit(1);
  });
}
