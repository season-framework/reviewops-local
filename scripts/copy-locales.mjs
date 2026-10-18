import fs from 'node:fs/promises';
await fs.mkdir('dist/locales',{recursive:true});
for(const name of ['en.json','translations.json'])await fs.copyFile(`src/i18n/${name}`,`dist/locales/${name}`);
