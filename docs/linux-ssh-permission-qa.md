# Linux SSH folder-permission diagnostic

This manual diagnostic repeats existing **QA-034-004** on a real non-root Linux account. It adds no formal QA ID. It tests production `createAgentManager.environment()` and `preflight()` over an owned SSH2 loopback server and actual Linux Bash processes. It is not an OpenSSH-daemon, external-host, installed-app UI, real Codex login, agent-job or model-response acceptance.

The fixture generates a fresh in-memory host key and synthetic authentication. It uses a private HOME, CODEX_HOME, executable and existing working directory. The server listens only on `127.0.0.1`; no user SSH agent, account key, API credential or external host is selected. The CLI fixture accepts only `--version` and `login status`. Linux's native `setsid` is used through the unchanged production command; no macOS replacement is supplied.

## Observations

1. The normal folder passes preflight with the synthetic CLI version and login status.
2. The same existing folder is changed to mode `000`. A new environment query must return installation `null`, login `unknown`, `AGENT_WORK_PATH_INACCESSIBLE`, actual `Permission denied` and the production folder message. The CLI call count must not increase.
3. Preflight must reject with the same folder error; both original Bash commands must close with exit `125`.
4. Restoring mode `0700` must restore the same CLI diagnosis.
5. A separate absent executable must remain `AGENT_NOT_INSTALLED` / installation `false`.

The result records the actual Linux kernel, UID/GID, source, fixture bytes, bare production DTOs, original Bash handles and their exit/stdio observations, SSH channel/client closure and server closure. It requires zero agent jobs, updates and unexpected CLI/SFTP requests. The driver does not start an agent or invoke a model RPC. Private fixture files are retained on success and failure. It does not look up or adopt PIDs, signal processes, force-disconnect clients or recursively remove a possibly live fixture.

## Manual workflow

`linux-ssh-permission.yml` is `workflow_dispatch` only, uses Node 24.22.2 and a non-root Ubuntu runner, and has read-only repository permissions. Supply the full reviewed commit and select the matching branch. The harness rejects source drift, dirty checkouts, other operating systems, root execution, push events, rerun attempts and an unrelated workflow. A failure is not converted into a platform skip or automatically retried. The existing release workflows are unchanged.

GitHub requires this workflow file to exist on the repository's default branch before it can be manually dispatched. A new file present only on an unmerged feature branch is not dispatch-ready. Root must review and choose the normal integration prerequisite before authorizing a real run; this document does not claim that a Linux run has occurred.

The pure guard tests can be run without starting SSH, generating keys, importing product modules or launching Bash:

```sh
node --test tests/linux-ssh-permission.test.cjs
```

The executable diagnostic is hosted-only:

```sh
node scripts/diagnostics/linux-ssh-permission.mjs --run --source <reviewed-full-SHA>
```
