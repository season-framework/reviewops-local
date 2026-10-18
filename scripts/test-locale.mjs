// Existing UI regression suites assert Korean labels. New installations follow
// the user's OS language, so each isolated test profile selects its own locale.
export async function setTestLocale(page, locale = 'ko') {
  await page.waitForFunction(() => location.protocol === 'reviewops:' && Boolean(window.reviewops?.invoke));
  await page.evaluate(value => localStorage.setItem('reviewops.language', value), locale);
  await page.reload();
  await page.waitForFunction(value => document.documentElement.lang === value, locale);
}
