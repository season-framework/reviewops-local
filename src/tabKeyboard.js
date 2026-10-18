// Use the same selection action for pointer and keyboard navigation.
export function tabKeyboard(event) {
  if(event.altKey||event.ctrlKey||event.metaKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const current=event.target.closest('.reviewops-tab');
  if(!current||!event.currentTarget.contains(current))return;
  const buttons=[...event.currentTarget.querySelectorAll('.reviewops-tab')].filter(button=>!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&button.getClientRects().length);
  const index=buttons.indexOf(current);
  if(index<0||!buttons.length)return;
  const next=event.key==='Home'?buttons[0]:event.key==='End'?buttons.at(-1):buttons[(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length];
  event.preventDefault();event.stopPropagation();
  next.focus();next.click();
}
