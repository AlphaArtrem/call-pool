// Render primitives, and the one that carries the most weight: the source
// badge.
//
// Phase 07 §7.3 — "a site that renders trusted and trustless data in the same
// style is training people not to notice which is which." Every number on the
// page goes through `field()`, and `field()` cannot be called without naming
// where the number came from. That is the whole reason this module exists;
// the rest is convenience.
//
// The chart helpers at the bottom are here rather than in a module of their
// own for the same reason: a chart is a number. It carries a badge like any
// other number — rendered by `field()` into the card's value slot — and it
// refuses to draw when there is nothing to draw, because an empty axis is a
// claim about the data. The refusing is done by the pure functions in
// graphs.js; these helpers only turn a refusal into a sentence.

import { barSeries, epochProgress, sparkPath } from './graphs.js';

/**
 * Where a number came from. The order is the order of trust.
 *
 *   chain    — read from an account by the visitor's own browser
 *   snapshot — from a published epoch directory, which we wrote
 *   pumpfun  — from pump.fun's API, the one input nobody can re-derive
 *   derived  — computed in this browser from the above
 */
export const SOURCES = {
  chain: { key: 'chain', label: 'chain', title: 'Read live from a Solana account by your browser. Nothing here passed through our server.' },
  snapshot: { key: 'snapshot', label: 'snapshot', title: 'From the published working for that day. We wrote this file — it is reproducible from chain, and the commands to redo it are under “Every day, on the record”.' },
  pumpfun: { key: 'pumpfun', label: 'pump.fun', title: 'From pump.fun’s callout API, queried by your browser. This is the one input that cannot be re-derived from chain — it exists only in their database.' },
  derived: { key: 'derived', label: 'computed here', title: 'Computed in your browser from the values beside it. Never fetched — our server cannot influence this number.' },
};

export function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
}

/** Escape before anything user- or API-supplied reaches innerHTML. */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Render one value with its provenance.
 *
 * `value == null` is not zero and not blank: it renders the pending or
 * unavailable state, which is the §7.4 rule made mechanical.
 *
 * `placeholder` is the one exception, and only before launch. It renders a
 * formatted zero in the slot — so the page shows the shape a real reading will
 * take rather than a sentence where a number goes — but dimmed, and with the
 * reason in the badge slot. That is deliberate: the badge slot is already where
 * this page answers "where did this number come from", and "not launched yet"
 * is an answer to that question. What it must never do is look like a reading,
 * which is why it is never styled as one. Do not reach for this for a failed
 * RPC: a zero that means "we could not look" is the exact lie §7.3 forbids.
 */
/**
 * Where this slot's provenance badge goes.
 *
 * A card can send its badge to its LABEL instead of keeping it beside the
 * figure, by naming a selector in `data-badge-into` — resolved against the
 * slot's own parent, so the markup says "my badge belongs up there" and every
 * one of the fourteen `field()` call sites stays as it was. The point is room:
 * beside a figure the badge is competing with it for the width, and the figure
 * is what the card is for.
 *
 * The badge is cleared out of the host on every render, because `field()` only
 * empties the slot it was handed.
 */
function badgeHost(node) {
  const selector = node.dataset?.badgeInto;
  if (!selector) return node;
  const host = node.parentElement?.querySelector(selector);
  if (!host) return node;
  for (const stale of host.querySelectorAll('.source')) stale.remove();
  return host;
}

