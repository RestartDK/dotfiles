{
  lib,
  coreutils,
  bash,
  nodejs,
  runCommand,
  writeShellApplication,
  terminalBrowser,
}:
let
  patchedBrowser = terminalBrowser.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./split-launch.patch ];
  });
in
writeShellApplication {
  name = "terminal-browser";
  runtimeInputs = [ coreutils ];
  text = builtins.replaceStrings [ "@browser@" ] [ (lib.getExe patchedBrowser) ] (
    builtins.readFile ./launcher.sh
  );
  passthru = {
    inherit patchedBrowser;
    tests.namespace =
      runCommand "terminal-browser-namespace-tests"
        {
          nativeBuildInputs = [
            bash
            coreutils
            nodejs
          ];
        }
        ''
          bash ${./test-launcher.sh} ${./.}
          node ${./test-split.cjs} ${patchedBrowser}/lib/terminal-browser/cli/dist/main.js
          touch $out
        '';
  };
}
