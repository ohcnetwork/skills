# care-loopd.nix — the loop-service as a NixOS module ([[PLAN-loop-service]] §11 step 6).
#
# Declared, not dropped into /etc/systemd/system. On NixOS a hand-written unit plus `systemctl enable`
# is not merely unidiomatic — it is outside the generation, so it survives no rebuild and appears in
# no rollback. Import this from configuration.nix and set `services.care-loopd.*`.
#
#   imports = [ /srv/skills/care-loop/deploy/care-loopd.nix ];
#   services.care-loopd = {
#     enable = true;
#     openFirewall = true;          # LAN now; drop this when Tailscale fronts it
#     host = "0.0.0.0";
#   };
#
# Three NixOS-specific things this gets right, and which a ported systemd unit would get wrong:
#
#   1. `path` is explicit. There is no /usr/bin, and the service shells out to `git` and spawns
#      `opencode` (the SDK launches a bare `opencode` from PATH — see opencode-runner.ts). A unit
#      without these fails at the first worktree or the first model call, not at startup.
#   2. `opencode` comes from nixpkgs, NOT from the upstream install script. That script drops a
#      dynamically-linked ELF in ~/.opencode/bin, which cannot run on NixOS without an FHS shim.
#   3. The secrets file lives OUTSIDE the Nix store. Everything in /nix/store is world-readable, so a
#      GitHub token committed into a Nix expression is a token published to every user on the box.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.care-loopd;
  inherit (lib) mkIf mkOption mkEnableOption types;
