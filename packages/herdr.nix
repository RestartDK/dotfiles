{ fetchurl, lib, stdenvNoCC }:

let
  system = stdenvNoCC.hostPlatform.system;
  sources = {
    x86_64-linux = {
      asset = "linux-x86_64";
      hash = "sha256-BD70Psur2ihGXc/x7sMYRRgVDVZ7i48gzanGyIdwZB0=";
    };
    aarch64-darwin = {
      asset = "macos-aarch64";
      hash = "sha256-sxNFOS0ATsHxssgh4a1gEBn6g4X+HkxpMTIetYqSB3M=";
    };
  };
  source = sources.${system} or (throw "herdr is not packaged for ${system} in this config");
in
stdenvNoCC.mkDerivation rec {
  pname = "herdr";
  version = "0.7.3";

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
