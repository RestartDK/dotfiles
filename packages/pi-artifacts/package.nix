{
  buildNpmPackage,
  bun,
  dejavu_fonts,
  lib,
}:

buildNpmPackage {
  pname = "pi-artifacts";
  version = "0.1.0";
  src = lib.cleanSource ./.;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-exHlkpWbT9iMI34ZXZelxlLjI3ItNz0LXBdlgVO4eK8=";
  npmFlags = [
    "--legacy-peer-deps"
    "--ignore-scripts"
  ];
  npmPackFlags = [ "--ignore-scripts" ];
  postPatch = ''
    printf '%s\n' 'export const bunExecutable: string | undefined = "${bun}/bin/bun";' > src/runtime.ts
    mkdir -p fonts
    cp ${dejavu_fonts}/share/fonts/truetype/DejaVuSans{,-Bold}.ttf fonts/
  '';
  passthru.isLocalPiPackage = true;
  meta.platforms = [
    "x86_64-linux"
    "aarch64-darwin"
  ];
}
