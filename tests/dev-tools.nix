{
  pkgs,
  self,
  inputs,
}:
let
  inherit (pkgs) lib;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  # The portable profile is built with the srv-nana package set, so its expected
  # derivations come from that system rather than the host running the check.
  portablePackages =
    self.packages.${self.nixosConfigurations.srv-nana.pkgs.stdenv.hostPlatform.system};
  macHome = self.darwinConfigurations.dkumlin-macbook-pro.config.home-manager.users.danielkumlin;
  portableHome =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      modules = [
        self.homeManagerModules.default
        {
          my.ai.profile = "work";
          home = {
            username = "daniel";
            homeDirectory = "/home/daniel";
            stateVersion = "26.05";
          };
        }
      ];
    }).config;
  names = home: map (p: p.pname or p.name or "") home.home.packages;
  macNames = names macHome;
  portableNames = names portableHome;
  has = prefix: builtins.any (name: lib.hasPrefix prefix name);
  installs =
    package: home:
    builtins.any (candidate: (candidate.drvPath or "") == package.drvPath) home.home.packages;
in
assert installs packages.traitor macHome;
assert installs packages.fleet macHome;
assert installs packages.agent-desktop macHome;
assert installs packages.pi macHome;
assert installs packages.opencode macHome;
assert has "codex" macNames;
assert has "agent-browser" macNames;
assert has "claude-code" macNames;
assert has "opencode" macNames;
assert !(installs portablePackages.traitor portableHome);
assert !(installs portablePackages.pi portableHome);
assert !(installs portablePackages.opencode portableHome);
assert !(has "codex" portableNames);
assert !(has "agent-browser" portableNames);
assert !(has "claude-code" portableNames);
assert !(has "opencode" portableNames);
assert installs portablePackages.fleet portableHome;
assert installs portablePackages.agent-desktop portableHome;
pkgs.runCommand "dev-tools-tests" { } ''
  touch $out
''
