// Line-art portraits of the crew. Each agent has a color and an accessory (the "face" field in agents/<id>.md);
// the expression follows what the agent is doing right now.

const EXPRESSIONS = {
  idle: { eyes: 'open', mouth: 'smile' },
  still: { eyes: 'open', mouth: 'smile' }, // like idle, without blinking: for lists and the chat history
  queued: { eyes: 'open', mouth: 'flat' },
  working: { eyes: 'open', look: [-1.6, 1.4], mouth: 'flat', busy: true },
  reviewing: { eyes: 'open', look: [1.6, 1.2], mouth: 'flat', busy: true },
  thinking: { eyes: 'open', look: [1.4, -1.6], mouth: 'small', busy: true },
  waiting: { eyes: 'half', mouth: 'flat' },
  done: { eyes: 'happy', mouth: 'grin' },
  failed: { eyes: 'open', mouth: 'frown', brows: true },
  offline: { eyes: 'closed', mouth: 'flat' },
};

const INK = 'var(--face-ink)';
const FILL = 'var(--face-fill)';

const ACCESSORIES = {
  // Officer's cap, with a brass badge: the chief mate.
  cap: c =>
    `<path d="M18.6 21.4C17.2 13.2 46.8 13.2 45.4 21.4Z" fill="${FILL}" stroke="${c}" stroke-width="2"/>` +
    `<path d="M19.5 21.6h25" stroke="${c}" stroke-width="2.6"/>` +
    `<path d="M23 22.8q9 3.6 18 0" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<path d="M32 15.2l2 2-2 2-2-2z" fill="${c}"/>`,
  hardhat: c =>
    `<path d="M19.5 23.5C19.5 11.5 44.5 11.5 44.5 23.5Z" fill="${FILL}" stroke="${c}" stroke-width="2"/>` +
    `<path d="M16.5 24h31" stroke="${c}" stroke-width="2.6"/>` +
    `<path d="M32 12.8v5.4" stroke="${c}" stroke-width="2"/>`,
  glasses: c =>
    `<rect x="23.2" y="26.2" width="7.6" height="5.6" fill="none" stroke="${c}" stroke-width="1.6"/>` +
    `<rect x="33.2" y="26.2" width="7.6" height="5.6" fill="none" stroke="${c}" stroke-width="1.6"/>` +
    `<path d="M30.8 28.4h2.4M23.2 28.2h-3.4M40.8 28.2h3.4" stroke="${c}" stroke-width="1.6"/>`,
  monocle: c =>
    `<circle cx="36.5" cy="29" r="4" fill="none" stroke="${c}" stroke-width="1.6"/>` +
    `<path d="M40.3 30.4q3.4 5.4 1.2 12.4" fill="none" stroke="${c}" stroke-width="1.2"/>`,
  beret: c =>
    `<path d="M18.2 21C17.4 12.6 41 9.8 46.4 17.8 43.2 21.4 24.6 22.8 18.2 21Z" fill="${FILL}" stroke="${c}" stroke-width="2"/>` +
    `<path d="M39.6 11.6l1.8-2.6" stroke="${c}" stroke-width="2"/>`,
  headset: c =>
    `<path d="M19.4 29C19.4 12.6 44.6 12.6 44.6 29" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<rect x="16.4" y="26.4" width="4.4" height="8" fill="${FILL}" stroke="${c}" stroke-width="1.8"/>` +
    `<rect x="43.2" y="26.4" width="4.4" height="8" fill="${FILL}" stroke="${c}" stroke-width="1.8"/>` +
    `<path d="M18.6 34.4q1.4 6 9.4 5.4" fill="none" stroke="${c}" stroke-width="1.6"/>`,
};

function eyes(kind, [dx, dy] = [0, 0]) {
  const left = 27.5 + dx;
  const right = 36.5 + dx;
  const y = 29 + dy;
  switch (kind) {
    case 'half':
      return `<g class="face-eyes" stroke="${INK}" stroke-width="1.6"><path d="M25.4 28.2h4.2M34.4 28.2h4.2"/></g><circle cx="27.5" cy="29.8" r="1.2" fill="${INK}"/><circle cx="36.5" cy="29.8" r="1.2" fill="${INK}"/>`;
    case 'closed':
      return `<path class="face-eyes" d="M25.4 29q2.1 1.6 4.2 0M34.4 29q2.1 1.6 4.2 0" fill="none" stroke="${INK}" stroke-width="1.6"/>`;
    case 'happy':
      return `<path class="face-eyes" d="M25.4 30q2.1-2.6 4.2 0M34.4 30q2.1-2.6 4.2 0" fill="none" stroke="${INK}" stroke-width="1.6"/>`;
    default:
      return `<g class="face-eyes" fill="${INK}"><circle cx="${left}" cy="${y}" r="1.9"/><circle cx="${right}" cy="${y}" r="1.9"/></g>`;
  }
}

function mouth(kind) {
  const line = d => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`;
  switch (kind) {
    case 'grin':
      return line('M27.8 34.8q4.2 4 8.4 0');
    case 'flat':
      return line('M29.4 36h5.2');
    case 'small':
      return `<circle cx="32" cy="36" r="1.4" fill="none" stroke="${INK}" stroke-width="1.4"/>`;
    case 'frown':
      return line('M28.8 37.2q3.2-2.4 6.4 0');
    default:
      return line('M28.6 35.2q3.4 2.6 6.8 0');
  }
}

/** The SVG portrait of an agent ({ color, face }) in a state, at a size in pixels. */
export function face(agent, state = 'idle', size = 48, label = '') {
  const color = agent?.color || '#8a93a0';
  const look = EXPRESSIONS[state] ?? EXPRESSIONS.idle;
  const accessory = ACCESSORIES[agent?.face]?.(color) ?? '';
  const busy = look.busy
    ? `<g class="face-busy" fill="${color}"><circle cx="49" cy="8.5" r="1.7"/><circle cx="54" cy="8.5" r="1.7"/><circle cx="59" cy="8.5" r="1.7"/></g>`
    : '';
  const brows = look.brows ? `<path d="M25.2 25.6l4-1.2M38.8 25.6l-4-1.2" stroke="${INK}" stroke-width="1.4"/>` : '';
  const a11y = label ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
  return `<svg class="face face-${state}" viewBox="0 0 64 64" width="${size}" height="${size}" ${a11y}>` +
    `<rect class="face-frame" x="0.5" y="0.5" width="63" height="63" fill="var(--face-tile)" stroke="${look.busy ? color : 'var(--line-strong)'}"/>` +
    `<path d="M13 63.5C13 51 20.5 46 32 46S51 51 51 63.5" fill="${FILL}" stroke="${color}" stroke-width="2.2"/>` +
    `<path d="M28.8 42v4.2M35.2 42v4.2" stroke="${color}" stroke-width="2"/>` +
    `<circle cx="32" cy="30" r="12.5" fill="${FILL}" stroke="${color}" stroke-width="2.2"/>` +
    accessory + eyes(look.eyes, look.look) + mouth(look.mouth) + brows + busy +
    '</svg>';
}
