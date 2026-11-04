{
  pkgs,
  self,
  inputs,
}:
let
  lib = pkgs.lib;
  macHome = self.darwinConfigurations.dkumlin-macbook-pro.config.home-manager.users.danielkumlin;
  portableHome =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      extraSpecialArgs.dotfilesInputs = inputs;
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
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
  installsPi = home: builtins.any (package: (package.drvPath or "") == pi.drvPath) home.home.packages;
in
assert has "traitor" macNames;
assert has "fleet" macNames;
assert has "agent-desktop" macNames;
assert has "codex" macNames;
assert has "agent-browser" macNames;
assert has "claude-code" macNames;
assert has "opencode" macNames;
assert installsPi macHome;
assert !(has "traitor" portableNames);
assert !(has "codex" portableNames);
assert !(has "agent-browser" portableNames);
assert !(has "claude-code" portableNames);
assert !(has "opencode" portableNames);
assert !(installsPi portableHome);
assert has "fleet" portableNames;
assert has "agent-desktop" portableNames;
pkgs.runCommand "dev-tools-tests" { } ''
  touch $out
''
