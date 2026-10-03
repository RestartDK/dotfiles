{ lib, network, ... }:

{
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    settings = {
      nana-lan = lib.hm.dag.entryBefore [ "nana" ] {
        header = "Match host nana,srv-nana exec \"ping -c 1 -n -W 1 ${network.hosts.nana.lan} >/dev/null 2>&1\"";
        HostName = network.hosts.nana.lan;
      };
      hatchi-lan = lib.hm.dag.entryBefore [ "hatchi" ] {
        header = "Match host hatchi,srv-hatchi exec \"ping -c 1 -n -W 1 ${network.hosts.hatchi.lan} >/dev/null 2>&1\"";
        HostName = network.hosts.hatchi.lan;
      };

      nana = {
        header = "Host nana srv-nana";
        HostName = network.hosts.nana.tailnet;
        User = "dkumlin";
        IdentityFile = [
          "~/.ssh/nana.pub"
          "~/.ssh/ci-deploy.pub"
        ];
        IdentitiesOnly = true;
      };

      hatchi = {
        header = "Host hatchi srv-hatchi";
        HostName = network.hosts.hatchi.tailnet;
        User = "dkumlin";
        IdentityFile = [
          "~/.ssh/hatchi.pub"
          "~/.ssh/ci-deploy.pub"
        ];
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
    ".ssh/hatchi.pub".source = ../../config/ssh/public-keys/hatchi.pub;
    ".ssh/titan.pub".source = ../../config/ssh/public-keys/titan.pub;
    ".ssh/ci-deploy.pub".source = ../../config/ssh/public-keys/ci-deploy.pub;
  };

  xdg.configFile."1Password/ssh/agent.toml".text = ''
    [[ssh-keys]]
    vault = "Developer"
  '';
}
