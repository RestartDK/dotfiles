{ fetchurl, lib, stdenvNoCC }:

let
  system = stdenvNoCC.hostPlatform.system;
  sources = {
    x86_64-linux = {
      asset = "linux-x86_64";
      hash = "sha256-uWWsr/wsIvVLbmxkr3z46Yo/SsJiJjCgWZxnpLnYplQ=";
    };
    aarch64-darwin = {
      asset = "macos-aarch64";
      hash = "sha256-FvRlPwSR6h59K0a1sCVC8Y4bguiNqvnikAVy5btjTfg=";
    };
  };
  source = sources.${system} or (throw "herdr is not packaged for ${system} in this config");
in
stdenvNoCC.mkDerivation rec {
  pname = "herdr";
  version = "0.7.1";

  src = fetchurl {
    url = "https://github.com/ogulcancelik/herdr/releases/download/v${version}/herdr-${source.asset}";
    hash = source.hash;
  };

  dontUnpack = true;

  installPhase = ''
    install -Dm755 "$src" "$out/bin/herdr"
  '';

  meta = {
    description = "Terminal workspace manager for coding agents";
    homepage = "https://herdr.dev";
    license = lib.licenses.unfreeRedistributable;
    platforms = builtins.attrNames sources;
    mainProgram = "herdr";
  };
}
