---
name: log-api
description: Query and interpret Insky WAF/security-engine logs through the praktor_log_api_log_search tool. Use whenever the user asks to fetch logs, check today's logs, search recent events, count WAF matches, validate Log API access, investigate status codes, paths, IPs, request IDs, trace IDs, user IDs, or explain incidents from available log evidence.
---

# Log API Skill

Use this skill for every request that needs WAF/security-engine log data.

## Non-Negotiables

1. Call `praktor_log_api_log_search` before claiming whether logs exist.
2. Use the runtime context current date/time for relative requests such as "today", "now", "15p trước", "hôm qua", or "tuần này".
3. Convert local Asia/Ho_Chi_Minh windows to UTC ISO timestamps unless the user gives an explicit timezone.
4. Preserve observed facts separately from inference.
5. Never print secret values. The bearer token is read by the tool from `/workspace/.log_api_key`.
6. If the API returns an error, report the HTTP status and validation message, then adjust the query if possible.

## Required Tool

Call:

```json
{
  "from": "YYYY-MM-DDTHH:mm:ssZ",
  "to": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Useful optional fields:

```json
{
  "pageSize": 10,
  "pageTotal": true,
  "secsEngineMatchedFilter": "SEMF_MATCHED",
  "extraQueryJson": {
    "ip": "203.0.113.10",
    "path": "/login",
    "statusCode": 403,
    "requestId": "..."
  }
}
```

Prefer `pageSize: 1` and `pageTotal: true` for connectivity or count checks. Prefer `pageSize: 10` to inspect samples.

## Time Windows

For "today" in Asia/Ho_Chi_Minh:

1. Set `from` to local start of day `00:00:00`.
2. Set `to` to current local time.
3. Convert both to UTC ISO timestamps.
4. Mention the local window and UTC window in the answer.

For "last N minutes":

1. Set `to` to current runtime time.
2. Set `from` to `to - N minutes`.
3. Convert both to UTC ISO timestamps.

Do not reuse stale dates from previous messages. If the tool result date conflicts with runtime context, trust runtime context and query again.

## Query Workflow

1. Parse the user's requested source, time range, and filters.
2. If the request is vague, choose a narrow safe default:
   - recent troubleshooting: last 15 minutes
   - "today": local day start to now
   - connectivity test: last 1 minute, `pageSize: 1`, `pageTotal: true`
3. Query with `secsEngineMatchedFilter: "SEMF_MATCHED"` when the user asks about matched WAF/security events.
4. If zero results and the user expected data, widen carefully:
   - remove `SEMF_MATCHED` once to check all events
   - extend the time window
   - ask for path/IP/request ID only after the broad check is also empty
5. For incidents, collect enough samples to include timestamp, action, rule/signature, source IP, path, status code, request ID, and upstream error if present.

## Response Shape

Keep Telegram output compact:

```text
Kết quả kiểm tra log
• Window local: ...
• Window UTC: ...
• Filter: ...
• Total: ...
• Samples: ...
• Kết luận: ...
```

When no logs are found:

```text
Không thấy log trong window đã query.
• Window local: ...
• Window UTC: ...
• Filter: ...
• Tool status: ...
```

When API access works but parameters are missing or invalid, say that the API is reachable and show the required parameter issue without exposing credentials.

## Evidence Rules

When saving local notes:

- Save reusable query drafts under `queries/`.
- Save selected log excerpts under `evidence/`.
- Save temporary reasoning under `notes/`.

Do not save bearer tokens, API keys, passwords, or full secret file contents.
