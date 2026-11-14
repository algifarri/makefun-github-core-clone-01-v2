// main.ts — the entry's lifecycle against the trial environment.
//
// The environment's origin comes from MAKEFUN_ENV_URL. This process binds
// an ephemeral loopback port, tells the environment which port that is,
// and then asks, over and over, whether the trial is finished. When the
// environment says it is done, the server closes and the process exits
// cleanly. A missing MAKEFUN_ENV_URL is fatal at once: without an origin
// there is nobody to announce to.
//
// Registration treats 200 and 409 both as "the environment heard us"
// (409 means another registration already won, which is fine — the first
// one stands). A 400 or 405 means the request itself is wrong, so the
// process stops instead of retrying forever. Anything else is retried
// with a doubling delay that starts at a quarter of a second and never
// passes two seconds; each attempt gives up after thirty seconds.
//
// The done poll behaves the same way, except a healthy answer resets the
// delay back to the start, and a network failure never ends the process:
// the environment may hiccup, and the entry should outlast it.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The next wait in a doubling series that starts at 250 ms and caps at 2 s. */
function backoff(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

async function announce(envUrl: string, port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register was refused with HTTP ${response.status}`);
    }
    await response.arrayBuffer().catch(() => undefined);
    await sleep(backoff(attempt));
    attempt += 1;
  }
}

async function waitUntilDone(envUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
    } catch {
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    let body: unknown = null;
    try {
      body = (await response.json()) as unknown;
    } catch {
      body = null;
    }
    if (typeof body === 'object' && body !== null && (body as Record<string, unknown>).done === true) return;
    if (response.status === 200 && body !== null) attempt = 0;
    else attempt += 1;
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  if (ENV_URL === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('the server did not bind a port');
    process.exit(1);
  }
  const port = address.port;
  try {
    await announce(ENV_URL, port);
    await waitUntilDone(ENV_URL);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

run()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
