{ fetchurl, lib, stdenvNoCC }:

stdenvNoCC.mkDerivation rec {
  pname = "herdr";
  version = "0.6.8";

  src = fetchurl {
    url = "https://github.com/ogulcancelik/herdr/releases/download/v${version}/herdr-linux-x86_64";
    hash = "sha256-Uo0i6ImBSmzPIhYoAdWWkNnb1dxk+W1+HRx6hjSyVTU=";
  };

  dontUnpack = true;

  installPhase = ''
    install -Dm755 "$src" "$out/bin/herdr"
  '';

  meta = {
    description = "Terminal workspace manager for AI coding agents";
    homepage = "https://herdr.dev";
    license = lib.licenses.unfreeRedistributable;
    platforms = [ "x86_64-linux" ];
    mainProgram = "herdr";
  };
}
