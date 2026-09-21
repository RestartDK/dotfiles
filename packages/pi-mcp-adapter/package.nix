{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-mcp-adapter";
  version = "2.35.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-${finalAttrs.version}.tgz";
    hash = "sha256-G5tmn+R9eNL3/yPy9n1JFfiZ9ifdSRa8FeEtRmjvXlE=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-IUujDLvc1ED81JlJhkB21KG9sWUZ+3H1fQrl1X4PypQ=";

  dontNpmBuild = true;
})
