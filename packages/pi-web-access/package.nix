{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-web-access";
  version = "0.33.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-web-access/-/pi-web-access-${finalAttrs.version}.tgz";
    hash = "sha256-9UjpXvNylncH+svUWkO9zGtZD0pD3eP/zJCBvi5YJu8=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-N5ILHIOD0BpDfjnzacVCM+0W3kkyCmIHJta/JsdXi7o=";

  dontNpmBuild = true;
})
