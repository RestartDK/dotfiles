{
  network,
  ...
}:

{
  imports = [ ./dev-tools.nix ];

  xdg.enable = true;

  programs.git = {
    enable = true;
    ignores = [ "**/.claude/settings.local.json" ];
    settings = {
      core.hooksPath = "${../../config/git/hooks}";
      user = {
        name = network.fullName;
        email = network.workEmail;
      };
      credential = {
        "https://github.com".helper = "!gh auth git-credential";
        "https://gist.github.com".helper = "!gh auth git-credential";
      };
    };
  };
}
