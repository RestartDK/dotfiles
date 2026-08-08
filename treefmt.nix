{ lib, pkgs, ... }:

let
  oxlintIncludes = [
    "config/amp/plugins/*.ts"
    "config/karabiner/src/*.ts"
    "config/opencode/plugins/*.js"
    "config/pi/agent/extensions/*.ts"
    "config/pi/agent/extensions/**/*.mjs"
    "config/pi/agent/extensions/**/*.ts"
  ];
  oxfmtIncludes = oxlintIncludes ++ [
    "config/karabiner/package.json"
    "config/opencode/package.json"
    "config/pi/agent/extensions/*/package.json"
  ];
in
{
  projectRootFile = "flake.nix";

  programs = {
    actionlint.enable = pkgs.stdenv.hostPlatform.isLinux;
    deadnix.enable = true;
    nixfmt.enable = true;
    oxfmt = {
      enable = true;
      excludes = [ "**/generated/**" ];
      includes = oxfmtIncludes;
    };
    shellcheck = {
      enable = true;
      includes = [
        "*.sh"
        "bin/traitor"
      ];
    };
    shfmt = {
      enable = true;
      includes = [
        "*.sh"
        "bin/traitor"
      ];
    };
    statix.enable = true;
    stylua.enable = true;
    taplo.enable = true;
  };

  settings.formatter = {
    deadnix.priority = 1;
    statix.priority = 2;
    nixfmt.priority = 3;

    shfmt.priority = 1;
    shellcheck = {
      options = [ "--exclude=SC1091" ];
      priority = 2;
    };

    oxfmt.priority = 1;
    oxlint = {
      command = lib.getExe pkgs.oxlint;
      excludes = [ "**/generated/**" ];
      includes = oxlintIncludes;
      options = [
        "--allow=no-control-regex"
        "--allow=no-new-array"
        "--allow=no-unused-vars"
        "--deny-warnings"
      ];
      priority = 2;
    };
  };
}
