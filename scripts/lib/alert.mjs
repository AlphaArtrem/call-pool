// scripts/lib/alert.mjs — the one place that says something out loud.
//
// Phase 09 §9.3, and the lesson of every bug this project has had: **alert on
// the absence of a settlement, not only on errors.** A crank that dies quietly
// looks exactly like a crank that had nothing to do, and from outside a coin
// that stops paying looks exactly like a rug.
//
// Three rules it follows.
//
//   * **Never throw into the caller.** A settlement must not fail because
//     Telegram was down. Failures here are logged and swallowed, which is the
//     one place in this codebase where swallowing is correct — the alternative
//     is an alerting bug that stops payouts.
//   * **Never send a secret.** The crank's own error messages quote the RPC URL
//     it was using, and the API key is *in that URL's path*. Sending one
//     un-redacted would publish the key to Telegram's servers and leave it in a
//     chat log forever. Everything is redacted on the way out, at this choke
//     point, so no caller has to remember.
//   * **Unconfigured is not an error.** With no token the alerter prints to the
//     console and carries on, so a developer running the crank by hand is not
//     forced to set up a bot.

/** Telegram's limit is 4096 characters; leave room for the truncation note. */
const MAX_MESSAGE = 3800;

/**
 * Strip credentials out of anything on its way to a chat log.
 *
 * The live case: `https://rpc.ankr.com/solana_devnet/0031609f…` — the key is a
 * path segment, so redacting query strings alone would miss it entirely. Host
 * is kept because knowing *which* provider failed is most of the diagnosis.
 */
export function redactSecrets(text = '') {
  return String(text)
    // Any URL keeps its scheme and host and loses everything after.
    .replace(/(https?:\/\/[^/\s]+)(\/[^\s'"`)]*)?/gi, (_, origin, rest) =>
      rest && rest !== '/' ? `${origin}/…` : origin)
    // Bare `key=…` / `token=…` / `secret=…` pairs, wherever they turn up.
    .replace(/\b(api[-_]?key|token|secret|password)\b(\s*[=:]\s*)\S+/gi, '$1$2…');
}

/** Trim to Telegram's limit, saying so rather than silently losing the tail. */
export function clamp(text, limit = MAX_MESSAGE) {
  const clean = String(text);
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}\n… (${clean.length - limit} more characters)`;
}

/**
 * Where the alerter sends, or `null` when it is not configured.
 *
 * Read from the environment rather than a file, so the token lives in the
 * systemd unit's EnvironmentFile beside the signing keys and never in the repo.
 */
export function alertConfig(env = process.env) {
  const token = env.CALLPOOL_TELEGRAM_TOKEN;
  const chat = env.CALLPOOL_TELEGRAM_CHAT;
  return token && chat ? { token, chat } : null;
}

/**
 * Say something, and never let saying it break the caller.
 *
 * Returns whether it was delivered, for tests and for a caller that wants to
 * log the difference. It does not throw, and it does not retry: the watchdog
 * runs on a timer, so the next tick is the retry.
 */
export async function alert(text, { env = process.env, fetchFn = fetch, log = console.log } = {}) {
  const body = clamp(redactSecrets(text));
  const config = alertConfig(env);

  if (!config) {
    log(`[alert — not configured, printing instead]\n${body}`);
    return false;
  }

  try {
    const response = await fetchFn(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chat, text: body, disable_web_page_preview: true }),
    });
    if (!response.ok) {
      // The status, not the body: an error body from Telegram echoes the
      // request back, and the request contains the bot token.
      log(`[alert FAILED — telegram returned ${response.status}]\n${body}`);
      return false;
    }
    return true;
  } catch (error) {
    log(`[alert FAILED — ${redactSecrets(error.message)}]\n${body}`);
    return false;
  }
}
