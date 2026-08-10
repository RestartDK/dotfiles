{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  hasScattererInput = dotfilesInputs ? scatterer-src;
  herdrPackage = dotfilesInputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
  herdrLauncher = pkgs.writeShellApplication {
    name = "herdr";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/herdr"
      pending="$state_dir/pending-scatterer-plugin"
      refresh_log="$state_dir/scatterer-plugin-refresh.log"
      real_herdr="${herdrPackage}/bin/herdr"

      refresh_scatterer() {
        local desired current
        IFS= read -r desired < "$pending" || return 1
        [[ -n "$desired" && -d "$desired" ]] || return 1
        "$real_herdr" plugin link "$desired" >/dev/null 2>&1 || return 1

        current=""
        IFS= read -r current < "$pending" || true
        if [[ "$current" == "$desired" ]]; then
          rm -f "$pending"
        fi
      }

      if [[ -r "$pending" ]] && ! refresh_scatterer; then
        mkdir -p "$state_dir"
        (
          for _ in $(seq 1 60); do
            sleep 1
            if refresh_scatterer; then
              exit 0
            fi
          done
          printf 'Timed out waiting to refresh Scatterer registration.\n'
        ) </dev/null >> "$refresh_log" 2>&1 &
      fi

      exec "$real_herdr" "$@"
    '';
  };
  tuicrPackage = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.tuicr;
  scattererPackage =
    if hasScattererInput then
      pkgs.callPackage ../../../packages/scatterer.nix {
        src = dotfilesInputs.scatterer-src;
      }
    else
      null;
  scattererPluginRoot =
    if hasScattererInput then "${scattererPackage}/share/herdr/plugins/scatterer" else null;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
  dir = path: {
    source = link path;
    recursive = false;
    force = true;
  };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.terminalTools {
        home.packages = [ tuicrPackage ];
        xdg.configFile = {
          "btop/btop.conf" = file "config/btop/btop.conf";
          "thefuck/settings.py" = file "config/thefuck/settings.py";
          "tuicr/config.toml" = file "config/tuicr/config.toml";
        };
      })

      (lib.mkIf cfg.groups.ghostty {
        xdg.configFile."ghostty" = dir "config/ghostty";
      })

      (lib.mkIf cfg.groups.multiplexer (
        lib.mkMerge [
          {
            home.packages = [ herdrLauncher ];
            xdg.configFile."herdr/config.toml" = file "config/herdr/config.toml";
          }

          (lib.mkIf hasScattererInput {
            home.packages = [ scattererPackage ];

            home.activation.linkScattererHerdrPlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              # A running server can use the previous Nix generation while a new
              # Herdr version is installed. A newer CLI cannot update an older
              # server's plugin registry, so defer the immutable Scatterer link
              # instead of failing Home Manager activation. The Herdr launcher
              # applies the pending link after the server stops or upgrades.
              state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/herdr"
              pending="$state_dir/pending-scatterer-plugin"
              registry="''${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json"

              plugin_list="$(
                "${herdrPackage}/bin/herdr" plugin list --json 2>/dev/null || true
              )"
              existing_manifest="$(
                printf '%s' "$plugin_list" \
                  | ${pkgs.jq}/bin/jq -r '.result.plugins[]? | select(.plugin_id == "daniel.scatterer") | .manifest_path // empty' 2>/dev/null \
                  | ${pkgs.coreutils}/bin/head -n 1 \
                  || true
              )"

              # If protocol negotiation failed, read the persisted registry only
              # to preserve an explicit development checkout. Herdr still owns all
              # registry writes through `plugin link`.
              if [ -z "$existing_manifest" ] && [ -r "$registry" ]; then
                existing_manifest="$(
                  ${pkgs.jq}/bin/jq -r '.[]? | select(.plugin_id == "daniel.scatterer") | .manifest_path // empty' "$registry" 2>/dev/null \
                    | ${pkgs.coreutils}/bin/head -n 1 \
                    || true
                )"
              fi

              if [ -n "$existing_manifest" ] && [[ "$existing_manifest" != /nix/store/* ]]; then
                echo "Preserving local Scatterer plugin link at $existing_manifest"
                ${pkgs.coreutils}/bin/rm -f "$pending"
              elif run "${herdrPackage}/bin/herdr" plugin link "${scattererPluginRoot}" >/dev/null 2>&1; then
                ${pkgs.coreutils}/bin/rm -f "$pending"
              else
                ${pkgs.coreutils}/bin/mkdir -p "$state_dir"
                pending_tmp="$pending.tmp.$$"
                printf '%s\n' "${scattererPluginRoot}" > "$pending_tmp"
                ${pkgs.coreutils}/bin/mv -f "$pending_tmp" "$pending"
                echo "Deferring Scatterer registration until Herdr restarts."
              fi
            '';
          })
        ]
      ))
    ]
  );
}
