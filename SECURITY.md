# Security Policy

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, report vulnerabilities via [GitHub Security Advisories](https://github.com/yaniv-golan/cc-mess/security/advisories/new).

## Response SLA

- **Acknowledge:** within 48 hours
- **Triage:** within 1 week
- **Fix:** depends on severity, but critical issues are prioritized

## Scope

Security concerns for cc-mess include:

- Path traversal outside allowed directories
- Process injection via spawn parameters
- Registry/control file tampering
- Message spoofing between instances
- Guardrail bypass

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
