import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { pathToFileURL } from "url";

const DEFAULT_BANDWIDTH_API_URL = "https://bo.insky.io.vn/api/eco/analytic/report/bandwidth";
const DEFAULT_REQUEST_API_URL = "https://bo.insky.io.vn/api/eco/analytic/report";
const BANDWIDTH_API_URL = process.env.REPORT_BANDWIDTH_API_URL || DEFAULT_BANDWIDTH_API_URL;
const REQUEST_API_URL = process.env.REPORT_REQUEST_API_URL || DEFAULT_REQUEST_API_URL;
const TOKEN_PATH = process.env.REPORT_API_TOKEN_FILE || process.env.LOG_API_TOKEN_FILE || "/workspace/.log_api_key";
const MAX_RESPONSE_CHARS = 24000;

const server = new McpServer({
  name: "praktor-report-api",
  version: "1.0.0",
});

function readToken(): string {
  return readFileSync(TOKEN_PATH, "utf-8").trim();
}

function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n... truncated ${text.length - MAX_RESPONSE_CHARS} chars`;
}

function appendParam(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  url.searchParams.set(key, String(value));
}

function parseExtra(extraQueryJson?: string): Record<string, unknown> | string {
  if (!extraQueryJson || !extraQueryJson.trim()) return {};
  try {
    const parsed = JSON.parse(extraQueryJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Error: extraQueryJson must be a JSON object.";
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    return `Error: invalid extraQueryJson: ${err}`;
  }
}

async function callReportApi(
  endpointName: string,
  apiURL: string,
  params: Record<string, unknown>,
  method?: "GET" | "POST",
) {
  if (!apiURL) {
    return { content: [{ type: "text" as const, text: `Error: ${endpointName} API URL is not configured.` }] };
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

  const selectedMethod = method || "GET";
  const url = new URL(apiURL);
  const init: RequestInit = {
    method: selectedMethod,
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  };
  if (selectedMethod === "GET") {
    for (const [key, value] of Object.entries(params)) appendParam(url, key, value);
  } else {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(params);
  }

  const started = Date.now();
  let response: Response;
  try {
    console.error(`[mcp-report-api] request endpoint=${endpointName} method=${selectedMethod} url=${selectedMethod === "GET" ? url.toString() : apiURL} body=${selectedMethod === "POST" ? JSON.stringify(params) : ""}`);
    response = await fetch(url, init);
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Error: Report API request failed: ${err}` }] };
  }

  const body = await response.text();
  const elapsedMs = Date.now() - started;
  console.error(`[mcp-report-api] response endpoint=${endpointName} status=${response.status} elapsedMs=${elapsedMs} bytes=${body.length}`);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: response.ok,
            endpoint: endpointName,
            status: response.status,
            statusText: response.statusText,
            elapsedMs,
            queryTimezone: "UTC+7",
            displayTimezone: "Asia/Ho_Chi_Minh (+07:00)",
            note: "Show user-facing report windows and timestamps in UTC+7 unless the user requested another timezone.",
            requestParams: params,
            url: selectedMethod === "GET" ? url.toString() : apiURL,
            body: truncate(body),
          },
          null,
          2,
        ),
      },
    ],
  };
}

const commonParams = {
  from: z.string().optional().describe("Optional start timestamp, RFC3339/ISO-8601. Prefer UTC+7, e.g. 2026-08-17T15:00:00+07:00."),
  to: z.string().optional().describe("Optional end timestamp, RFC3339/ISO-8601. Prefer UTC+7, e.g. 2026-08-17T15:15:00+07:00."),
  domain: z.string().optional().describe("Optional domain/host filter."),
  site: z.string().optional().describe("Optional site/application/customer filter if the API supports it."),
  interval: z.string().optional().describe("Optional aggregation interval. BO API values include TI_EVERY_1_MINUTE and TI_EVERY_15_MINUTES."),
  pageTotal: z.boolean().optional().describe("Whether to ask the API for total count. Sent as page.total. Default true."),
  fieldLimit: z.string().optional().describe("BO report fieldLimit. Defaults to FL_VOLUME for bandwidth and FL_REQUEST for request summary."),
  fieldReport: z.string().optional().describe("BO report fieldReport. Default FR_NONE."),
  method: z.enum(["GET", "POST"]).optional().describe("HTTP method. Default GET."),
  extraQueryJson: z.string().optional().describe("Optional JSON object of additional query/body fields for this report API."),
};

server.tool(
  "bandwidth_realtime",
  "Fetch realtime traffic/bandwidth analytics from REPORT_BANDWIDTH_API_URL. Use for questions about current traffic, bandwidth, ingress/egress, bps/bytes, traffic spikes, or realtime bandwidth trend. Uses the same vault token file as log_analyzer.",
  commonParams,
  async ({ from, to, domain, site, interval, pageTotal, fieldLimit, fieldReport, method, extraQueryJson }) => {
    const extra = parseExtra(extraQueryJson);
    if (typeof extra === "string") return { content: [{ type: "text" as const, text: extra }] };
    return callReportApi("bandwidth_realtime", BANDWIDTH_API_URL, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(domain ? { domain } : {}),
      ...(site ? { site } : {}),
      "page.total": pageTotal ?? true,
      interval: interval || "TI_EVERY_1_MINUTE",
      numberMinutes: 1,
      countryKind: "CK_DEFAULT",
      fieldLimit: fieldLimit || "FL_VOLUME",
      fieldReport: fieldReport || "FR_NONE",
      ...extra,
    }, method);
  },
);

server.tool(
  "request_summary",
  "Fetch request analytics summary from REPORT_REQUEST_API_URL. Use for questions about request counts, QPS/RPS, top paths/statuses/domains, traffic summary, request spikes, or realtime request trends. Uses the same vault token file as log_analyzer.",
  commonParams,
  async ({ from, to, domain, site, interval, pageTotal, fieldLimit, fieldReport, method, extraQueryJson }) => {
    const extra = parseExtra(extraQueryJson);
    if (typeof extra === "string") return { content: [{ type: "text" as const, text: extra }] };
    return callReportApi("request_summary", REQUEST_API_URL, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(domain ? { domain } : {}),
      ...(site ? { site } : {}),
      "page.total": pageTotal ?? true,
      interval: interval || "TI_EVERY_15_MINUTES",
      fieldLimit: fieldLimit || "FL_REQUEST",
      fieldReport: fieldReport || "FR_NONE",
      ...extra,
    }, method);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("MCP report API server error:", err);
    process.exit(1);
  });
}
