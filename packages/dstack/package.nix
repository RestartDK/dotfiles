{
  buildNpmPackage,
  nodejs_24,
  bun,
  makeWrapper,
  bash,
  git,
  gh,
  jq,
  flock,
  util-linux,
  python3,
  openssh,
  pi,
  lib,
  stdenv,
  writeScript,
  runtimeShell,
}:

let
  procPython = python3.withPackages (ps: [ ps.psutil ]);
  procHelper = writeScript "dstack-proc" ''
    #!${runtimeShell}
    exec ${procPython}/bin/python3 ${./native/dstack-proc.py} "$@"
  '';
in
(buildNpmPackage.override { nodejs = nodejs_24; }) {
  pname = "dstack-jobs";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./src
      ./native
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
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    util-linux
    python3
  ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export DSTACK_PROC=${procHelper}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      export DSTACK_FLOCK=${lib.getExe flock}
    ''}
    DSTACK_TEST_NODE=${nodejs_24}/bin/node bun test tests ../../config/pi/agent/extensions/pi-jobs
    ${nodejs_24}/bin/node dist/cli.js --help
    ${nodejs_24}/bin/node dist/daemon.js --help
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec/dstack" "$out/bin"
    cp -r dist node_modules package.json "$out/libexec/dstack/"
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      install -m755 ${procHelper} "$out/bin/dstack-proc"
    ''}
    for entry in dstack:cli dstackd:daemon; do
      makeWrapper ${nodejs_24}/bin/node "$out/bin/''${entry%:*}" \
        --add-flags "$out/libexec/dstack/dist/''${entry#*:}.js" \
        --set DSTACK_PI ${lib.getExe pi} \
        --set DSTACK_GH ${lib.getExe gh} \
        --set DSTACK_GIT ${lib.getExe git} \
        ${lib.optionalString stdenv.hostPlatform.isLinux ''
          --set DSTACK_PYTHON ${lib.getExe python3} \
          --set DSTACK_FLOCK ${util-linux}/bin/flock \
        ''}${lib.optionalString stdenv.hostPlatform.isDarwin ''
          --set DSTACK_PROC $out/bin/dstack-proc \
          --set DSTACK_FLOCK ${lib.getExe flock} \
        ''}--set DSTACK_OBSERVER ${../../config/agents/skills/dstack/dstack-mode/scripts/watch-pr} \
        --prefix PATH : ${
          lib.makeBinPath (
            [
              bash
              git
              gh
              jq
              openssh
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [
              util-linux
              python3
            ]
          )
        }
    done
    runHook postInstall
  '';
  meta = {
    description = "Local durable PR monitoring with explicit repair authority";
    mainProgram = "dstack";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
