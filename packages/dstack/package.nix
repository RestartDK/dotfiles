{
  buildNpmPackage,
  nodejs_24,
  bun,
  makeWrapper,
  bash,
  git,
  gh,
  jq,
  util-linux,
  python3,
  openssh,
  pi,
  lib,
}:

(buildNpmPackage.override { nodejs = nodejs_24; }) {
  pname = "dstack-jobs";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./src
      ./tests
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./README.md
      ../../config/pi/agent/lib/dstack-jobs.ts
      ../../config/pi/agent/lib/model-policy.ts
      ../../config/pi/agent/extensions/pi-jobs
      ../../config/pi/agent/extensions/pi-herdr/client.ts
      ../../config/pi/agent/extensions/pi-herdr/generated
    ];
  };
  sourceRoot = "source/packages/dstack";
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-FdlLce/ulPs86ahwnu2SPfkIRXkadeCxd3icNZvr2Dg=";
  npmFlags = [ "--ignore-scripts" ];
  npmPackFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [
    makeWrapper
    bun
    git
    util-linux
    python3
  ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    DSTACK_TEST_NODE=${nodejs_24}/bin/node bun test tests ../../config/pi/agent/extensions/pi-jobs
    ${nodejs_24}/bin/node dist/cli.js --help
    ${nodejs_24}/bin/node dist/daemon.js --help
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec/dstack" "$out/bin"
    cp -r dist node_modules package.json "$out/libexec/dstack/"
    for entry in dstack:cli dstackd:daemon; do
      makeWrapper ${nodejs_24}/bin/node "$out/bin/''${entry%:*}" \
        --add-flags "$out/libexec/dstack/dist/''${entry#*:}.js" \
        --set DSTACK_PI ${lib.getExe pi} \
        --set DSTACK_GH ${lib.getExe gh} \
        --set DSTACK_GIT ${lib.getExe git} \
        --set DSTACK_PYTHON ${lib.getExe python3} \
        --set DSTACK_FLOCK ${util-linux}/bin/flock \
        --set DSTACK_OBSERVER ${../../config/agents/skills/dstack/dstack-mode/scripts/watch-pr} \
        --prefix PATH : ${
          lib.makeBinPath [
            bash
            git
            gh
            jq
            util-linux
            python3
            openssh
          ]
        }
    done
    runHook postInstall
  '';
  meta = {
    description = "Local durable PR monitoring with explicit repair authority";
    mainProgram = "dstack";
    platforms = lib.platforms.linux;
  };
}
