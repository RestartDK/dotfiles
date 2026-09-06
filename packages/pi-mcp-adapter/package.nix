{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-mcp-adapter";
  version = "2.32.1";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-${finalAttrs.version}.tgz";
    hash = "sha256-X3t5/hGGmZZ7HFJNi7ku5ZOdEIrNk0Is7q5+sqOWMIc=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-TCvcZbqTR9Zt0WS1FV69Hd+PTglimujAwJfftDxRa6c=";

  dontNpmBuild = true;
})
