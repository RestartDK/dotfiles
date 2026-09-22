{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-mcp-adapter";
  version = "2.36.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-${finalAttrs.version}.tgz";
    hash = "sha256-y76o+5w7Tpt7ZU0KLiNMNf0KrY1ZOksjOBcoZNa2KfA=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-YCGW7Pev5OpxUIVGh4yr1YTRspdwIVwedD6ydiCuG2A=";

  dontNpmBuild = true;
})