export function field(
  node,
  { value, source, pending = 'reading…', unavailable = null, placeholder = null, title = null },
) {
  node.replaceChildren();
  const host = badgeHost(node);

  if (value == null && placeholder != null) {
    const zero = document.createElement('span');
    zero.className = 'value is-placeholder';
    zero.textContent = placeholder;
    node.append(zero);

    if (unavailable) {
      const badge = document.createElement('span');
      badge.className = 'source source-placeholder';
      badge.textContent = unavailable;
      badge.title = 'Not a reading. The coin has not launched, so this is what the slot will look like once there is something in it.';
      host.append(' ', badge);
    }
    return;
  }

  if (value == null) {
    const span = document.createElement('span');
    span.className = unavailable ? 'unavailable' : 'pending';
    span.textContent = unavailable ?? pending;
    node.append(span);
    return;
  }

  const valueNode = document.createElement('span');
  valueNode.className = 'value';
  valueNode.textContent = value;
  // The exact figure behind a rounded one. `formatSolShort` is only ever
  // allowed on screen when the full-precision value is one hover away — see
  // the note on it in standing.js.
  if (title) valueNode.title = title;
  node.append(valueNode);

  if (source) {
    const badge = document.createElement('span');
    badge.className = `source source-${source.key}`;
    badge.textContent = source.label;
    badge.title = source.title;
    host.append(' ', badge);
  }
}

/**
 * The failure state for a whole region.
 *
 * Says what could not be reached and what that means, rather than leaving a
 * spinner forever. §7.3: a wrong number here is worse than no number, and an
 * eternal spinner is a number the visitor invents themselves.
 *
 * Two audiences, in order. `what` and `consequence` are for someone who wants
 * to know whether to worry, and are written in plain words. The raw error —
 * an RPC message, a PDA that has no account — is folded away, because it
 * answers a question most readers did not ask and reads as "something is
 * broken" to everyone who cannot parse it. It is still one click away, and it
 * is still the thing that lets a technical reader check us.
 */
export function failure(node, { what, error, consequence }) {
  node.replaceChildren();
  node.classList.add('failed');

  const heading = document.createElement('p');
  heading.className = 'failure-headline';
  heading.textContent = what;

  const because = document.createElement('p');
  because.className = 'failure-detail';
  because.textContent = consequence;

  node.append(heading, because);

  if (error != null) {
    const fold = document.createElement('details');
    fold.className = 'failure-technical';

    const summary = document.createElement('summary');
    summary.textContent = 'Technical detail';

    const detail = document.createElement('pre');
    detail.className = 'failure-error';
    detail.textContent = error instanceof Error ? error.message : String(error);

    fold.append(summary, detail);
    node.append(fold);
  }
}

/** The middle-elided form: enough of both ends to check against a pinned post. */
function shortForm(address) {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/** A copyable address, monospace, with the copy affordance built in.
 *
 * `responsive` renders *both* forms and lets CSS pick one by viewport width —
 * a phone has no room for 44 base58 characters next to a label and a button.
 * Both spans are decoration as far as assistive tech is concerned: the element
 * carries the full address as its accessible name, so the reading is the same
 * at every width and does not depend on which span is currently displayed.
 */
export function addressNode(address, { href = null, truncate = false, responsive = false } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'address';

  const text = document.createElement(href ? 'a' : 'code');
  if (href) {
    text.href = href;
    text.rel = 'noopener noreferrer';
    text.target = '_blank';
  }
  text.className = 'mono';
  if (responsive) {
    const full = document.createElement('span');
    full.className = 'addr-full';
    full.textContent = address;
    const short = document.createElement('span');
    short.className = 'addr-short';
    short.textContent = shortForm(address);
    text.append(full, short);
    text.setAttribute('aria-label', address);
  } else {
    text.textContent = truncate ? shortForm(address) : address;
  }
  text.title = address;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = 'copy';
  copy.setAttribute('aria-label', `Copy ${address}`);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address);
      copy.textContent = 'copied';
      setTimeout(() => {
        copy.textContent = 'copy';
      }, 1500);
    } catch {
      // Clipboard is permissioned and can simply refuse. The full address is
      // already on the page as text, so selecting it by hand still works.
      copy.textContent = 'select it';
    }
  });

  wrap.append(text, copy);
  return wrap;
}

// ── charts ──────────────────────────────────────────────────────────────
//
// Every one of these takes an `empty` sentence and renders it, visibly, when
// the underlying function refuses. The sentence is required rather than
// optional: the moment it is optional, some future card renders nothing at all
// and nobody notices for a week.

