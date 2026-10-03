{
  dotfilesInputs,
  network,
  pkgs,
  ...
}:

{
  xdg.enable = true;

  home.packages = import ./dev-package-list.nix {
    inherit pkgs;
    inputs = dotfilesInputs;
  };

  programs.git = {
    enable = true;
    ignores = [ "**/.claude/settings.local.json" ];
    settings = {
      core.hooksPath = "${../../config/git/hooks}";
      user = {
        name = "Daniel Kumlin";
        email = network.workEmail;
      };
      credential = {
        "https://github.com".helper = "!gh auth git-credential";
        "https://gist.github.com".helper = "!gh auth git-credential";
      };
    };
  };
}
