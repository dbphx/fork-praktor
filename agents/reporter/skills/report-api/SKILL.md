---
name: report-api
description: Query Insky analytic report APIs for realtime bandwidth traffic and request summaries, then turn the results into concise operational or incident reports. Use when a user asks for traffic realtime, bandwidth, bps/bytes, request count, QPS/RPS, top paths/status/domains, traffic spikes, request summaries, or report material from bo.insky.io.vn analytic report APIs.
---

# Report API Skill

Use this skill when the report needs live analytics from the Insky BO report APIs.

## APIs

Tools:

- `praktor_report_api_bandwidth_realtime`: calls `REPORT_BANDWIDTH_API_URL`, default `https://bo.insky.io.vn/analytic/report/bandwidth`.
- `praktor_report_api_request_summary`: calls `REPORT_REQUEST_API_URL`, default `https://bo.insky.io.vn/analytic/report/request`.

Both tools use the same bearer token file as `log_analyzer`: `/workspace/.log_api_key`.

Never print the token. If the token is missing, say the vault secret `log-api-key` must be assigned to `reporter`.

## Time Handling

Use Asia/Ho_Chi_Minh / UTC+7 by default.

For relative windows:

- "real time" or "hiện tại": use the last 5 minutes unless the user specifies another window.
- "15p trước": use now minus 15 minutes to now.
- "hôm nay": use local UTC+7 start of day to now.

Prefer timestamps with `+07:00`, for example:

```json
{
  "from": "2026-08-17T15:00:00+07:00",
  "to": "2026-08-17T15:05:00+07:00"
}
```

If the API rejects offset timestamps, retry once with equivalent UTC `Z` timestamps.

If the API returns HTTP 400:

1. Read the tool response `body` and `requestParams`.
2. Retry once with the opposite method (`GET` -> `POST`, or `POST` -> `GET`).
3. Retry once with only the minimal window fields `from` and `to`.
4. If it still fails, report the exact validation/error message from `body` and the non-secret request fields that were sent.

## Bandwidth Realtime Workflow

Use `praktor_report_api_bandwidth_realtime` for:

- realtime traffic
- bandwidth usage
- bps/bytes in/out
- traffic spikes
- bandwidth by domain/site/customer

Useful arguments:

```json
{
  "from": "2026-08-17T15:00:00+07:00",
  "to": "2026-08-17T15:05:00+07:00",
  "domain": "example.insky.io.vn",
  "interval": "1m"
}
```

Use `extraQueryJson` for API-specific fields when needed:

```json
{
  "extraQueryJson": "{\"tenant\":\"...\",\"direction\":\"inbound\"}"
}
```

## Request Summary Workflow

Use `praktor_report_api_request_summary` for:

- request count
- QPS/RPS
- top domains, paths, methods, status codes
- request spike summary
- error-rate report inputs

Useful arguments:

```json
{
  "from": "2026-08-17T15:00:00+07:00",
  "to": "2026-08-17T15:05:00+07:00",
  "domain": "example.insky.io.vn",
  "interval": "1m"
}
```

## Report Workflow

1. If the user asks for traffic realtime, bandwidth, or request summary without a domain/site, query the API for the default scope instead of asking for Grafana/Prometheus/dashboard details.
2. Query bandwidth when traffic volume or bps/bytes is needed.
3. Query request summary when request count, QPS/RPS, status/path distribution, or spike context is needed.
4. Compare current window with baseline only if the user provides a baseline or the API response includes one.
5. Separate observed metrics from interpretation.
6. Highlight missing dimensions instead of inventing them.

## Output Shape

For quick Telegram answers:

```text
Traffic report
• Window UTC+7: ...
• Scope: ...
• Bandwidth: ...
• Requests: ...
• Top changes: ...
• Interpretation: ...
• Missing: ...
```

For incident/report material:

```text
Summary
...

Metrics
• Bandwidth: ...
• Requests: ...
• Status/path/domain distribution: ...

Timeline UTC+7
• ...

Assessment
• ...

Recommended action
• ...

Open questions
• ...
```

## Boundaries

- Do not perform WAF raw log investigation here; use `log_analyzer` for raw event evidence.
- Do not perform public threat intelligence research here; use `threat_intel`.
- Do not claim root cause from traffic metrics alone.
- Do not save or expose bearer tokens.
- Do not ask what monitoring system is configured; these reports use the BO report APIs above.
- Do not use browser tools for BO report data. Use only `praktor_report_api_bandwidth_realtime` and `praktor_report_api_request_summary`.