/** What a chart shows instead of a chart. Never a blank, never a zeroed axis. */
export function chartState(node, message, { unavailable = false } = {}) {
  node.replaceChildren();
  const state = document.createElement('p');
  state.className = unavailable ? 'chart-state is-unavailable' : 'chart-state';
  state.textContent = message;
  node.append(state);
  return false;
}

function svg(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Labelled bars, scaled against the largest value in the set.
 *
 * Each bar carries its own value as text underneath. A bar without its number
 * beside it is a shape the reader has to trust; this page does not ask for
 * that anywhere else and will not start here.
 */
export function bars(node, { series, empty, unavailable = false, placeholder = false }) {
  const rows = placeholder
    ? series.map((s) => ({ label: s.label, ratio: 0, display: s.display, secondary: s.secondary === true }))
    : barSeries(series);
  if (rows == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const stack = document.createElement('div');
  stack.className = placeholder ? 'bar-stack is-placeholder' : 'bar-stack';

  for (const bar of rows) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = bar.label;

    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = bar.secondary ? 'bar-fill is-secondary' : 'bar-fill';
    fill.style.width = `${(bar.ratio * 100).toFixed(1)}%`;
    track.append(fill);

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = bar.display;

    row.append(label, track, value);
    stack.append(row);
  }

  node.append(stack);
  return true;
}

/**
 * A sparkline over a series, oldest first.
 *
 * `label` becomes the accessible name, because an <svg role="img"> with no
 * name is invisible to a screen reader and the shape is the whole point.
 */
export function sparkline(node, { values, label, empty, unavailable = false, placeholder = false }) {
  // A flat line along the floor of the box: the shape a series of zeros really
  // has, drawn dim so it cannot be mistaken for a run of settled days.
  const path = placeholder
    ? { line: 'M 0 53 L 220 53', area: 'M 0 53 L 220 53 L 220 56 L 0 56 Z', last: { x: 220, y: 53 } }
    : sparkPath(values);
  if (path == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const chart = svg('svg', {
    class: placeholder ? 'sparkline is-placeholder' : 'sparkline',
    viewBox: '0 0 220 56',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': label,
  });
  chart.append(
    svg('path', { class: 'area', d: path.area }),
    svg('path', { class: 'line', d: path.line }),
    svg('circle', { cx: path.last.x, cy: path.last.y, r: 3 }),
  );
  node.append(chart);
  return true;
}

/**
 * The epoch clock as a rail: elapsed, then the challenge window that follows.
 *
 * Drawn from the on-chain window rather than the visitor's calendar, so a
 * rehearsal deployment running short epochs draws short epochs.
 */
export function progressRail(
  node,
  { window: w, now, challengeSeconds, empty, unavailable = false, placeholder = false },
) {
  // Before launch there is no round to be part-way through, so the rail sits at
  // zero rather than refusing to draw — same geometry, dimmed.
  const progress = placeholder
    ? { elapsed: 0, challengeShare: 0 }
    : epochProgress({ window: w, now, challengeSeconds });
  if (progress == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const rail = document.createElement('div');
  rail.className = placeholder ? 'rail is-placeholder' : 'rail';
  rail.setAttribute('role', 'img');
  rail.setAttribute(
    'aria-label',
    placeholder
      ? 'No round is running yet. The rail is empty until the coin launches.'
      : `Today’s round is ${Math.round(progress.elapsed * 100)}% through.`,
  );

  const elapsed = document.createElement('span');
  elapsed.style.width = `${(progress.elapsed * 100).toFixed(1)}%`;
  rail.append(elapsed);

  if (progress.challengeShare > 0) {
    const challenge = document.createElement('span');
    challenge.className = 'is-secondary';
    const share = Math.min(1, progress.challengeShare);
    challenge.style.width = `${(share * 100).toFixed(1)}%`;
    // Under a mainnet clock this band is 0.35% wide and the CSS floor is doing
    // all the work, so the rail is no longer to scale here. Say which of the
    // two it is instead of drawing a bar that quietly overstates the window.
    challenge.title =
      share < 0.02
        ? 'The checking window — drawn wider than it really is so that it stays visible.'
        : 'The checking window.';
    rail.append(challenge);
  }

  const legend = document.createElement('div');
  legend.className = placeholder ? 'rail-legend is-placeholder' : 'rail-legend';
  const left = document.createElement('span');
  left.textContent = `${Math.round(progress.elapsed * 100)}% elapsed`;
  const right = document.createElement('span');
  right.textContent = placeholder
    ? 'not started'
    : progress.challengeShare > 0
      ? 'then the checking window'
      : 'today';
  legend.append(left, right);

  node.append(rail, legend);
  return true;
}

/**
 * The hint marker: an info icon that opens a tooltip on tap, hover or focus.
 *
 * A `title` attribute would have been free, and it is why this exists instead:
 * a title tooltip cannot be opened by touch at all. On a phone — where the
 * hint matters most, because there is no room to print it — it was invisible.
 *
 * A button rather than a decorated span, so it is one tap on a phone, one tab
 * stop and one Enter on a keyboard, and announced as something you can operate
 * rather than as loose text beside a label.
 */
let openHint = null;

function closeHint() {
  if (!openHint) return;
  openHint.button.setAttribute('aria-expanded', 'false');
  openHint.wrap.classList.remove('is-open');
  openHint = null;
}

// One listener for the page, not one per hint: tapping anywhere else closes
// whatever is open, and Escape does the same from the keyboard.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (openHint && !openHint.wrap.contains(event.target)) closeHint();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeHint();
  });
}

