// The app's translations. English is the source; ui/locales/<language>.json holds the other languages.
let dictionary = {};
let current = 'en';

export async function setLanguage(code) {
  current = code || 'en';
  dictionary = {};
  if (!current.startsWith('en')) {
    try {
      dictionary = await (await fetch(`/locales/${current}.json`, { cache: 'no-store' })).json();
    } catch {
      dictionary = {};
    }
  }
  document.documentElement.lang = current;
}

export const language = () => current;
export const locale = () => (current.startsWith('en') ? 'en-US' : current);

/** t('Send'), or with values: t('On duty: {title}', { title }). */
export function t(text, values = {}) {
  const template = dictionary[text] ?? text;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** Translates the page's fixed texts: data-t (the text), data-t-placeholder, data-t-title and data-t-label (aria-label). */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of root.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle);
  for (const el of root.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.dataset.tLabel));
}
