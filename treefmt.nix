{ lib, pkgs, ... }:

let
  oxlintIncludes = [
    "packages/pi-artifacts/src/*.ts"
    "config/amp/plugins/*.ts"
    "config/karabiner/src/*.ts"
    "config/opencode/plugins/*.js"
    "config/pi/agent/lib/*.ts"
    "tests/pi-profiled/*.ts"
    "tests/agent-profiles/*.ts"
    "config/pi/agent/extensions/*.ts"
    "config/pi/agent/extensions/**/*.mjs"
    "config/pi/agent/extensions/**/*.ts"
  ];
  oxfmtIncludes = oxlintIncludes ++ [
    "packages/pi-artifacts/package.json"
    "packages/pi-artifacts/tsconfig.json"
    ".oxfmtrc.json"
    ".oxlintrc.json"
    "config/karabiner/package.json"
    "config/opencode/package.json"
    "config/pi/agent/extensions/*/package.json"
  ];
  statixCheck = pkgs.writeShellScriptBin "statix-check" ''
    for file in "$@"; do
      ${lib.getExe pkgs.statix} check --config statix.toml "$file"
    done
  '';
in
{
  projectRootFile = "flake.nix";

  programs = {
    actionlint.enable = pkgs.stdenv.hostPlatform.isLinux;
    deadnix.enable = true;
    nixfmt.enable = true;
    oxfmt = {
      enable = true;
      includes = oxfmtIncludes;
    };
    shellcheck = {
      enable = true;
      includes = [
        "*.sh"
        "bin/fleet"
        "bin/traitor"
        "bin/repo-*"
      ];
    };
    shfmt = {
      enable = true;
      includes = [
        "*.sh"
        "bin/fleet"
        "bin/traitor"
        "bin/repo-*"
      ];
      useEditorConfig = true;
    };
    rustfmt = {
      enable = true;
      edition = "2021";
    };
    stylua.enable = true;
    taplo.enable = true;
  };

  settings.formatter = {
    deadnix.priority = 1;
    statix = {
      command = lib.getExe statixCheck;
      includes = [ "*.nix" ];
      priority = 2;
    };
    nixfmt.priority = 3;

    shfmt.priority = 1;
    shellcheck.priority = 2;

    oxfmt.priority = 1;
    oxlint = {
      command = lib.getExe pkgs.oxlint;
      includes = oxlintIncludes;
      priority = 2;
    };
  };
}
