import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);

export function dueCredit(snapshot, nowSeconds, leadSeconds, attempts = {}) {
  return (snapshot.rateLimitResetCredits?.credits ?? [])
    .filter(credit => credit.status === 'available'
      && credit.resetType === 'codexRateLimits'
      && typeof credit.id === 'string' && credit.id.length > 0
      && Number.isFinite(credit.expiresAt)
      && credit.expiresAt > nowSeconds
      && credit.expiresAt - nowSeconds <= leadSeconds
      && attempts[credit.id]?.status !== 'redeemed')
    .sort((a, b) => a.expiresAt - b.expiresAt)[0] ?? null;
}

function displayTime(seconds, timeZone) {
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return {
    utc: date.toISOString(),
    local: new Intl.DateTimeFormat('en-US', {
      timeZone, dateStyle: 'medium', timeStyle: 'long',
    }).format(date),
    timeZone,
  };
}

export function summarize(snapshot, timeZone = 'America/New_York') {
  const limits = snapshot.rateLimitsByLimitId?.codex ?? snapshot.rateLimits;
  const credits = snapshot.rateLimitResetCredits;
  return {
    availableCount: credits?.availableCount ?? null,
    detailsAvailable: Array.isArray(credits?.credits),
    usedPercent: {
      fiveHour: limits?.primary?.usedPercent ?? null,
      weekly: limits?.secondary?.usedPercent ?? null,
    },
    resets: (credits?.credits ?? []).map(credit => ({
      title: credit.title,
      status: credit.status,
      expiry: displayTime(credit.expiresAt, timeZone),
    })),
  };
}

export async function checkAccount({ rpc, state, save, enabled, leadSeconds,
  timeZone = 'America/New_York', now = () => Date.now() / 1000, log = console.log }) {
  const snapshot = await rpc('account/rateLimits/read');
  // Never infer an empty bank from missing fields or reuse attempts for another account.
  if (typeof snapshot.accountId !== 'string' || !snapshot.accountId) {
    throw new Error('Account ID is unavailable; refusing to redeem a reset.');
  }
  if (state.accountId !== snapshot.accountId) {
    state.accountId = snapshot.accountId;
    state.attempts = {};
  }
  state.attempts ??= {};
  const summary = summarize(snapshot, timeZone);
  state.lastSuccessfulCheck = new Date(now() * 1000).toISOString();
  state.summary = summary;
  await save(state);
  log({ event: 'account_checked', enabled, leadMinutes: leadSeconds / 60, ...summary });
  if (!summary.detailsAvailable) {
    throw new Error('Reset details are unavailable; cannot determine expiry safely.');
  }
  const credit = dueCredit(snapshot, now(), leadSeconds, state.attempts);
  if (!credit) return { outcome: 'not_due', summary };
  if (!enabled) {
    log({ event: 'dry_run', expiry: displayTime(credit.expiresAt, timeZone) });
    return { outcome: 'dry_run', summary };
  }

  const attempt = state.attempts[credit.id] ?? {
    idempotencyKey: randomUUID(), status: 'pending',
  };
  state.attempts[credit.id] = attempt;
  // Persist before sending. An uncertain response must reuse this key after restart.
  await save(state);
  if (now() >= credit.expiresAt) return { outcome: 'expired', summary };
  const result = await rpc('account/rateLimitResetCredit/consume', {
    creditId: credit.id, idempotencyKey: attempt.idempotencyKey,
  });
  if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result.outcome)) {
    throw new Error('Unexpected redemption outcome; retaining the retry key.');
  }
  attempt.lastOutcome = result.outcome;
  if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
    attempt.status = 'redeemed';
    attempt.redeemedAt = new Date(now() * 1000).toISOString();
  } else {
    // These are definitive non-redemptions. A future eligible window is a new attempt.
    delete state.attempts[credit.id];
  }
  await save(state);
  log({ event: 'redemption_result', outcome: result.outcome,
    expiry: displayTime(credit.expiresAt, timeZone) });
  const refreshed = await rpc('account/rateLimits/read');
  state.summary = summarize(refreshed, timeZone);
  state.lastSuccessfulCheck = new Date(now() * 1000).toISOString();
  await save(state);
  log({ event: 'account_refreshed', ...state.summary });
  return { outcome: result.outcome, summary: state.summary };
}

export async function openAccountClient(cliPath) {
  const child = spawn(process.execPath, [cliPath, 'app-server', '--stdio',
    '-c', 'cli_auth_credentials_store="file"'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  let failure;
  const fail = error => {
    failure = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on('error', () => fail(new Error('Cannot start Codex app-server.')));
  child.on('exit', () => fail(new Error('Codex app-server exited.')));
  child.stdin.on('error', () => fail(new Error('Codex app-server input closed.')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${entry.method} failed (code ${message.error.code}); check Codex login.`));
    } else {
      entry.resolve(message.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((accept, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out; any redemption will retain its retry key.`));
    }, 40_000);
    pending.set(id, { resolve: accept, reject, timer, method });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const close = async () => {
    lines.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(accept => child.once('exit', accept));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  };
  try {
    await rpc('initialize', {
      clientInfo: { name: 'codex_reset_watch', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return { rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

async function main() {
  const once = process.argv.includes('--once');
  const leadSeconds = positiveNumber('REDEEM_BEFORE_MINUTES', 30) * 60;
  const pollMs = positiveNumber('CHECK_INTERVAL_SECONDS', 60) * 1000;
  if (pollMs / 1000 >= leadSeconds) {
    throw new Error('Check interval must be shorter than the redemption lead time.');
  }
  const enabledValue = process.env.REDEEM_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabledValue)) {
    throw new Error('REDEEM_ENABLED must be true or false.');
  }
  const enabled = enabledValue === 'true' && !process.argv.includes('--dry-run');
  const timeZone = process.env.DISPLAY_TIMEZONE ?? 'America/New_York';
  displayTime(0, timeZone); // Reject an invalid display timezone before contacting the account.
  const stateDir = resolve(process.env.STATE_DIR ?? './data/state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read saved state; refusing unsafe retries.');
    state = { attempts: {} };
  }
  const save = async value => {
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  };
  const cliPath = process.env.CODEX_CLI_JS
    ?? join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  const log = value => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...value }));
  const controller = new AbortController();
  let activeClient;
  const stop = () => { controller.abort(); void activeClient?.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  do {
    try {
      activeClient = await openAccountClient(cliPath);
      await checkAccount({ rpc: activeClient.rpc, state, save, enabled, leadSeconds, timeZone, log });
      if (controller.signal.aborted) break;
    } catch (error) {
      log({ event: 'check_failed', message: error.message });
      if (once) process.exitCode = 1;
    } finally {
      await activeClient?.close();
      activeClient = undefined;
    }
    if (once || controller.signal.aborted) break;
    try { await delay(pollMs, undefined, { signal: controller.signal }); }
    catch { break; }
  } while (!controller.signal.aborted);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
