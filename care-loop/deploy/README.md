# Deploying care-loopd on NixOS

Step 6 of [[PLAN-loop-service]]. The service is always on: it holds the queue, supervises children,
serves the API and the web app, and is where teammates answer plan gates.

## Why a module and not a unit file

On NixOS a hand-written `/etc/systemd/system/care-loopd.service` plus `systemctl enable` is outside
the generation. It survives no rebuild, appears in no rollback, and is invisible to anyone reading
`configuration.nix` to find out what the box runs. `care-loopd.nix` is a normal NixOS module —
import it and set options.

Three things it gets right that a ported unit gets wrong:

1. **`path` is explicit.** There is no `/usr/bin` here. The loop shells out to `git` for every
   worktree, and the opencode SDK launches a bare `opencode` from `PATH` for every judgment spawn
   (`opencode-runner.ts` → `@opencode-ai/sdk` → `cross-spawn("opencode", …)`). Both fail at *first
   use* rather than at startup, which is the worst time to discover them.
2. **`opencode` comes from nixpkgs.** The upstream install script drops a dynamically-linked ELF in
   `~/.opencode/bin`, which will not run on NixOS without an FHS shim. If `pkgs.opencode` is not in
   your channel yet, pin it with an overlay — do not fall back to the install script.
3. **The secrets file is outside the Nix store.** `/nix/store` is world-readable, so a GitHub token
   written from a Nix expression is a token published to every user on the machine. The module
   asserts against a store path for `environmentFile`.

## Setup

```nix
# configuration.nix
imports = [ /srv/skills/care-loop/deploy/care-loopd.nix ];

services.care-loopd = {
  enable      = true;
  src         = "/srv/skills/care-loop";
  mainRepo    = "/srv/care_fe";
  host        = "0.0.0.0";   # LAN for now — see "Exposure" below
  openFirewall = true;
  concurrency = 2;
};
```

Then, out of band:

```bash
# the checkout the module points at
sudo git clone https://github.com/<you>/skills /srv/skills
sudo git clone https://github.com/ohcnetwork/care_fe /srv/care_fe
sudo chown -R care-loopd:care-loopd /srv/care_fe

# dependencies + the built web app. No native modules to compile — node:sqlite is built into Node.
cd /srv/skills/care-loop/orchestrator && sudo -u care-loopd npm ci
cd /srv/skills/care-loop/web         && sudo -u care-loopd npm ci && sudo -u care-loopd npm run build

# secrets — 0600, owned by the service user, NEVER in the Nix store
sudo install -m600 -o care-loopd -g care-loopd \
  /srv/skills/care-loop/deploy/env.example /var/lib/care-loopd/.env
sudo -e /var/lib/care-loopd/.env

# the database the service refuses to start without
sudo -u care-loopd care-loopd-ctl reindex --runs-dir /var/lib/care-loopd/runs
```

`care-loopd-ctl` is installed by the module — the CLI with the right `PATH` and working directory
already set, so `reindex`, `status`, and a manual `run` do not need any of that reconstructed by
hand.

## Exposure

**Today: LAN.** `host = "0.0.0.0"` and `openFirewall = true`. This is plain HTTP with no
authentication — the login is an unverified claim, and anything on the office network can act as
anyone. That is the accepted trade to unblock the team, and it is precisely the reason to do the next
part.

**Next: Tailscale.** Real HTTPS, no public exposure, and it works from outside the office.

```nix
services.tailscale.enable = true;

services.care-loopd = {
  host         = "127.0.0.1";   # back to loopback
  openFirewall = false;         # nothing on the LAN port any more
};
```

```bash
sudo tailscale up
sudo tailscale serve --bg 3142
```

`tailscale serve` terminates TLS, so flip `--secure-cookies` on at the same time — the session cookie
should be marked `Secure` the moment there is TLS in front of it. It is wired as a `serve` flag; add
it to the module's `ExecStart` when you make the switch.

## Operating it

```bash
systemctl status care-loopd
journalctl -u care-loopd -f
```

**Restarts do not kill running loops.** `KillMode=process` is deliberate: children are independent
processes holding their own locks and journals, and a deploy aborting every teammate's run would be
far worse than a few unsupervised minutes. The supervisor re-adopts live children at boot and returns
dead ones to `pending` (§4). Without `KillMode=process`, systemd would kill the whole cgroup and
leave a stale lockfile and no `run.end` on every single deploy.

**Backups matter more than they look.** `reindex` rebuilds the run tables from the journals, but
`queue`, `gate_asks`, `users`, and `sessions` have no journal behind them. Losing `gate_asks` means
someone re-approves a plan; losing `queue` means re-submitting a request. The service snapshots the
database (`VACUUM INTO`) at boot and every six hours into `<stateDir>/runs/backups`, keeping seven.

**A run parked at a gate holds nothing.** It suspends after ~10 minutes, exits, and releases its
concurrency slot; the answer puts it back in the queue (§7). So a plan left unanswered overnight
costs nothing but the ask's 7-day expiry — and the header badge exists so it does not get that far.

## Updating

```bash
cd /srv/skills && sudo -u care-loopd git pull
cd care-loop/orchestrator && sudo -u care-loopd npm ci
cd ../web && sudo -u care-loopd npm ci && sudo -u care-loopd npm run build
sudo systemctl restart care-loopd
```

A schema bump is applied on the next open — migrations are keyed off `PRAGMA user_version` and are
idempotent. Take a backup first anyway; the copy is a single file.
