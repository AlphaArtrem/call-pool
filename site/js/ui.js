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
  snapshot: { key: 'snapshot', label: 'snapshot', title: 'From a published epoch directory. We wrote this file — it is reproducible from chain, and the commands to reproduce it are in “Verify it yourself”.' },
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
 */
export function field(node, { value, source, pending = 'reading…', unavailable = null }) {
  node.replaceChildren();

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
  node.append(valueNode);

  if (source) {
    const badge = document.createElement('span');
    badge.className = `source source-${source.key}`;
    badge.textContent = source.label;
    badge.title = source.title;
    node.append(' ', badge);
  }
}

/**
 * The failure state for a whole region.
 *
 * Says what could not be reached and what that means, rather than leaving a
 * spinner forever. §7.3: a wrong number here is worse than no number, and an
 * eternal spinner is a number the visitor invents themselves.
 */
export function failure(node, { what, error, consequence }) {
  node.replaceChildren();
  node.classList.add('failed');

  const heading = document.createElement('p');
  heading.className = 'failure-headline';
  heading.textContent = `⚠️ ${what}`;

  const because = document.createElement('p');
  because.className = 'failure-detail';
  because.textContent = consequence;

  const detail = document.createElement('pre');
  detail.className = 'failure-error';
  detail.textContent = error instanceof Error ? error.message : String(error);

  node.append(heading, because, detail);
}

/** A copyable address, monospace, with the copy affordance built in. */
export function addressNode(address, { href = null, truncate = false } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'address';

  const text = document.createElement(href ? 'a' : 'code');
  if (href) {
    text.href = href;
    text.rel = 'noopener noreferrer';
    text.target = '_blank';
  }
  text.className = 'mono';
  text.textContent = truncate ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
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
export function bars(node, { series, empty, unavailable = false }) {
  const rows = barSeries(series);
  if (rows == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const stack = document.createElement('div');
  stack.className = 'bar-stack';

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
export function sparkline(node, { values, label, empty, unavailable = false }) {
  const path = sparkPath(values);
  if (path == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const chart = svg('svg', {
    class: 'sparkline',
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
export function progressRail(node, { window: w, now, challengeSeconds, empty, unavailable = false }) {
  const progress = epochProgress({ window: w, now, challengeSeconds });
  if (progress == null) return chartState(node, empty, { unavailable });

  node.replaceChildren();
  const rail = document.createElement('div');
  rail.className = 'rail';
  rail.setAttribute('role', 'img');
  rail.setAttribute(
    'aria-label',
    `Epoch ${w.epoch} is ${Math.round(progress.elapsed * 100)}% elapsed.`,
  );

  const elapsed = document.createElement('span');
  elapsed.style.width = `${(progress.elapsed * 100).toFixed(1)}%`;
  rail.append(elapsed);

  if (progress.challengeShare > 0) {
    const challenge = document.createElement('span');
    challenge.className = 'is-secondary';
    challenge.style.width = `${(Math.min(1, progress.challengeShare) * 100).toFixed(1)}%`;
    rail.append(challenge);
  }

  const legend = document.createElement('div');
  legend.className = 'rail-legend';
  const left = document.createElement('span');
  left.textContent = `${Math.round(progress.elapsed * 100)}% elapsed`;
  const right = document.createElement('span');
  right.textContent = progress.challengeShare > 0 ? 'then the challenge window' : 'epoch';
  legend.append(left, right);

  node.append(rail, legend);
  return true;
}

/** One row of a definition-style table. */
export function row(label, valueNode, note = null) {
  const tr = document.createElement('tr');
  const th = document.createElement('th');
  th.scope = 'row';
  th.textContent = label;

  const td = document.createElement('td');
  td.append(valueNode);

  tr.append(th, td);
  if (note) {
    const noteRow = document.createElement('td');
    noteRow.className = 'note';
    noteRow.textContent = note;
    tr.append(noteRow);
  }
  return tr;
}
