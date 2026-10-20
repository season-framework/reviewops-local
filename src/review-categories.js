import definitions from '../electron/review-categories.json' with {type:'json'};
import {t} from './i18n/index.js';

export const DEFAULT_REVIEW_CATEGORIES = definitions.defaults;
const builtins = [...definitions.defaults, ...definitions.legacy];
const customCategories = data => Array.isArray(data?.settings?.reviewCategories) ? data.settings.reviewCategories : [];
export const categoryNameKey = value => String(value).trim().normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();

export function reviewCategoryLabel(value, data, translate=t) {
  const builtin = builtins.find(([id]) => id === value);
  if (builtin) return translate(builtin[1]);
  return customCategories(data).find(item => item.id === value)?.name || value || '—';
}

export function reviewCategoryOptions(data, current='', translate=t) {
  const used = new Set([current, ...(data?.reviews || []).map(review => review.category)]);
  const options = [...definitions.defaults, ...definitions.legacy.filter(([id]) => used.has(id))].map(([id, name]) => [id, translate(name)]);
  for (const category of customCategories(data)) {
    if (typeof category?.id === 'string' && typeof category.name === 'string' && !options.some(([id]) => id === category.id)) options.push([category.id, category.name]);
  }
  if (current && !options.some(([id]) => id === current)) options.push([current, reviewCategoryLabel(current, data, translate)]);
  return options;
}

export function matchesReviewSearch(review, query, data, translate=t) {
  const needle = categoryNameKey(query);
  return !needle || categoryNameKey(`${review.title || ''}\n${reviewCategoryLabel(review.category, data, translate)}`).includes(needle);
}
