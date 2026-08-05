// The top bar's three controls: the theme toggle, the cluster switch, and the
// social links.
//
// Kept out of app.js because none of them touches a number. Nothing in this
// file can change what the page claims — the worst a bug here can do is show
// the wrong icon, and that is exactly the property that lets it be simple.

import { el } from './ui.js';

const THEME_KEY = 'callpool.theme';

const ICONS = {
  light: `<svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
    <path d="M12 3v2.4M12 18.6V21M4.3 4.3 6 6M18 18l1.7 1.7M3 12h2.4M18.6 12H21M4.3 19.7 6 18M18 6l1.7-1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
  </svg>`,
  dark: `<svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
    <path d="M20.2 14.5A7.7 7.7 0 0 1 9.5 3.8 8.4 8.4 0 1 0 20.2 14.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`,
};

/**
 * The current theme: an explicit choice if one was made, otherwise the OS.
 *
 * app.css carries `:root[data-theme="…"]` rules that win over the
 * `prefers-color-scheme` media query in **both** directions. A stylesheet that
 * themes only through the media query has a toggle that appears to do nothing
 * for whichever half of its visitors already had the theme they asked for.
 */
function currentTheme() {
  return (
    document.documentElement.getAttribute('data-theme') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function wireTheme() {
  const button = el('theme-toggle');

  const render = () => {
    const mode = currentTheme();
    button.innerHTML = ICONS[mode];
    const label = mode === 'dark' ? 'Dark' : 'Light';
    button.setAttribute('aria-label', `Switch theme. Currently: ${label.toLowerCase()}.`);
    button.title = `${label} mode`;
  };

  render();
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing refuses storage. The toggle still works for this
      // page load; it just will not be remembered, which is a fine outcome
      // for a preference and not worth telling anyone about.
    }
    render();
  });
}

/**
 * The cluster switch.
 *
 * It reloads with `?cluster=` set rather than storing the choice, and that is
 * deliberate: `resolveCluster()` reads the query string, so the URL after a
 * switch describes exactly what the page is showing. Someone who pastes that
 * link into a chat is sharing the devnet view, not their own local preference
 * applied to somebody else's browser. It is one number in a URL against a
 * whole class of "it looks different on my screen".
 */
function wireCluster(config) {
  const select = el('cluster-select');
  select.value = config.cluster;
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('cluster', select.value);
    location.href = url.toString();
  });
}

/**
 * The X and GitHub links.
 *
 * Both come from config, and an unset one stays on the page as a disabled chip
 * that says why. §7.4's rule is about numbers, but the reasoning carries: a
 * link nobody configured is a link nobody checked, and shipping a plausible
 * URL to a repository that may not exist is the same failure as shipping a
 * plausible balance.
 */
function wireLinks(config) {
  const targets = [
    ['link-x', config.links.x, 'The announcement account is not published yet.'],
    ['link-github', config.links.github, 'The source repository is not published yet.'],
  ];

  for (const [id, href, missing] of targets) {
    const node = el(id);
    if (href == null) {
      node.setAttribute('aria-disabled', 'true');
      node.removeAttribute('href');
      node.title = missing;
      continue;
    }
    node.href = href;
    node.rel = 'noopener noreferrer';
    node.target = '_blank';
    node.removeAttribute('aria-disabled');
  }
}

export function wireTopbar(config) {
  wireTheme();
  wireCluster(config);
  wireLinks(config);
}
