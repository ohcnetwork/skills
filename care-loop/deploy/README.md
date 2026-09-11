# Deploying care-loopd

## What you are deploying

**One process.** That is the whole shape, and it is worth being concrete because the config files look
bigger than the job:

```
care-loopd serve --supervise            ← the only long-lived process
├── GET/POST /api/*                     ← the API
├── static web/dist                     ← the web app, same origin, same port
└── supervisor
    └── spawns: care-loopd run --gate service --repo … --branch … --run-dir …
```

The children are the same binary you run by hand at a terminal, given the same flags a person would
type. There is no second daemon, no worker pool, and no queue broker — the queue is a table in the
same SQLite file everything else uses.

**The children inherit the service's environment.** This is the one non-obvious consequence, and it
explains why the unit mentions tools the service never calls: the *service* does not run `git` or
spawn `opencode`, but every child does, and they get their `PATH`, their credentials, and their
sandbox from the parent.

So a deployment is three decisions:

| | |
|---|---|
| **One command** | `care-loopd serve --supervise --port … --db … --runs-dir … --main …` |
| **One env file** | GitHub token, opencode provider key, Jira creds — `chmod 600` (see `env.example`) |
| **One port** | API and web app share it, which is why the session cookie needs no CORS |

Everything below is per-platform glue over exactly that.

## Pick your platform

- **Any systemd distro** — `care-loopd.service`. Adjust four paths, `cp` to
  `/etc/systemd/system/`, `systemctl enable --now care-loopd`.
- **NixOS** — `care-loopd.nix`. Do *not* copy the unit file; on NixOS that lands outside the
  generation, so it survives no rebuild and appears in no rollback.
- **macOS / anything else** — there is no file for it, because there does not need to be. Keep the one
  command alive with whatever the platform uses (a launchd `.plist`, `supervisord`, a `tmux` session
  while you are trying it out) and give it the env file. The unit file is the reference for what to
  set.

### The two NixOS-specific differences

Everything else in `care-loopd.nix` means what it means in `care-loopd.service`. These two do not:

1. **`PATH` must be built from packages.** There is no `/usr/bin`. And `opencode` must come from
   nixpkgs — the upstream install script drops a dynamically-linked ELF in `~/.opencode/bin` that
   cannot run on NixOS without an FHS shim. If `pkgs.opencode` is not in your channel yet, pin it with
   an overlay rather than falling back to the script.
2. **The secrets file must not be a store path.** `/nix/store` is world-readable, so a token written
   from a Nix expression is a token published to every user on the box. The module asserts against
   this rather than trusting the reader to know it.

## Setup

```bash
sudo git clone https://github.com/<you>/skills /srv/skills
sudo git clone https://github.com/ohcnetwork/care_fe /srv/care_fe
sudo chown -R care-loopd:care-loopd /srv/care_fe

# deps + the built web app. No native modules — node:sqlite is built into Node.
cd /srv/skills/care-loop/orchestrator && sudo -u care-loopd npm ci
cd /srv/skills/care-loop/web         && sudo -u care-loopd npm ci && sudo -u care-loopd npm run build

# secrets: 0600, owned by the service user
sudo install -m600 -o care-loopd -g care-loopd \
  /srv/skills/care-loop/deploy/env.example /var/lib/care-loopd/.env
sudo -e /var/lib/care-loopd/.env

# the database the service refuses to start without (creates the directory too)
sudo -u care-loopd care-loopd reindex --runs-dir /var/lib/care-loopd/runs
```

On NixOS the module installs `care-loopd-ctl`, which is the CLI with the right `PATH` and working
directory already set — use it in place of `care-loopd` above.

## Exposure

**Today: LAN.** `--host 0.0.0.0`, firewall port open. Plain HTTP with no authentication — the login
is an unverified claim and anything on the office network can act as anyone. That is the accepted
trade to unblock the team, and it is exactly why the next part exists.

**Next: Tailscale.** Real HTTPS, nothing public, works from outside the office.

```bash
sudo tailscale up
sudo tailscale serve --bg 3142
```

Then set `--host 127.0.0.1`, close the firewall port, and add `--secure-cookies` — the session cookie
should be marked `Secure` the moment TLS is in front of it.

## Operating it

```bash
systemctl status care-loopd
journalctl -u care-loopd -f
```

**Restarts do not kill running loops.** `KillMode=process` is deliberate and is the single most
important line in either file. The systemd default kills the whole cgroup, so a restart would abort
every teammate's run and leave a stale lockfile and no `run.end` behind — on every deploy. Children
are independent processes holding their own locks and journals; the supervisor re-adopts the
survivors at boot and returns the dead ones to `pending`.

**Backups matter more than they look.** `reindex` rebuilds the run tables from the journals, but
`queue`, `gate_asks`, `users`, and `sessions` have no journal behind them. Losing `gate_asks` means
someone re-approves a plan; losing `queue` means re-submitting a request. The service snapshots the
database (`VACUUM INTO`) at boot and every six hours into `<runs-dir>/backups`, keeping seven.

**A run parked at a gate holds nothing.** It suspends after ~10 minutes, exits, and releases its
concurrency slot; the answer puts it back in the queue. A plan left unanswered overnight costs
nothing but the ask's 7-day expiry — and the header badge exists so it does not get that far.

## Updating

```bash
cd /srv/skills && sudo -u care-loopd git pull
cd care-loop/orchestrator && sudo -u care-loopd npm ci
cd ../web && sudo -u care-loopd npm ci && sudo -u care-loopd npm run build
sudo systemctl restart care-loopd
```

Schema bumps apply on the next open — migrations key off `PRAGMA user_version` and are idempotent.
Take a backup first anyway; it is a single file.