let hintSeq = 0;

function infoIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'hint-icon');

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('cx', '8');
  ring.setAttribute('cy', '8');
  ring.setAttribute('r', '6.75');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.4');

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', '8');
  dot.setAttribute('cy', '4.9');
  dot.setAttribute('r', '0.95');
  dot.setAttribute('fill', 'currentColor');

  const stem = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  stem.setAttribute('x', '7.2');
  stem.setAttribute('y', '6.9');
  stem.setAttribute('width', '1.6');
  stem.setAttribute('height', '5');
  stem.setAttribute('rx', '0.8');
  stem.setAttribute('fill', 'currentColor');

  svg.append(ring, dot, stem);
  return svg;
}

function hint(label, note) {
  const wrap = document.createElement('span');
  wrap.className = 'hint-wrap';

  const bubble = document.createElement('span');
  bubble.className = 'hint-bubble';
  bubble.id = `hint-${++hintSeq}`;
  bubble.setAttribute('role', 'tooltip');
  bubble.textContent = note;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hint';
  button.setAttribute('aria-label', `What “${label}” means`);
  button.setAttribute('aria-expanded', 'false');
  // The text is the button's description rather than its name, so a screen
  // reader announces the control and then the sentence, not a sentence where
  // a button name belongs.
  button.setAttribute('aria-describedby', bubble.id);
  button.append(infoIcon());

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = openHint?.button === button;
    closeHint();
    if (wasOpen) return;
    button.setAttribute('aria-expanded', 'true');
    wrap.classList.add('is-open');
    openHint = { button, wrap };
  });

  wrap.append(button, bubble);
  return wrap;
}

/**
 * One row of a definition-style table: a label and its value. Two columns.
 *
 * The hint is an info button beside the label rather than a column of its own.
 * As a column it was a sentence in whatever width was left over — on a tablet
 * a six-word-per-line ribbon, and one row of it stood taller than the three
 * rows around it put together.
 */
export function row(label, valueNode, note = null) {
  const tr = document.createElement('tr');
  const th = document.createElement('th');
  th.scope = 'row';

  // The text and the hint go in a flex wrapper rather than straight into the
  // cell: as inline content the icon was a word, and a word wraps — leaving it
  // stranded on a line of its own under a three-word label. The wrapper also
  // centres it against the text rather than against the last line of it.
  const inner = document.createElement('span');
  inner.className = 'th-inner';
  const text = document.createElement('span');
  text.textContent = label;
  inner.append(text);
  if (note) inner.append(hint(label, note));
  th.append(inner);

  const td = document.createElement('td');
  td.append(valueNode);

  tr.append(th, td);
  return tr;
}
