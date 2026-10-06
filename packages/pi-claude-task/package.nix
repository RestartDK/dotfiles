{ buildNpmPackage, lib }:

buildNpmPackage {
  pname = "pi-claude-task";
  version = "0.1.0";
  src = lib.cleanSource ../../config/pi/packages/pi-claude-task;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-8X7Ghz57gPCDhDLPryBB65Mu9349l1nD1Scggf6FbPI=";
  npmFlags = [ "--ignore-scripts" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmPruneFlags = [ "--omit=peer" ];
  dontNpmBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    npm test
    runHook postCheck
  '';
}
