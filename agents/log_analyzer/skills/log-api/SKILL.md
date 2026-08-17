---
name: log-api
description: Query and interpret Insky WAF/security-engine logs through the praktor_log_api_log_search tool. Use whenever the user asks to fetch logs, check today's logs, search recent events, count WAF matches, validate Log API access, investigate status codes, paths, IPs, request IDs, trace IDs, user IDs, or explain incidents from available log evidence.
---

# Log API Skill

Use this skill for every request that needs WAF/security-engine log data.

## Non-Negotiables

1. Call `praktor_log_api_log_search` before claiming whether logs exist.
2. Use the runtime context current date/time for relative requests such as "today", "now", "15p trước", "hôm qua", or "tuần này".
3. Treat Asia/Ho_Chi_Minh / UTC+7 as the default timezone for log searches unless the user gives another timezone.
4. Show all user-facing search windows and log timestamps in UTC+7 first. Include UTC only as supporting detail when useful.
5. Preserve observed facts separately from inference.
6. Never print secret values. The bearer token is read by the tool from `/workspace/.log_api_key`.
7. If the API returns an error, report the HTTP status and validation message, then adjust the query if possible.

## Required Tool

Call:

```json
{
  "from": "YYYY-MM-DDTHH:mm:ss+07:00",
  "to": "YYYY-MM-DDTHH:mm:ss+07:00"
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

Prefer RFC3339 timestamps with `+07:00` offset for Log API calls. If the API rejects offset timestamps, retry once with UTC `Z` timestamps converted from the same UTC+7 window.

For "today" in Asia/Ho_Chi_Minh / UTC+7:

1. Set `from` to local start of day `00:00:00`.
2. Set `to` to current local time.
3. Send timestamps as `YYYY-MM-DDTHH:mm:ss+07:00` when possible.
4. Mention the UTC+7 window in the answer. Mention UTC only if debugging the query.

For "last N minutes":

1. Set `to` to current runtime time.
2. Set `from` to `to - N minutes`.
3. Send both as `+07:00` timestamps when possible.

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

## Threat Intel Handoff

When the user or `threat_intel` asks for WAF evidence to classify attack types or false positives for a domain/IP/URL, return a grouped evidence summary instead of only raw samples.

Collect and summarize:

- window in UTC+7
- total matched events
- top rule names, rule IDs, categories, severities, and actions
- top paths, methods, status codes, source IPs/ASNs/countries, and user agents
- redacted payload patterns around matched parameters
- repeated sequences such as recon -> exploit, same source across many paths, or many payload variants
- normal-business-context clues that may indicate false positive

Use this handoff shape:

```text
Evidence for threat_intel
• Indicator: ...
• Window UTC+7: ...
• Total matched events: ...
• Clusters:
  1. category/rule/action/count/top paths/source pattern/payload pattern
  2. ...
• Samples:
  1. timestamp UTC+7/rule/path/source/status/redacted payload
• FP context:
  • ...
• Missing:
  • ...
```

Do not decide attribution. If the question is "what attack type is this and false positive?", hand this summary to `threat_intel` after gathering evidence.

## Response Shape

Keep Telegram output compact:

```text
Kết quả kiểm tra log
• Window UTC+7: ...
• Window UTC: ... (optional)
• Filter: ...
• Total: ...
• Samples: ...
• Kết luận: ...
```

When no logs are found:

```text
Không thấy log trong window đã query.
• Window UTC+7: ...
• Window UTC: ... (optional)
• Filter: ...
• Tool status: ...
```

When summarizing sample log records, convert any `Z` timestamps in the API response to UTC+7 before showing them to the user. Keep the original UTC timestamp only when it helps audit the query.

When API access works but parameters are missing or invalid, say that the API is reachable and show the required parameter issue without exposing credentials.

## Evidence Rules

When saving local notes:

- Save reusable query drafts under `queries/`.
- Save selected log excerpts under `evidence/`.
- Save temporary reasoning under `notes/`.

Do not save bearer tokens, API keys, passwords, or full secret file contents.