in
{
  options.services.care-loopd = {
    enable = mkEnableOption "the care-loop orchestration service";

    src = mkOption {
      type = types.path;
      description = ''
        The care-loop checkout (the directory containing orchestrator/ and web/).

        A plain directory rather than a Nix package on purpose: the loop edits the repo it is pointed
        at and the checkout is updated by pulling, so packaging it would mean a rebuild per commit
        for no isolation gain. `npm ci` in orchestrator/ and `npm run build` in web/ are the operator's
        job — there is no native module to compile, since `node:sqlite` is built into Node.
      '';
      example = "/srv/skills/care-loop";
    };

    user = mkOption {
      type = types.str;
      default = "care-loopd";
      description = "Service user. Owns the runs directory, the worktrees, and the bot's git identity.";
    };

    port = mkOption {
      type = types.port;
      default = 3142;
      description = "HTTP port for the API and the web app — one origin, so the session cookie is plain same-origin.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Bind address. Loopback by default because the service has NO authentication — the login is an
        unverified claim and the trust boundary is the network (§6). `0.0.0.0` puts it on the LAN,
        where anything on that network can act as anyone; that is the accepted trade while Tailscale
        is not yet in front, and it is the reason to put Tailscale in front.
      '';
    };

    concurrency = mkOption {
      type = types.ints.positive;
      default = 2;
      description = ''
        Concurrent runs. Each is a worktree plus an opencode session plus Copilot credits, so this is
        a real resource limit. Runs parked at a human gate do NOT count against it — they suspend and
        release the slot (§7).
      '';
    };

    mainRepo = mkOption {
      type = types.str;
      description = "The care_fe checkout worktrees branch from. Must be a real clone with a remote.";
      example = "/srv/care_fe";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/care-loopd";
      description = ''
        Run directories, worktrees, loops.db, and its backups. Must live under /var/lib — systemd's
        `StateDirectory` is derived from its basename, which is what creates it with the right owner
        and mode before the service starts.
      '';
    };

    environmentFile = mkOption {
      type = types.path;
      default = "/var/lib/care-loopd/.env";
      description = ''
        GitHub token, the opencode/Copilot provider key, Jira credentials (§9). One file on the box,
        bot-owned, `chmod 600`, children inherit it.

        It must NOT be a path in the Nix store, and therefore must not be written as a Nix string
        literal or `pkgs.writeText`: the store is world-readable, so that publishes the token to every
        user on the machine. Place it by hand, or with a secrets tool (agenix / sops-nix).
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open `port` to the LAN. Leave off once Tailscale fronts the service.";
    };

    extraPackages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = "Extra tools on the service PATH — a formatter or test runner the repo's CI-fix step shells out to.";
    };
  };

  config = mkIf cfg.enable {
    # Caught at `nixos-rebuild` rather than at 3am. Both of these are silent-wrong rather than
    # loud-wrong: a stateDir outside /var/lib gets a StateDirectory systemd creates somewhere else,
    # and a store-path secrets file is a GitHub token published to every user on the machine.
    assertions = [
      {
        assertion = lib.hasPrefix "/var/lib/" cfg.stateDir;
        message = "services.care-loopd.stateDir must be under /var/lib (systemd StateDirectory is derived from its basename)";
      }
      {
        assertion = !(lib.hasPrefix "/nix/store" (toString cfg.environmentFile));
        message = "services.care-loopd.environmentFile must not be a Nix store path — the store is world-readable, so the GitHub token would be readable by every user on the box. Place the file out of band (or use agenix/sops-nix).";
      }
    ];

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      home = cfg.stateDir;
      createHome = true;
      # The loop pushes branches and opens PRs. Auth is the token in environmentFile, but git still
      # needs a writable HOME for its config and for the credential helper's scratch space.
    };
    users.groups.${cfg.user} = { };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.care-loopd = {
      description = "care-loop orchestration service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # No /usr/bin on NixOS. `git` is shelled out to for every worktree, and the opencode SDK
      # launches a bare `opencode` from PATH for every judgment spawn — both fail at first use rather
      # than at startup if they are missing, which is the worst time to find out.
      path = [
        pkgs.nodejs_22
        pkgs.git
        pkgs.openssh
        pkgs.opencode
      ] ++ cfg.extraPackages;

      environment = {
        # Properties of the MACHINE, not of a run: the supervisor passes seed flags, not filesystem
        # layout. Without these the loop derives `~/Desktop/...`, which is a sensible guess on a
        # laptop and nonsense on a headless box.
        CARE_MAIN_REPO = cfg.mainRepo;
        CARE_WORKTREE_ROOT = "${cfg.stateDir}/worktrees";
        # The end-of-run doctor opens self-improvement PRs against the skills repo. That stays a
        # deliberate local action, never a side effect of a teammate's run (§5).
        CARE_DOCTOR = "0";
        HOME = cfg.stateDir;
        NODE_ENV = "production";
      };

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.user;
        WorkingDirectory = "${cfg.src}/orchestrator";
        EnvironmentFile = cfg.environmentFile;

        # `node <launcher>` rather than executing the launcher directly: it depends on neither the
        # checkout's exec bit surviving a clone nor on /usr/bin/env, and it pins the interpreter to
        # the same nodejs this unit puts on PATH. The launcher registers tsx from its OWN node_modules
        # (resolved relative to the file, not the cwd), so no build step is needed.
        ExecStart = "${pkgs.nodejs_22}/bin/node " + lib.escapeShellArgs [
          "${cfg.src}/orchestrator/bin/care-loopd.mjs"
          "serve"
          "--supervise"
          "--port" (toString cfg.port)
          "--host" cfg.host
          "--concurrency" (toString cfg.concurrency)
          "--db" "${cfg.stateDir}/runs/loops.db"
          "--runs-dir" "${cfg.stateDir}/runs"
          "--main" cfg.mainRepo
        ];

        # SIGTERM stops the supervisor CLAIMING but deliberately does not kill running children: they
        # are independent processes holding their own locks and journals, and a restart aborting every
        # teammate's run would be far worse than a few unsupervised minutes. `reconcile` re-adopts
        # them at boot. KillMode=process is what stops systemd from undoing that by killing the whole
        # cgroup, which would leave stale lockfiles and no run.end on every deploy.
        KillMode = "process";
        TimeoutStopSec = 30;

        Restart = "on-failure";
        RestartSec = 5;

        # Derived from stateDir rather than hardcoded, so the two cannot disagree — systemd would
        # otherwise happily create /var/lib/care-loopd while the service wrote somewhere else.
        StateDirectory = baseNameOf cfg.stateDir;
        StateDirectoryMode = "0750";

        # Hardening, kept to what does not break the workload. The service forks children that run
        # git and a model client, so ProtectSystem=strict plus a ReadWritePaths list is the honest
        # ceiling here — NoNewPrivileges and a private /tmp are free, and PrivateNetwork obviously is
        # not.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "full";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        ReadWritePaths = [ cfg.stateDir cfg.mainRepo ];
      };
    };

    # `care-loopd reindex` rebuilds the run tables from the journals. It cannot rebuild `queue`,
    # `gate_asks`, `users`, or `sessions` — those are service-owned and have no journal behind them,
    # which is why the service snapshots the db (VACUUM INTO) on boot and every six hours. Surfacing
    # the command here means the operator does not have to go looking for it.
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "care-loopd-ctl" ''
        set -euo pipefail
        export PATH=${lib.makeBinPath [ pkgs.nodejs_22 pkgs.git pkgs.opencode ]}:$PATH
        cd ${cfg.src}/orchestrator
        exec ${cfg.src}/orchestrator/bin/care-loopd.mjs "$@"
      '')
    ];
  };
}
