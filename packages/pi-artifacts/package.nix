{
  buildNpmPackage,
  nodejs_22,
  dejavu_fonts,
  lib,
}:

buildNpmPackage {
  pname = "pi-artifacts";
  version = "0.1.0";
  src = lib.cleanSource ./.;
  nodejs = nodejs_22;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-exHlkpWbT9iMI34ZXZelxlLjI3ItNz0LXBdlgVO4eK8=";
  npmFlags = [
    "--legacy-peer-deps"
    "--ignore-scripts"
  ];
  npmPackFlags = [ "--ignore-scripts" ];
  postPatch = ''
    printf '%s\n' 'export const nodeExecutable: string | undefined = "${nodejs_22}/bin/node";' > src/runtime.ts
    mkdir -p fonts
    cp ${dejavu_fonts}/share/fonts/truetype/DejaVuSans{,-Bold}.ttf fonts/
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test dist/artifacts.test.js
    runHook postCheck
  '';
  passthru.isLocalPiPackage = true;
  meta.platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
