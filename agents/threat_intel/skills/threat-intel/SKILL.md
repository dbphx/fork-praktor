---
name: threat-intel
description: Perform public threat intelligence research and evidence-based attack classification for IPs, domains, URLs, file hashes, ASNs, malware names, CVEs, advisories, exploit availability, abuse infrastructure, reputation checks, WAF/security-engine matches, false positives, and mitigation guidance. Use when a user asks whether an indicator is benign, suspicious, malicious, exploited, severe, related to known campaigns, what attack types it matches, or whether log matches are true positive or false positive.
---

# Threat Intel Skill

Use this skill for public-source threat intelligence. Stay source-driven, skeptical, and concise.

## Non-Negotiables

1. Check current public sources before making claims about reputation, exploit status, severity, or active exploitation.
2. Distinguish confirmed facts from inference.
3. Compare dates. Prefer the newest authoritative source when sources conflict.
4. Do not query internal logs yourself. If the question requires many log events or raw WAF evidence, ask for summarized evidence from `log_analyzer` or tell the user to route that collection step there.
5. Do not claim attribution to an actor, campaign, or malware family unless reliable sources support it.
6. Do not overstate confidence from a single weak reputation hit.
7. Do not reveal or request secrets, API keys, or private tokens.

## Source Priority

For vulnerabilities:

1. Vendor advisory or maintainer security notice.
2. NVD/CVE record and CVSS/EPSS context.
3. CISA KEV for known exploited status.
4. Exploit databases, GitHub PoCs, Metasploit, or reputable research writeups.
5. Security vendor reports only after checking primary sources.

For indicators:

1. DNS/WHOIS/ASN/hosting context from reputable public lookups.
2. Abuse/reputation databases such as AbuseIPDB, VirusTotal public pages, URLhaus, PhishTank, Spamhaus, GreyNoise, or AlienVault OTX when available.
3. Passive DNS, certificate transparency, redirect chain, and URL structure when relevant.
4. Reputable vendor or incident reports linking the indicator to a campaign or malware.

Use at least two independent source categories for a malicious verdict when practical.

## Attack Match And False Positive Analysis

Use this workflow for questions like "domain này match những loại tấn công nào", "false positive không", "phân tích WAF match", or "attack pattern nào xuất hiện trong nhiều log".

Required evidence from logs:

- indicator: domain/IP/URL and exact host header if available
- time window in UTC+7
- total matched events and sampled raw events
- rule names, rule IDs, signatures, categories, severity, action, and engine verdict
- request method, path, query string, status code, user agent, source IP/ASN/country
- payload snippets around the matched parameter, redacted if sensitive
- repeat pattern across requests: same source, same path, same payload, same user/session, same rule

If this evidence is not present, do not browse randomly or guess. Ask `log_analyzer` for a grouped summary first, for example:

```text
@log_analyzer lấy log cho domain <domain> trong <time window UTC+7>, group theo rule/category/path/source IP/action, lấy 20 sample payload đã redact để threat_intel đánh giá attack type và false positive
```

Attack classification guide:

- SQL injection: SQL operators/functions/errors in parameters, boolean/time-based payloads, UNION/SELECT patterns, database-specific functions.
- XSS: script/event-handler/html injection, encoded JavaScript, suspicious DOM sink payloads.
- Path traversal/LFI/RFI: `../`, encoded traversal, `/etc/passwd`, wrapper schemes, remote include URLs.
- Command injection/RCE: shell metacharacters, command names, template injection, deserialization markers, process invocation.
- SSRF: requests to metadata IPs, localhost/private ranges, URL fetch parameters, protocol smuggling.
- Scanner/recon: high path diversity, common vuln probe paths, tool user agents, many 404/403, broad source churn.
- Credential stuffing/bruteforce: high-rate auth endpoint hits, repeated failures, many usernames, same IP/ASN patterns.
- Bot/scraping: repetitive resource access, abnormal user agents, low session continuity, high request volume.
- Webshell/backdoor probing: common shell filenames, upload paths, PHP/JSP/ASP execution probes.
- Protocol abuse: malformed headers, host header anomalies, request smuggling indicators, unusual methods.

False positive indicators:

- payload is normal business data or expected encoded content for that endpoint
- rule category is generic and only one low-confidence rule matched
- action was allow/log-only and backend status is normal for the endpoint
- source is trusted/internal monitoring or known integration
- same pattern appears in successful legitimate traffic over time
- no repetition, no exploit progression, and no supporting reputation signal
- decoding the payload removes the suspicious pattern or shows harmless text

