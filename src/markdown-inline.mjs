// Only identify inline Markdown. Rendering and link actions stay in React.
const escaped = (text, index) => {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
};

function linkAt(text, start) {
  let depth = 1, end = start + 1;
  for (; end < text.length; end++) {
    if (escaped(text, end)) continue;
    if (text[end] === '[') depth++;
    if (text[end] === ']' && --depth === 0) break;
  }
  if (depth || text[end + 1] !== '(') return null;
  const targetStart = end + 2;
  let targetEnd = targetStart, parentheses = 1, angle = false;
  for (; targetEnd < text.length; targetEnd++) {
    const character = text[targetEnd];
    if (escaped(text, targetEnd)) continue;
    if (character === '<' && !text.slice(targetStart, targetEnd).trim()) angle = true;
    else if (character === '>' && angle) angle = false;
    else if (!angle && character === '(') parentheses++;
    else if (!angle && character === ')' && --parentheses === 0) break;
  }
  if (parentheses || angle) return null;
  let target = text.slice(targetStart, targetEnd).trim();
  if (target.startsWith('<')) {
    const closing = target.indexOf('>');
    if (closing < 0 || (target.slice(closing + 1).trim() && !/^(?:"[\s\S]*"|'[\s\S]*'|\([\s\S]*\))$/.test(target.slice(closing + 1).trim()))) return null;
    target = target.slice(1, closing);
  } else {
    // A quoted optional title follows the destination; spaces in file names remain intact.
    target = target.replace(/\s+(?:"[^"\n]*"|'[^'\n]*')$/, '');
  }
  if (!target) return null;
  return {type:'link', label:text.slice(start + 1, end), target:target.replace(/\\([\\[\]()<>])/g,'$1'), end:targetEnd + 1};
}

export function parseInlineMarkdown(value) {
  const text = String(value ?? ''), tokens = [];
  let plain = '', index = 0;
  const flush = () => {if (plain) {tokens.push({type:'text',text:plain});plain = '';}};
  while (index < text.length) {
    if (text[index] === '\\' && /[\\[\]()*`<>]/.test(text[index + 1] || '')) {plain += text[index + 1];index += 2;continue;}
    if (text[index] === '`') {
      let delimiterEnd = index + 1;
      while (text[delimiterEnd] === '`') delimiterEnd++;
      const delimiter = text.slice(index, delimiterEnd), close = text.indexOf(delimiter, delimiterEnd);
      if (close >= 0) {flush();tokens.push({type:'code',text:text.slice(delimiterEnd,close)});index = close + delimiter.length;continue;}
    }
    if (text[index] === '[') {
      const link = linkAt(text,index);
      if (link) {flush();const {end,...token} = link;tokens.push(token);index = end;continue;}
    }
    if (text[index] === '*') {
      const delimiter = text[index + 1] === '*' ? '**' : '*';
      let close = text.indexOf(delimiter,index + delimiter.length);
      while (close >= 0 && escaped(text,close)) close = text.indexOf(delimiter,close + delimiter.length);
      if (close > index + delimiter.length) {flush();tokens.push({type:delimiter === '**' ? 'strong' : 'em',text:text.slice(index + delimiter.length,close)});index = close + delimiter.length;continue;}
    }
    plain += text[index++];
  }
  flush();
  return tokens;
}

export function markdownLinkType(target) {
  if (/^https?:\/\//i.test(target)) return 'external';
  if (/^(?:javascript|data|vbscript|mailto|tel|https?):/i.test(target)) return null;
  if (/^[a-z]:[\\/]/i.test(target)) return 'file';
  // A bare file name with a line suffix can resemble a URL scheme.
  if (/^[^/:]+:\d+(?::\d+)?$/.test(target)) return 'file';
  if (!/^[a-z][a-z\d+.-]*:/i.test(target) || /^(?:file:\/|sandbox:)/i.test(target)) return 'file';
  return null;
}
