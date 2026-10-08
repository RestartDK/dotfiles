pkgs: child:
pkgs.symlinkJoin {
  name = "pi";
  paths = [ child ];
  nativeBuildInputs = [ pkgs.makeWrapper ];
  postBuild = ''
    wrapProgram $out/bin/pi --run ${pkgs.lib.escapeShellArg (builtins.readFile ./herdr-images.sh)}
  '';
}
