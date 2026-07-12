{ inputs, ... }:

{
  imports = [
    inputs.hunk.homeManagerModules.default
    ../../modules/home/cobb-forwarding.nix
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "danielkumlin";
  home.homeDirectory = "/Users/danielkumlin";
  home.stateVersion = "26.05";

  programs.hunk.enable = true;

  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    settings = {
      titan = {
        HostName = "titan";
        Port = 2222;
        User = "daniel";
        # Public key selector only; private key should live in the 1Password Developer vault.
        IdentityFile = "~/.ssh/id_ed25519.pub";
        IdentitiesOnly = true;
        ForwardAgent = true;
      };

      "titan-2" = {
        HostName = "titan-2";
        Port = 2222;
        User = "daniel";
        # Public key selector only; private key should live in the 1Password Developer vault.
        IdentityFile = "~/.ssh/id_ed25519.pub";
        IdentitiesOnly = true;
        ForwardAgent = true;
      };

      "*" = {
        IdentityAgent = "\"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
      };
    };
  };

  xdg.configFile."1Password/ssh/agent.toml".text = ''
    # 1Password SSH agent: expose all SSH keys from the Developer vault.
    [[ssh-keys]]
    vault = "Developer"
  '';

  my.liveConfig = {
    enable = true;
    repoRoot = "/Users/danielkumlin/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      multiplexer = true;
      agents = true;
      macos = true;
    };
  };
}
