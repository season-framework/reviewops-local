# Contributing to ReviewOps

Use an issue to describe a problem or discuss a substantial change before beginning a large implementation.

## Set up

Use macOS or Windows with Node.js 24 or later. Build installation packages on the matching operating system.

```sh
git clone https://github.com/season-framework/reviewops-local.git
cd reviewops-local
npm ci
npm run dev
```

The renderer is in `src/`; native and data operations are in `electron/`. Renderer code should use the app's IPC bridge rather than direct filesystem or shell access.

## Make a change

1. Create a focused branch.
2. Implement the change and preserve existing project data.
3. Run `npm run build` and `npm test`.
4. Run the UI test relevant to the change, such as `npm run test:selects` or `npm run test:project-connections`.
5. Check the rendered interface at narrow and wide window sizes when changing layout.
6. Open a pull request describing the user-visible change, the checks you ran, and any remaining limitations.

Use the shared `Select` control for dropdowns. Keep long or user-created lists searchable. Maintain keyboard access, focus behavior, labels, and clear disabled states. Add user-facing text to the locale catalogs and retain a useful fallback.

Schema changes need a migration that preserves reviews, attachments, connections, and agent history. Keep network and native filesystem operations in the Electron process. Do not expose privileged IPC to external web pages.

## Test data and credentials

Use temporary directories, example domains, synthetic accounts, and fake CLI processes. Test code must not sign into a real account, consume credits, modify remote servers, or replace a user's default Codex credentials. Do not commit app data, screenshots containing private content, SSH configuration, tokens, or absolute workstation paths.

Reproduction logs should show the failure without account emails, host details, credentials, or project content. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Dependencies and licensing

Keep dependency changes necessary and small. Run the build to regenerate `THIRD-PARTY-NOTICES.txt` when dependencies change, and preserve third-party copyright and license notices. Contributions are provided under the repository's MIT license; only submit material you have permission to contribute.

## Documentation

Use clear, direct language and describe behavior that is implemented. Do not imply that every platform, site login, language, or remote host has been tested. Use synthetic data for public screenshots and examples. The GitHub Pages source lives in `website/` and has no build dependency.

Release maintainers should follow [docs/releasing.md](docs/releasing.md).
