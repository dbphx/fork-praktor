---
name: threat-intel
description: Perform public threat intelligence research for IPs, domains, URLs, file hashes, ASNs, malware names, CVEs, advisories, exploit availability, abuse infrastructure, reputation checks, and mitigation guidance. Use when a user asks whether an indicator is benign, suspicious, malicious, exploited, severe, related to known campaigns, or needs monitoring.
---

# Threat Intel Skill

Use this skill for public-source threat intelligence. Stay source-driven, skeptical, and concise.

## Non-Negotiables

1. Check current public sources before making claims about reputation, exploit status, severity, or active exploitation.
2. Distinguish confirmed facts from inference.
3. Compare dates. Prefer the newest authoritative source when sources conflict.
4. Do not query internal logs. Route log questions to `log_analyzer`.
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
