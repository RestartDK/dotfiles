{ lib, rustPlatform }:

rustPlatform.buildRustPackage {
  pname = "repo-exec";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: type: lib.cleanSourceFilter path type && baseNameOf path != "target";
  };
  cargoLock.lockFile = ./Cargo.lock;

  postInstall = ''
    ln -s repo-exec "$out/bin/repo-bash"
  '';

  meta = {
    description = "Repository-prepared command execution with owned process-group supervision";
    mainProgram = "repo-exec";
    platforms = lib.platforms.unix;
  };
}
