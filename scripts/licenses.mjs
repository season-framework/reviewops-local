import fs from 'node:fs';
import path from 'node:path';
const packages = ['@xterm/xterm','@xterm/addon-fit','react','react-dom','scheduler','ssh2','asn1','bcrypt-pbkdf','tweetnacl','safer-buffer','cpu-features','buildcheck','nan'];
const lock = JSON.parse(fs.readFileSync('package-lock.json','utf8'));
for (const [directory, metadata] of Object.entries(lock.packages || {})) {
  if (directory.startsWith('node_modules/') && !metadata.dev) packages.push(directory.slice('node_modules/'.length));
}
let output = 'ReviewOps — bundled dependency licenses\n';
for (const name of new Set(packages)) {
  const root = path.resolve('node_modules',name);
  if (!fs.existsSync(root)) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  output += `\n\n${pkg.name || name} ${pkg.version} (${pkg.license || 'see license'})\n`;
  const files = fs.readdirSync(root).filter(file=>/^(license|copying|notice)(\.|$)/i.test(file));
  for(const file of files) if(fs.statSync(path.join(root,file)).isFile()) output += '\n'+fs.readFileSync(path.join(root,file),'utf8');
}
const localFont = 'public/assets/font/LICENSE';
if (fs.existsSync(localFont)) output += '\n\nSUIT\n'+fs.readFileSync(localFont,'utf8');
fs.writeFileSync('THIRD-PARTY-NOTICES.txt',output.replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,''));
