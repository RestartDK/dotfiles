{
  lib,
  bun,
  fetchzip,
  typescript,
  upstream,
}:

let
  bunTypes = fetchzip {
    url = "https://registry.npmjs.org/bun-types/-/bun-types-1.3.13.tgz";
    hash = "sha256-9FoyNsRniB0rdcepRO2v+5mS8uNNj0ETHXBJSuApgFk=";
  };
  typecheckSource = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../config/pi/agent/lib
      ../../config/pi/agent/extensions/subagents
      ../../config/pi/agent/extensions/pi-prompt
      ../../config/pi/agent/extensions/pi-no-default-model.ts
      ../../tests/agent-profiles
      ../../tests/pi-profiled
    ];
  };
in
upstream.overrideAttrs (old: {
  pname = "pi-profiled";
  preInstall = ''
    mkdir -p node_modules
    ln -sfn ${typescript}/lib/node_modules/typescript node_modules/typescript
    node ${./typecheck.mjs} "$PWD" ${typecheckSource} ${bunTypes}
    mkdir -p policy-check
    cp -R ${../../tests/pi-profiled} policy-check/tests
    cp -R ${../../config/agents/model-profiles} policy-check/profiles
    PI_POLICY_TEST_PROFILES="$PWD/policy-check/profiles" \
      PI_POLICY_TEST_EXTENSION="${typecheckSource}/config/pi/agent/extensions/subagents/index.ts" \
      ${bun}/bin/bun test policy-check/tests/dispatch.test.ts
  ''
  + (old.preInstall or "");
})
