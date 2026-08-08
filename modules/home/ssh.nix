_:

{
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    settings = {
      nana = {
        HostName = "100.111.97.20";
        User = "dkumlin";
        IdentityFile = "~/.ssh/nana.pub";
        IdentitiesOnly = true;
      };

      titan = {
        HostName = "titan";
        Port = 2222;
        User = "daniel";
        IdentityFile = "~/.ssh/titan.pub";
        IdentitiesOnly = true;
        ForwardAgent = true;
      };

      "titan-2" = {
        HostName = "titan-2";
        Port = 2222;
        User = "daniel";
        IdentityFile = "~/.ssh/titan.pub";
        IdentitiesOnly = true;
        ForwardAgent = true;
      };

      "*" = {
        IdentityAgent = "\"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
      };
    };
  };

  home.file = {
    ".ssh/nana.pub".source = ../../config/ssh/public-keys/nana.pub;
    ".ssh/titan.pub".source = ../../config/ssh/public-keys/titan.pub;
  };

  xdg.configFile."1Password/ssh/agent.toml".text = ''
    [[ssh-keys]]
    vault = "Developer"
  '';
}
