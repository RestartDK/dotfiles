{ lib, rustPlatform }:

rustPlatform.buildRustPackage {
  pname = "dstack-command-helper";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: type: lib.cleanSourceFilter path type && baseNameOf path != "target";
  };
  cargoLock.lockFile = ./Cargo.lock;

  meta = {
    description = "Owned Linux command execution with pinned filesystem context and independent receipts";
    mainProgram = "dstack-command-helper";
    platforms = lib.platforms.linux;
  };
}
