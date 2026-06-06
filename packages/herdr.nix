{ fetchurl, lib, stdenvNoCC }:

let
  system = stdenvNoCC.hostPlatform.system;
  sources = {
    x86_64-linux = {
      asset = "linux-x86_64";
      hash = "sha256-Uo0i6ImBSmzPIhYoAdWWkNnb1dxk+W1+HRx6hjSyVTU=";
    };
    aarch64-darwin = {
      asset = "macos-aarch64";
      hash = "sha256-E0T9GHQapNAXI8N60+IvOP4WJuQJC1Q1qxdXxm8qF9U=";
    };
  };
  source = sources.${system} or (throw "herdr is not packaged for ${system} in this config");
in
stdenvNoCC.mkDerivation rec {
  pname = "herdr";
  version = "0.6.8";

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
