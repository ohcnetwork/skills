# care-loopd.nix — the same unit as care-loopd.service, declared natively for NixOS.
#
# Read care-loopd.service first: it is the reference, and every setting here means what it means
# there. This file exists for two reasons, and only two.
#
#   1. Copying a unit into /etc/systemd/system on NixOS puts it OUTSIDE the generation. It survives
#      no rebuild, appears in no rollback, and is invisible to anyone reading configuration.nix to
#      find out what the box runs.
#   2. Two settings genuinely differ on NixOS, and both fail late rather than loudly:
#        - PATH. There is no /usr/bin. The children shell out to `git` and spawn `opencode` (the SDK
#          launches a bare `opencode` from PATH), so both must come from packages — and `opencode`
#          must come from nixpkgs, not the upstream install script, which drops a dynamically-linked
#          ELF that cannot run here without an FHS shim.
#        - The secrets file must not be a store path. /nix/store is world-readable, so a token
#          written from a Nix expression is a token published to every user on the machine.
#
#   imports = [ /srv/skills/care-loop/deploy/care-loopd.nix ];
#   services.care-loopd = {
#     enable = true;
#     src = "/srv/skills/care-loop";
#     mainRepo = "/srv/care_fe";
#     host = "0.0.0.0";          # LAN now; loopback once Tailscale fronts it
#     openFirewall = true;
#   };

{ config, lib, pkgs, ... }:

let
  cfg = config.services.care-loopd;
  inherit (lib) mkIf mkOption mkEnableOption types;
in
{
  options.services.care-loopd = {
    enable = mkEnableOption "the care-loop orchestration service";

    src = mkOption {
      type = types.str;
      description = ''
        The care-loop checkout (the directory containing orchestrator/ and web/).

        A plain directory rather than a Nix package on purpose: the checkout is updated by pulling and
        there is no build to reproduce — `node:sqlite` is built into Node, so no native module
        compiles. Packaging it would mean a rebuild per commit for no isolation gain.
      '';
      example = "/srv/skills/care-loop";
    };

    mainRepo = mkOption {
      type = types.str;
      description = "The care_fe checkout worktrees branch from. A real clone, with a remote.";
      example = "/srv/care_fe";
    };

    user = mkOption {
      type = types.str;
      default = "care-loopd";
      description = "Service user. Owns the runs directory, the worktrees, and the bot's git identity.";
    };

    port = mkOption {
      type = types.port;
      default = 3142;
      description = "One port for the API and the web app — same origin, so the session cookie needs no CORS.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Loopback by default: the service has NO authentication, the login is an unverified claim, and
        the trust boundary is the network. `0.0.0.0` puts it on the LAN, where anything on that
        network can act as anyone — the accepted trade until Tailscale fronts it.
      '';
    };

    concurrency = mkOption {
      type = types.ints.positive;
      default = 2;
      description = ''
        Concurrent runs. Each is a worktree plus an opencode session plus Copilot credits. Runs parked
        at a human gate do not count: they suspend and release the slot.
      '';
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/care-loopd";
      description = "Runs, worktrees, loops.db, backups. Must be under /var/lib — StateDirectory is its basename.";
    };

    environmentFile = mkOption {
      type = types.str;
      default = "/var/lib/care-loopd/.env";
      description = ''
        GitHub token, opencode provider key, Jira creds. Place it out of band — by hand, or with
        agenix/sops-nix — and never with `pkgs.writeText`. See the note at the top of this file.
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open `port` to the LAN. Turn off once Tailscale fronts the service.";
    };

    extraPackages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = "Extra tools on the PATH the children inherit — anything the repo's own test or CI-fix step shells out to.";
    };
  };

  config = mkIf cfg.enable {
    # Caught at nixos-rebuild rather than at 3am. Both are silent-wrong rather than loud-wrong.
    assertions = [
      {
        assertion = lib.hasPrefix "/var/lib/" cfg.stateDir;
        message = "services.care-loopd.stateDir must be under /var/lib (StateDirectory is derived from its basename, and the two disagreeing is silent)";
      }
      {
        assertion = !(lib.hasPrefix "/nix/store" cfg.environmentFile);
        message = "services.care-loopd.environmentFile must not be a Nix store path — the store is world-readable, so the GitHub token would be readable by every user on the box.";
      }
    ];

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      home = cfg.stateDir;
      createHome = true;
    };
    users.groups.${cfg.user} = { };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.care-loopd = {
      description = "care-loop orchestration service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # Reason (2) above. The SERVICE never calls git or opencode; the children it spawns do, and they
      # inherit this PATH — so a miss here surfaces at the first worktree or the first model call
      # rather than at startup.
      path = [ pkgs.nodejs_22 pkgs.git pkgs.openssh pkgs.opencode ] ++ cfg.extraPackages;

      environment = {
        CARE_MAIN_REPO = cfg.mainRepo;
        CARE_WORKTREE_ROOT = "${cfg.stateDir}/worktrees";
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

        # `node <launcher>` rather than executing the launcher: independent of the checkout's exec bit
        # and of /usr/bin/env, and it pins the interpreter to the nodejs this unit puts on PATH.
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

        # See care-loopd.service — the default kills every child on restart, aborting every
        # teammate's run and leaving a stale lockfile behind on every deploy.
        KillMode = "process";
        TimeoutStopSec = 30;
        Restart = "on-failure";
        RestartSec = 5;

        StateDirectory = baseNameOf cfg.stateDir;
        StateDirectoryMode = "0750";

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "full";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        RestrictSUIDSGID = true;
        ReadWritePaths = [ cfg.stateDir cfg.mainRepo ];
      };
    };

    # The CLI with this machine's PATH and working directory already set, so `reindex` and `status`
    # do not need any of that reconstructed by hand.
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "care-loopd-ctl" ''
        set -euo pipefail
        export PATH=${lib.makeBinPath [ pkgs.nodejs_22 pkgs.git pkgs.opencode ]}:$PATH
        cd ${cfg.src}/orchestrator
        exec ${pkgs.nodejs_22}/bin/node ${cfg.src}/orchestrator/bin/care-loopd.mjs "$@"
      '')
    ];
  };
}
