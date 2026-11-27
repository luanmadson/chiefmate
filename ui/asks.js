// What a live session asks of the owner (#live-asks in ui/app.js), as a compact band under the conversation: one line
// per ask, or, from two on, one line with their number that unfolds into the lines. Each line unfolds its details.
// Nothing here touches the page: ui/app.js keeps the folds and draws the HTML; scripts/unit.mjs tests it.

/** From how many asks they are grouped in one line. */
export const GROUP_FROM = 2;

/** The folds of a session's band: the group (closed until opened) and the asks whose details are open. */
export const newFolds = session => ({ session, band: false, open: [] });

/** The folds after a click on a toggle ("band" or an ask's id): a new object, the old one untouched. */
export function toggleFold(folds, key) {
  if (key === 'band') return { ...folds, band: !folds.band };
  return { ...folds, open: folds.open.includes(key) ? folds.open.filter(id => id !== key) : [...folds.open, key] };
}

/** The folds kept for the asks still open: an answered ask's details don't come back with a new one, nor, once all are
 *  answered, the open group with the next ones. */
export const keepFolds = (folds, asks) => ({ ...folds, band: asks.length > 0 && folds.band, open: folds.open.filter(id => asks.some(a => a.id === id)) });

/** The band's layout: grouped or not, the group open or not, and each ask's line with its details open or not. */
export function asksLayout(asks, folds) {
  const grouped = asks.length >= GROUP_FROM;
  const expanded = !grouped || folds.band;
  return { grouped, expanded, count: asks.length, rows: expanded ? asks.map(a => ({ ask: a, open: folds.open.includes(a.id) })) : [] };
}

/**
 * The band's HTML. "ui": the app's t (translation), esc (escaping) and facts (an ask's details, already escaped).
 * Each toggle is a button with aria-expanded; the details it opens are in the page only when open.
 */
export function asksHtml(asks, folds, { t, esc, facts }) {
  if (!asks.length) return '';
  const layout = asksLayout(asks, folds);
  const label = `<span class="needs-label">${esc(t('Needs you'))}</span>`;
  const summary = a => (a.explain?.summary ? a.explain.summary : t('The agent asks to: {what}', { what: a.what }));
  const row = ({ ask, open }) => `<div class="live-ask"${open ? ' data-open' : ''}>
      <div class="live-ask-line">
        <button type="button" class="ask-toggle" data-ask-fold="${esc(ask.id)}" aria-expanded="${open}" aria-controls="ask-${esc(ask.id)}" title="${esc(open ? t('Hide the details') : t('See the details'))}">
          <span class="fold-mark" aria-hidden="true"></span>${layout.grouped ? '' : label}<span class="ask-what">${esc(summary(ask))}</span>
        </button>
        <span class="compose-buttons"><button type="button" class="button secondary small" data-live-refuse="${esc(ask.id)}">${esc(t('Refuse'))}</button><button type="button" class="button small" data-live-allow="${esc(ask.id)}">${esc(t('Allow'))}</button></span>
      </div>
      ${open ? `<div class="ask-details" id="ask-${esc(ask.id)}">${facts(ask)}</div>` : ''}
    </div>`;
  const rows = layout.rows.map(row).join('');
  if (!layout.grouped) return `<div class="live-asks-band" role="alert">${rows}</div>`;
  const head = `<div class="live-ask live-ask-group"${layout.expanded ? ' data-open' : ''}>
      <div class="live-ask-line">
        <button type="button" class="ask-toggle" data-ask-fold="band" aria-expanded="${layout.expanded}" aria-controls="ask-list">
          <span class="fold-mark" aria-hidden="true"></span>${label}<span class="ask-what">${esc(t('{count} permissions asked', { count: layout.count }))}</span><span class="ask-more">${esc(layout.expanded ? t('Hide') : t('Show'))}</span>
        </button>
      </div>
    </div>`;
  return `<div class="live-asks-band" role="alert">${head}${layout.expanded ? `<div class="ask-list" id="ask-list">${rows}</div>` : ''}</div>`;
}
