{
  pkgs,
  self,
  inputs,
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  browser = (pkgs.extend self.overlays.default).terminal-browser;
  embeddingPkgs =
    (import inputs.nixpkgs {
      inherit system;
      config.allowUnfree = true;
    }).extend
      (
        _final: prev: {
          coreutils = prev.coreutils.overrideAttrs (old: {
            pname = "${old.pname}-embedded-host";
          });
        }
      );
  embeddingBrowser = (embeddingPkgs.extend self.overlays.default).terminal-browser;
  embeddedHome =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = embeddingPkgs;
      modules = [
        self.homeManagerModules.live-symlinks
        {
          home = {
            username = "overlay-test";
            homeDirectory = "/tmp/terminal-browser-overlay-home";
            stateVersion = "26.05";
          };
          my.liveConfig = {
            enable = true;
            repoRoot = "/tmp/terminal-browser-overlay-home/dotfiles";
            groups.terminalTools = true;
          };
        }
      ];
    }).config;
in
assert browser.drvPath == self.packages.${system}.terminal-browser.drvPath;
assert embeddingBrowser.drvPath != browser.drvPath;
assert builtins.any (
  package: package.drvPath == embeddingBrowser.drvPath
) embeddedHome.home.packages;
pkgs.runCommand "terminal-browser-overlay-tests" { } ''
  touch $out
''