True positive indicators:

- exploit payload clearly targets a vulnerable parser/framework or endpoint
- multiple independent rules/categories match the same request family
- source IP/domain has public abuse reputation or prior internal history
- sequence shows reconnaissance followed by exploit attempts
- request hit sensitive endpoint, unexpected method, or produced unusual 4xx/5xx/latency
- payload variations indicate automation or bypass attempts

Score false-positive confidence:

- `FP likely`: strong benign context, expected payload, no malicious sequence, trusted source.
- `Unclear`: partial evidence, generic rule, insufficient payload/context.
- `TP likely`: exploit syntax and sequence are coherent, repeated, or supported by reputation.

When working with large log sets, summarize by clusters instead of individual rows:

```text
Cluster: SQLi probes
• Count / window UTC+7: ...
• Rules: ...
• Paths: ...
• Sources: ...
• Payload pattern: ...
• TP/FP assessment: ...
```

## Indicator Workflow

1. Normalize the indicator:
   - IP: preserve exact address and note private/reserved ranges.
   - Domain: lowercase, trim trailing dot, extract registered domain and subdomain.
   - URL: preserve full URL, identify domain, path, query, scheme, and suspicious encoding.
   - Hash: identify MD5, SHA1, or SHA256 by length and character set.
   - ASN: normalize to `AS<number>`.
2. Identify what the user wants: reputation, blocking decision, triage, enrichment, or attribution.
3. Check public reputation and infrastructure context.
4. Record evidence with source name, date observed or published, and what it actually says.
5. Decide verdict:
   - `malicious`: strong evidence of abuse, malware, phishing, exploit delivery, C2, or active scanning tied to bad activity.
   - `suspicious`: weak or partial evidence, risky infrastructure, recent registration, suspicious URL pattern, low-confidence hits.
   - `benign`: reputable ownership and no meaningful abuse signals.
   - `unknown`: insufficient or conflicting public evidence.
   - `needs monitoring`: not malicious now, but recent changes or weak signals justify tracking.

## CVE Workflow

1. Normalize the ID to `CVE-YYYY-NNNN...`.
2. Check affected products, versions, vulnerability class, and prerequisites.
3. Check severity from vendor and NVD; explain if CVSS differs.
4. Check exploitation:
   - CISA KEV listed means confirmed known exploitation.
   - Vendor or incident reports may confirm exploitation.
   - Public PoC means exploit code exists, not necessarily active exploitation.
   - Social posts alone are weak evidence unless backed by technical detail.
5. Check mitigation:
   - fixed versions
   - configuration workaround
   - detection/hunting hints
   - exposure reduction
6. Provide a practical priority: emergency, high, normal, monitor, or not applicable.

## Confidence

Use:

- `High`: multiple reliable sources agree, or vendor/CISA confirms.
- `Medium`: one strong source or several weaker sources support the verdict.
- `Low`: limited, stale, or conflicting evidence.

Lower confidence when:

- the source is old and the infrastructure may have changed
- reputation data is sparse
- the indicator is shared hosting, CDN, VPN, NAT, or cloud infrastructure
- only one vendor flags a hash/domain/IP

## Output Shape

Keep Telegram output compact:

```text
Verdict: suspicious
Confidence: medium
Indicator: ...
Evidence:
• ...
• ...
Recommended action:
• ...
Source caveats:
• ...
```

For CVEs:

```text
Verdict: exploited / public PoC only / no public exploitation found
Priority: high
Affected: ...
Evidence:
• ...
Mitigation:
• ...
Caveats:
• ...
```

For attack-match and false-positive analysis:

```text
Phân loại attack
• Domain: ...
• Window UTC+7: ...
• Tổng matched events: ...

Attack clusters
• SQL injection: count=..., confidence=..., TP/FP=...
• Scanner/recon: count=..., confidence=..., TP/FP=...

Evidence chính
• rule/category/path/source/payload pattern...

False positive assessment
• FP likely / unclear / TP likely: ...

Recommended action
• ...

Cần thêm
• ...
```

## Evidence Storage

When saving local artifacts:

- Store IOC notes in `indicators/`.
- Include source URLs, retrieval date, and short observations.
- Do not store API keys, session cookies, private tokens, or full private reports.

## Escalation Rules

Escalate or suggest handoff when:

- the user needs correlation with internal logs: hand off to `log_analyzer`.
- the user needs a formal incident report: hand off summarized findings to `reporter`.
- public evidence is insufficient for a blocking decision: recommend a monitoring or short TTL block with caveats.
