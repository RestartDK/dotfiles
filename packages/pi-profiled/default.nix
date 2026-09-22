{
  lib,
  bun,
  fetchzip,
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
assert lib.assertMsg (
  upstream.version == "0.87.0"
) "pi-profiled must be reviewed against the new Pi version before updating";
upstream.overrideAttrs (old: {
  pname = "pi-profiled";
  patches = (old.patches or [ ]) ++ [ ./core-policy.patch ];
  patchFlags = [
    "-p1"
    "--fuzz=0"
  ];
  preInstall = ''
    patch --batch -d node_modules/@earendil-works/pi-ai -p1 --fuzz=0 < ${./attempt-policy.patch}
    ${bun}/bin/bun build ${../../config/pi/agent/lib}/pi-policy.ts --target=bun --external '@earendil-works/*' --outfile dist/core/dstack-policy.js
    node ${./typecheck.mjs} "$PWD" ${typecheckSource} ${bunTypes}
    mkdir -p policy-check
    cp -R ${../../tests/pi-profiled} policy-check/tests
    cp -R ${../../config/agents/model-profiles} policy-check/profiles
    PI_POLICY_TEST_PROFILES="$PWD/policy-check/profiles" \
      PI_POLICY_TEST_EXTENSION="${typecheckSource}/config/pi/agent/extensions/subagents/index.ts" \
      ${bun}/bin/bun test policy-check/tests/runtime.test.ts policy-check/tests/attempts.test.ts policy-check/tests/dispatch.test.ts policy-check/tests/summary-retry.test.ts
  ''
  + (old.preInstall or "");
  postInstall = (old.postInstall or "") + ''
    PI_POLICY_TEST_PROFILES="$PWD/policy-check/profiles" PI_POLICY_TEST_BINARY="$out/bin/pi" \
      ${bun}/bin/bun test policy-check/tests/cli.test.ts
  '';
})
