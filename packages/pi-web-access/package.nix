{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-web-access";
  version = "0.34.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-web-access/-/pi-web-access-${finalAttrs.version}.tgz";
    hash = "sha256-7hDCVuBJt1WHmpfkDXyJ9/xghZANVpb8QvC/aH1ao4k=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-xDfGxbJ5aF1uDVJm8IbXjYtGmfvvoNTs8jZOPZV/Qdo=";

  dontNpmBuild = true;
})
