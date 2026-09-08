{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-web-access";
  version = "0.28.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-web-access/-/pi-web-access-${finalAttrs.version}.tgz";
    hash = "sha256-jSe9FEDF0eKIXpe0Tvr+YPPYGiqeVsGKyLhNYIBxjrU=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-jzSlePeODkhQxcpHltPLNHN1dvq3JUilarPnvPLWWcI=";

  dontNpmBuild = true;
})
