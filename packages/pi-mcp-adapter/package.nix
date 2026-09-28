{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-mcp-adapter";
  version = "3.1.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-${finalAttrs.version}.tgz";
    hash = "sha256-MvcEnQnohzabJExF/3dpKKvIQ+c/Uni0dAlUyQfEt9I=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-Fa+q7Bx1d4rValBTkrS+ONmVI4NAGS1x/zt+oqFltPg=";

  dontNpmBuild = true;
})
