{
  buildNpmPackage,
  fetchurl,
  jq,
  lib,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-web-access";
  version = "0.46.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-web-access/-/pi-web-access-${finalAttrs.version}.tgz";
    hash = "sha256-FPnsntJ21UEYmWeI8mjlNwcKrAXV8KOpMzhpaY1alK0=";
  };

  postPatch = ''
    cp ${./package-lock.json} package-lock.json
    ${lib.getExe jq} 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
  '';

  npmFlags = [ "--legacy-peer-deps" ];
  npmPackFlags = [ "--ignore-scripts" ];
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-kQnm3ti5Tct/p/1kI8xZfRTdMwM88t8M95PsaQvHlX0=";

  dontNpmBuild = true;
})
