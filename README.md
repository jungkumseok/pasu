# Pasu

**Your processes, kept alive. Your servers, in your pocket.**

Are you a solo dev running a handful of servers of your own? An API here, a bot there, a side
project or three that you'd really like to stay up?

You want a watchdog that restarts things when they crash, and tells you when they do. But you
don't want Kubernetes, a container platform, or a paid cloud dashboard just to keep a few commands
running.

**Pasu is a no-frills, minimal watchdog with just the conveniences you need.** Install it with one
command, open it in your browser, and point it at the commands you want kept alive.

- 🔐 **Usable security, built in.** Sign in with a password plus a code from any authenticator
  app (TOTP). Failed attempts are rate-limited and it serves HTTPS on its own, so it's built to be
  reached over the internet (see [Security notes](#security-notes) for how to lock it down further).
- 🌐 **Manage from anywhere you have a browser.** Add, edit, start, stop and restart processes
  from your laptop or your phone. No SSH, no config files.
- 🔁 **Crashes handled for you.** Processes marked *Keep running* restart automatically, with
  backoff so a crash loop doesn't hammer your server.
- 📧 **Email notifications to yourself.** Get an email when a process fails, with what happened
  and its last lines of output. Crash loops are grouped, so your inbox stays sane.
- 📜 **See what your processes are saying.** A live log viewer for each process's output.
- 📊 **See what they're using.** Live CPU and memory for each process and everything it spawns,
  with charts of the last 15 minutes.
- 🧘 **Restart Pasu, keep your services.** Processes keep running while Pasu restarts or
  upgrades, and it picks them back up when it starts.
- 🪶 **Featherweight.** One small Node package with two dependencies: no database, no build step,
  no containers. Starts on boot with a single `pasu service install`.
- 🏷️ **Built for more than one server.** Give each server a Pasu ID, and every email tells you
  which one it came from.

**Requirements:** Linux (Pasu tracks processes through `/proc`) and Node.js 20 or later.

## Quick start

```bash
npm install -g pasud
PASU_NAME="Pasu dev-box" pasu
```

The npm package is called `pasud`; the command it installs is `pasu`.

On first start it prints a one-time setup link:

```
[pasu] First-time setup: open this URL to enroll your authenticator:

    https://localhost:8443/#setup=3f2c…
```

Open it, scan the QR code, choose a password (at least 12 characters) and enter a code to finish.
Until that's done, the setup link is the only way to reach the setup page. Without the token,
whoever reached the port first could claim the instance.

Everything Pasu stores goes in `~/.local/share/pasu` (see [Data layout](#data-layout)).
For a permanent install, see [Start on boot](#start-on-boot-systemd) below.

## Naming instances

If you run Pasu on several servers, give each one a name **before enrolling** (the authenticator
app stores the label when you scan the QR code):

- `PASU_NAME` is the issuer shown in the authenticator app and in the page header and tab
  title. Defaults to `Pasu`.
- The account shown next to it is the hostname of `PASU_PUBLIC_URL`, or the machine's hostname
  if that's unset. You can override it with `PASU_ACCOUNT`.

For example, `PASU_NAME="Pasu prod-eu"` behind `https://ops.example.com/pasu` shows up as
**Pasu prod-eu (ops.example.com)**. To rename an instance you've already enrolled, change the
setting, run `reset-auth` (below) and enroll again.

## Configuration

All settings are environment variables. When Pasu is installed as a service, they're read from
`~/.config/pasu/pasu.env`.

| Variable | Default | |
|---|---|---|
| `PASU_NAME` | `Pasu` | Instance name (UI + authenticator issuer) |
| `PASU_PUBLIC_URL` | – | URL you open in the browser, e.g. `https://ops.example.com/pasu` |
| `PASU_ACCOUNT` | public URL host / hostname | Account label in the authenticator |
| `PASU_TLS` | `on` | `off` when behind a TLS-terminating proxy |
| `PASU_HOST` | `0.0.0.0` (TLS on), `127.0.0.1` (TLS off) | Listen address |
| `PASU_PORT` | `8443` | |
| `PASU_TRUST_PROXY` | `off` (TLS on), `on` (TLS off) | Honour `X-Forwarded-*` headers |
| `PASU_TLS_CERT` / `PASU_TLS_KEY` | self-signed | PEM paths, e.g. from Let's Encrypt |
| `PASU_DATA` | `~/.local/share/pasu` | All state lives here (`$XDG_DATA_HOME/pasu` if that's set) |
| `PASU_SESSION_DAYS` | `30` | Login session lifetime |
| `PASU_LOG_MAX_MB` | `5` | Per-process log size before rotation (one `.1` file is kept) |

With TLS on and no certificate configured, a self-signed one is generated in the data directory's `tls/`. Compare
the SHA-256 fingerprint Pasu prints with the one your browser shows.

## Behind nginx

Let nginx terminate TLS, and run Pasu on plain HTTP bound to loopback:

```ini
# ~/.config/pasu/pasu.env
PASU_TLS=off
PASU_PORT=8443
PASU_PUBLIC_URL=https://ops.example.com/pasu
```

```nginx
server {
    listen 443 ssl;
    server_name ops.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location /pasu/ {
        proxy_pass http://127.0.0.1:8443/;     # trailing slash strips the /pasu prefix
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-Host  $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    }
}
```

To serve it at the root of its own domain, use `location / { proxy_pass http://127.0.0.1:8443; … }`
and `PASU_PUBLIC_URL=https://pasu.example.com`.

Notes:

- The frontend uses only relative URLs, so any mount path works. The session cookie is scoped to
  the `PASU_PUBLIC_URL` path.
- No websockets or long-polling are used, so no special buffering or timeout settings are needed.
- Several instances on one host (different ports or paths) each get their own cookie name, so you
  can stay logged into all of them.
- Keep `PASU_HOST=127.0.0.1` in this mode. With TLS off, anything that can reach the port
  directly bypasses nginx, and could forge `X-Forwarded-*` headers.
- Login rate limits are per client address, taken from the **last** `X-Forwarded-For` entry (the
  one nginx appends). If another proxy or CDN sits in front of nginx, that's the CDN's address, so
  configure nginx's `real_ip` module to restore the client's address first.

## Start on boot (systemd)

```bash
pasu service install
```

Run this as your normal user, not as root (it calls `sudo` itself). It installs a systemd
**system** service, `/etc/systemd/system/pasu.service`, which starts at boot without anyone
logging in. The service runs as you, so managed processes do too. Once Pasu is up, it starts
every process marked **Keep running**.

On the first install it also creates `~/.config/pasu/pasu.env` (mode 0600). You can seed it
from the command line:

```bash
PASU_NAME="Pasu prod-eu" PASU_TLS=off PASU_PUBLIC_URL=https://ops.example.com/pasu \
  pasu service install
```

What the script records, and why:

- **The absolute paths of `node` and of Pasu itself.** With nvm, systemd can't find `node` on its
  own. If you switch Node versions in nvm later (which also moves global packages), install Pasu
  for the new version and run `pasu service install` again.
- **Your current `PATH`, written into `pasu.env`.** Managed commands like `npm start` or
  `python` then resolve the same way they do in your shell.
- **`KillMode=process`.** Stopping or restarting the Pasu service then leaves managed processes
  running. Without this, systemd would kill all of them along with Pasu.

Day to day:

```bash
sudo systemctl restart pasu      # after editing pasu.env; managed processes keep running
journalctl -u pasu -f            # Pasu's logs, including the first-time setup link
pasu service status
pasu service print               # show the unit file without installing
pasu service uninstall           # remove the service; managed processes keep running
```

To upgrade, run `npm install -g pasud@latest`, then `sudo systemctl restart pasu`.

On reboot, every process stops with the machine. When Pasu comes back up, it starts the ones
marked **Keep running** and leaves the others stopped.

## Data layout

```
~/.local/share/pasu/
  processes/<id>.json   process definitions (what you edit in the UI)
  run/<id>.json         runtime state: pid, start time, "manually stopped" flag
  logs/<id>.log[.1]     stdout+stderr of each process
  auth.json             TOTP secret and password hash (mode 0600)
  sessions.json         hashed session tokens
  throttle.json         failed-code lockout state, kept across restarts
  settings.json         Pasu ID and email settings, including the SMTP password (mode 0600)
  tls/                  generated certificate
```

You can edit `processes/*.json` by hand. Changes are picked up on the next start/restart of that process.

## How supervision works

- **Commands** run via `bash -c` in their own session and process group, with the configured
  environment added on top of Pasu's. A command must stay in the foreground: if it
  daemonizes itself, Pasu sees it exit.
- **Processes outlive Pasu.** Each is tracked by PID plus kernel start time, so restarting
  or upgrading Pasu doesn't touch your services; they're re-adopted on startup. A recycled
  PID is never mistaken for one of yours, and never signalled.
- **Stop** sends the stop signal (default `SIGTERM`) to the whole process group, waits for the grace
  period (default 10s), then sends `SIGKILL`.
- **Keep running** (auto-start) starts the process when Pasu starts, and restarts it whenever
  it exits. Restarts use exponential backoff (1s, 2s, 4s, … up to 60s), which resets once the process
  stays up for 30s. Pressing *Stop* pauses this until you press *Start* again, and the pause
  survives Pasu restarts.
- **Logs** are written by the process directly to its log file, so nothing is lost while
  Pasu is down.
- **Resources** are sampled from `/proc` every 2s: CPU (100% = one core) and resident memory, summed
  over the process and everything it spawned (they share its session). Each row shows the latest
  figures; the *Resources* view adds charts of the last 15 minutes and a per-process breakdown.
  History is kept in memory only, so it starts over when Pasu restarts.

## Email notifications

Under **Settings**, turn on *Enable email notifications* and enter the receiver address and your
SMTP server, port, username and password. *Send test email* checks them before you save.

Pasu then emails the receiver when a process fails:

- it exits without being asked to, or is killed (a command without *Keep running* that exits with
  code 0 has simply finished, and isn't reported);
- an automatic start or restart fails;
- it exited while Pasu itself was down (but not after a reboot, when every process stopped).

The email shows what happened, what Pasu does next (for example, restarting in 4s), the command,
and the last 40 lines of output. Its subject starts with the **Pasu ID**, and it names the server's
hostname, so with several servers you can tell at a glance which one wrote.

The Pasu ID is set under *Settings → General*; it defaults to the domain of `PASU_PUBLIC_URL`, or
the machine's hostname. When the server has a public IP on one of its network interfaces (as most
VPSs do), the email shows that too. Behind NAT it's simply left out: Pasu never asks an outside
service for it. A crash loop doesn't flood your inbox: the first failure is sent
right away, and further failures of the same process within 10 minutes are grouped into one summary.

Each process can opt out with *Email notifications* in its own settings; it's on by default.

Port 465 uses TLS from the start; any other port must offer STARTTLS, so the password is never
sent in the clear. The exception is a relay on this machine (`localhost`), which may also skip the
login. The SMTP password is stored in `settings.json` (mode 0600) and is never sent back to the
browser.

## Forgot your password?

```bash
pasu set-password        # with the same PASU_DATA as the service, if you changed it
```

It asks for the new password twice, without echoing it (or reads one line from stdin when piped).
It takes effect immediately; no restart is needed. Existing sessions stay valid.

## Lost your authenticator?

```bash
pasu reset-auth          # with the same PASU_DATA as the service, if you changed it
sudo systemctl restart pasu   # prints a new setup link to the journal
```

This deletes the TOTP secret, the password and all sessions. Managed processes are not affected.

## Security notes

Anyone who logs in can run arbitrary commands as your user, so treat access accordingly.

The safest setup is not to expose it to the internet at all: reach it over a VPN (Tailscale,
WireGuard), or restrict it to known addresses in nginx. When it is exposed:

- **Sign-in takes a password and a TOTP code.** The password is hashed with scrypt. A 6-digit code
  alone is only about 20 bits, which a patient attacker could eventually guess.
- **Failures are limited per client address** (IPv6 grouped by /64): after 5 failures, each further
  attempt is locked out for 1s, 2s, 4s … up to 1h, and each address gets one attempt at a time.
  Someone guessing passwords locks out only themselves, never you.
- **A correct password with a wrong code** also counts against a global limit (3 free, then the
  same backoff). This protects the code even from many addresses, and is saved in
  `throttle.json`, so restarting Pasu doesn't reset it. Only someone who knows your password
  can trigger it; if that happens, change the password.
- TOTP codes are single-use (a code can't be replayed), with ±30s clock tolerance.
- Sessions use an `HttpOnly; Secure; SameSite=Strict` cookie. The API accepts only JSON objects, and
  checks the `Origin` header on writes. A strict CSP is set and no inline scripts are used. HSTS is
  sent on HTTPS requests.
- Anyone who gets in runs commands as Pasu's user. If you can, run it under a dedicated
  account that doesn't have sudo.

## Commands

```
pasu                    start Pasu
pasu set-password       set or change the login password
pasu reset-auth         remove the authenticator, password and sessions, to enroll again
pasu service <action>   install, uninstall, status or print the systemd service
pasu help | version
```

## Running from source

```bash
git clone https://github.com/jungkumseok/pasu.git && cd pasu
npm install
npm start                       # same as `pasu`; commands go after `--`, e.g. npm start -- set-password
npm test
```

Versions before the npm package kept their data in `data/` inside the checkout. Pasu now refuses
to start while that folder exists and `~/.local/share/pasu` doesn't, and tells you how to move it
(or keep using it with `PASU_DATA`).

## License

MIT
