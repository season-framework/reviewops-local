import { expect } from '@playwright/test';

// Exercise the visible control and popup. Never change the hidden native select.
export async function openSelect(control) {
  await expect(control).toHaveAttribute('role', 'combobox');
  await expect(control).toBeEnabled();
  if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  const id = await control.getAttribute('id');
  if (!id) throw new Error('선택 항목에 연결된 팝업 식별자가 없습니다.');
  const popup = control.page().locator(`.reviewops-select-popup[data-select-owner=${JSON.stringify(id)}]`);
  await expect(popup).toBeVisible();
  return { popup, listbox: popup.getByRole('listbox'), search: popup.locator('[data-select-search]') };
}

export async function closeSelect(control) {
  if (await control.getAttribute('aria-expanded') === 'true') {
    const { search } = await openSelect(control);
    await (await search.count() ? search : control).press('Escape');
  }
  await expect(control).toHaveAttribute('aria-expanded', 'false');
}

export async function selectOptions(control, { close = true } = {}) {
  const { listbox } = await openSelect(control);
  const labels = await listbox.getByRole('option').allTextContents();
  if (close) await closeSelect(control);
  return labels.map(label => label.trim());
}

export async function expectSelectValue(control, value) {
  await expect(control).toHaveAttribute('data-value', String(value));
}

export async function expectSelectLabel(control, text, minimumWidth = 60) {
  const label = control.locator('.reviewops-select-value');
  await expect(label).toBeVisible();
  await expect(label).toContainText(text);
  const read = () => control.evaluate(element => {
    const label = element.querySelector('.reviewops-select-value');
    return { width: element.getBoundingClientRect().width, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth, text: label.textContent.trim() };
  });
  await expect.poll(async () => (await read()).width).toBeGreaterThan(minimumWidth);
  await expect.poll(async () => { const size = await read(); return size.labelWidth + 2 >= size.labelScrollWidth; }, { message: `선택 항목의 글자가 잘리지 않아야 합니다: ${JSON.stringify(await read())}` }).toBe(true);
  return read();
}

export async function typeSelectValue(control, value) {
  const { popup, listbox, search } = await openSelect(control);
  await expect(search).toBeVisible();
  await search.fill(String(value));
  const find = () => listbox.getByRole('option').evaluateAll((nodes, expected) => nodes.findIndex(node => node.getAttribute('data-value') === expected), String(value));
  await expect.poll(find).toBeGreaterThanOrEqual(0);
  await listbox.getByRole('option').nth(await find()).click();
  await expect(popup).toBeHidden();
  await expectSelectValue(control, value);
}

export async function selectControl(control, selection, { search: filter = false } = {}) {
  const { popup, listbox, search } = await openSelect(control);
  const candidates = await listbox.getByRole('option').evaluateAll(nodes => nodes.map(node => ({
    value: node.getAttribute('data-value'), label: node.textContent.trim(), disabled: node.getAttribute('aria-disabled') === 'true',
  })));
  const target = typeof selection === 'object' && selection !== null
    ? 'index' in selection ? candidates[selection.index] : candidates.find(item => 'value' in selection ? item.value === String(selection.value) : item.label === selection.label)
    : candidates.find(item => item.value === String(selection));
  if (!target) throw new Error(`선택할 항목을 찾을 수 없습니다: ${JSON.stringify(selection)}`);
  if (target.disabled) throw new Error('비활성화된 항목을 선택할 수 없습니다.');
  if (filter) {
    await expect(search).toBeVisible();
    await search.fill(target.label);
  }
  // Read only the visible option metadata to avoid CSS escaping assumptions for values.
  const index = await listbox.getByRole('option').evaluateAll((nodes, value) => nodes.findIndex(node => node.getAttribute('data-value') === value), target.value);
  if (index < 0) throw new Error('검색한 선택 항목을 찾을 수 없습니다.');
  await listbox.getByRole('option').nth(index).click();
  await expect(popup).toBeHidden();
  await expectSelectValue(control, target.value);
}
