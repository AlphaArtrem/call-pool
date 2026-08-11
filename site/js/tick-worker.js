// A one-second heartbeat that survives a backgrounded tab.
//
// Chrome applies "intensive throttling" to a hidden page's main thread: after
// roughly five minutes out of view, `setInterval` is clamped to once a MINUTE.
// The countdowns are recomputed from `Date.now()` on every tick, so they were
// never wrong — but at one update a minute they sit still and then jump sixty
// seconds, which on a livestream reads as a frozen page.
//
// A dedicated worker's timers are not on that queue and keep firing at roughly
// 1 Hz while the page is hidden. The worker does no work of its own and holds
// no state: it posts an empty message and the main thread does the rendering,
// so there is exactly one place where a countdown is computed.
//
// Deliberately a classic worker, not a module: it needs no imports, and the
// classic form is what `script-src 'self'` admits without argument.

let handle = null;

self.onmessage = (event) => {
  if (event.data === 'start') {
    if (handle == null) handle = setInterval(() => self.postMessage(0), 1000);
    return;
  }

  if (event.data === 'stop') {
    clearInterval(handle);
    handle = null;
  }
};
