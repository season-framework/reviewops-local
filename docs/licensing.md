# Licensing

ReviewOps application source is distributed under the [MIT License](../LICENSE).
Keep the copyright notice and license when distributing copies or modified versions.

The original ReviewOps interface and artwork come from the MIT-licensed source
snapshot identified in [NOTICE](../NOTICE). Account and SSH host management was
adapted from the project owner's Codex Account Manager source for this release.

Dependencies and assets keep their own licenses:

| Component | License | Included notice |
| --- | --- | --- |
| ReviewOps application and original artwork | MIT | `LICENSE`, `NOTICE` |
| React, React DOM, xterm.js, Lucide and most JavaScript dependencies | MIT | `THIRD-PARTY-NOTICES.txt` |
| Other bundled JavaScript dependencies | ISC, BSD-3-Clause, Unlicense | `THIRD-PARTY-NOTICES.txt` |
| SUIT fonts | SIL Open Font License 1.1 | `public/assets/font/LICENSE`, `THIRD-PARTY-NOTICES.txt` |
| Font Awesome Free group icons | CC BY 4.0 | `NOTICE` |
| Electron, Chromium and Node.js | Their respective licenses | License files inside the distributed app |

`npm run build` regenerates the dependency notice file from installed packages.
The app package includes `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt`.
The MIT license for the application does not replace the font, icon or dependency
licenses listed above.

External services accessed through the viewer, SSH or Codex are not part of this
distribution. Their accounts, subscriptions and service terms are separate.

License texts: [MIT](https://opensource.org/license/mit),
[SIL Open Font License](https://openfontlicense.org/),
[Font Awesome Free](https://fontawesome.com/license/free).
