# Security

## Reporting a vulnerability

Report a vulnerability privately through the repository's [security advisory form](https://github.com/season-framework/reviewops-local/security/advisories/new). Do not put exploit details, credentials, or private project data in a public issue. If private reporting is unavailable, open an issue asking maintainers to enable a private reporting channel without disclosing the vulnerability.

Include the affected version, a minimal reproduction with synthetic data, the expected security boundary, and the observed result. There is no guaranteed response time; maintainers review reports as availability permits.

## Supported releases

Security fixes target the latest stable release. Upgrade before reporting a problem that may already be fixed. Older releases do not have a separate maintenance schedule.

## Application behavior

- ReviewOps stores reviews, browser sessions, attachments, and account profiles on the local computer. Protect the application data folder and backups as private data.
- Codex tasks run under the selected local or SSH account with `--dangerously-bypass-approvals-and-sandbox`. This is intentional behavior. A task can access anything that account can access.
- External website content must not gain access to ReviewOps filesystem, SSH, account, or database IPC. A failure of this boundary is a security issue.
- The browser viewer relaxes some web restrictions to support embedded workflows. Do not treat it as a substitute for a hardened browser profile for untrusted sites.
- SSH connections validate host keys. Unexpected automatic acceptance of a new or changed host key is a security issue.
- App updates are retrieved from the fixed public GitHub repository and verified before installation. Reports about unsafe download redirects, archive traversal, missing verification, or data loss are welcome.

Dependency notices are included in `THIRD-PARTY-NOTICES.txt`. Release builds are not currently Apple-notarized.
