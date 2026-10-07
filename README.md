# Reset Reaper

**Early prototype:** This initial version is a "quick and dirty" project made
with Codex, not a finished release. Tests and live account checks pass, but it
still needs to redeem an expiring reset for real on the author's VPS to prove
that it works as expected. Further improvements may be needed before release.

Runs independently on an always-on Linux VPS. Every minute it reads the account's
banked full resets and redeems the earliest-expiring eligible one when it has
**30 minutes or less left**. This lead time is configurable. Checks and scheduling
use Unix timestamps, so neither the VPS timezone nor daylight saving time affects
redemption. Logs show both UTC and `America/New_York` time.

The job calls `account/rateLimits/read` and
`account/rateLimitResetCredit/consume` through the installed Codex app-server.
It does not run model turns. It never chooses another credit implicitly, never
redeems before the configured window, and skips expired or unknown-expiry credits.
Failed checks retry the next minute. An uncertain redemption reuses its saved
idempotency key; successful redemptions are saved before refreshing account limits.
If the service returns `nothingToReset`, the watcher retries on subsequent checks;
a reset cannot be forced when the service finds no eligible window.

Official interface: <https://learn.chatgpt.com/docs/app-server>
Authentication: <https://learn.chatgpt.com/docs/auth>

## Docker Compose / Coolify

Deploy this directory as a Compose application with the included `compose.yaml`.
It requires no domain, web service, or exposed port. Keep the named volume mounted
at `/data`; it stores both Codex login and redemption state. Run exactly one
instance against that volume. The image runs as the unprivileged `node` user.

Clone the repository, copy the example settings, and build on the VPS:

```sh
git clone https://github.com/Stebulous/reset-reaper.git
cd reset-reaper
cp .env.example .env
docker compose build
```

Use Docker Compose v2 or newer. Prefix Docker commands with `sudo` if your Linux
user does not have permission to access Docker. Keep the same Compose project
name when signing in, checking, and running so all commands use the same volume.

Sign in using the persistent volume:

```sh
docker compose run --rm codex-reset-watch node /app/node_modules/@openai/codex/bin/codex.js -c 'cli_auth_credentials_store="file"' login --device-auth
```

Complete the device sign-in in your browser. This is the ChatGPT/Codex account
login, not an API key. The VPS stores its own login; there is no need to copy the
PC's credential file. If device sign-in is disabled for your account, enable it in
your Codex account security settings or use the supported browser login flow.

Check the account and schedule without redeeming anything:

```sh
docker compose run --rm codex-reset-watch node watch.mjs --once --dry-run
```

After verifying the account, set the following environment variables in Coolify,
or change these settings in `.env` beside `compose.yaml`:

```dotenv
REDEEM_ENABLED=true
REDEEM_BEFORE_MINUTES=30
```

Then start the service:

```sh
docker compose up -d
docker compose logs --tail=30 codex-reset-watch
```

In Coolify, run the device login and dry-run commands in the application terminal
with the same `/data` volume mounted. A container restart preserves the login and
retry keys. Keep the image's pinned Codex CLI version until an update is tested.

## Linux without a container

Install Node.js 22 or newer, run `npm ci` in this directory, and sign in using the
same Unix user and `CODEX_HOME` that the job will use. The watcher uses file-based
Codex login storage. For example:

```sh
npm ci
export CODEX_HOME="$HOME/.reset-reaper/codex"
export STATE_DIR="$HOME/.reset-reaper/state"
npx --no-install codex -c 'cli_auth_credentials_store="file"' login --device-auth
npm run check -- --dry-run
```

A systemd service can run:

```sh
node /absolute/path/to/reset-reaper/watch.mjs
```

Set its working directory to this project and set `CODEX_HOME` and `STATE_DIR` to
persistent, writable directories. Use `Restart=on-failure`, start after
`network-online.target`, and enable it at boot. Set `REDEEM_ENABLED=true` and
`REDEEM_BEFORE_MINUTES=30` in the service environment. To use a systemd timer
instead, run `node watch.mjs --once` every minute and leave redemption state in
the same `STATE_DIR` between invocations.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDEEM_ENABLED` | `false` | Must be exactly `true` to redeem; otherwise dry-run. |
| `REDEEM_BEFORE_MINUTES` | `30` | Start redemption attempts this many minutes before expiry. |
| `CHECK_INTERVAL_SECONDS` | `60` | Delay between checks; must be shorter than the lead time. |
| `DISPLAY_TIMEZONE` | `America/New_York` | Log formatting only. |
| `CODEX_HOME` | `/data/codex` in Docker | Persistent Codex account login. |
| `STATE_DIR` | `/data/state` in Docker | Persistent retry keys and last successful check. |

For a closer cutoff, set `REDEEM_BEFORE_MINUTES=10`. That gives roughly ten
one-minute checks under normal conditions, rather than the default thirty.
Redeeming restores eligible allowance; it does not accumulate another layer of
unused allowance, so waiting preserves time to use the current allowance.
This job only redeems resets; it does not start background coding work.

## Verification and operation

```sh
npm test
npm run check -- --dry-run
```

Tests cover timing boundaries, expired resets, Eastern daylight/standard time,
read-only dry runs, missing account data, exact-credit selection, durable retries,
and a lost response after redemption. Real redemption is intentionally not used
as a test because it would consume a banked reset.

Logs include account usage percentages, expiry times, dry-run decisions, and
redemption outcomes; credentials and raw account responses are not logged.
The health check fails after ten minutes without a successful account read.
Docker marks unhealthy containers but does not itself restart them solely for
that status; configure your VPS/Coolify monitoring to alert on an unhealthy job.
If sign-in stops working, repeat the device login against the existing volume.
To stop redemption, set `REDEEM_ENABLED=false` and redeploy, or stop the service.

To change settings, edit `.env` and run `docker compose up -d` again. To pause the
watcher, run `docker compose stop`; to resume it, run `docker compose up -d`.
Keep its named volume when upgrading so the login and retry keys survive.

## License

GPLv3; see [LICENSE](LICENSE). Reset Reaper is an independent project and is not
affiliated with OpenAI. The pinned Codex CLI dependency has its own license.
