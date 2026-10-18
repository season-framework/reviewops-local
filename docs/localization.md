# Interface translations

ReviewOps provides Korean and English interface text and translations of common controls in Japanese, Simplified Chinese, Traditional Chinese, Spanish, French, German, Brazilian Portuguese, Italian, Russian and Vietnamese. Untranslated interface messages use English. User content and diagnostic output from external tools are kept as received.

Choose **Settings → Display language**. The searchable list matches each language's native name, English name and language code. Changes apply immediately to the interface and native menus, without closing tabs or clearing drafts. The preference is saved on this computer. New installations start with the operating system's language when supported; existing Korean installations retain Korean until changed.

## Add or improve translations

- `src/i18n/en.json` maps Korean source messages to English.
- `src/i18n/translations.json` contains the additional language catalogs.
- `src/i18n/index.js` provides `t`, locale selection and static label catalogs.
- `electron/app-language.cjs` applies the same catalogs to native menus and file dialogs. The build copies catalogs to `dist/locales`.

Use `t('source message')` only for interface text written in source code. For values inside a message, use numbered placeholders: `t('{0} 열기', [file.name])`. Preserve every numbered placeholder in the translation. Render names, reviews, paths, file content, agent output and logs directly; never pass user content to the translator.

Static option catalogs use `localized([...])` so their labels follow language changes while their values stay unchanged. Decisions such as whether a credit can be used must depend on stable status codes, not translated labels. Dates and numeric displays should use `getLocale()`.

Run `node --test tests/i18n.test.cjs` for catalog and locale checks. Run `npm run build` and `node scripts/e2e-i18n.mjs` for the desktop language switch, searchable list, native menu, draft preservation and restart checks. UI fixtures use an isolated data folder and do not sign in, spend credits or connect to SSH hosts.
