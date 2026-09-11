{
  config,
  pkgs,
  ...
}:
{
  imports = [
    ../../modules/nixos/host-options.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/numtide-cache.nix
  ];
  my.host = {
    hostName = "srv-hatchi";
    extraGroups = [ "wheel" ];
  };
  users.users.${config.my.host.userName} = {
    isNormalUser = true;
    inherit (config.my.host) extraGroups;
    openssh.authorizedKeys.keys = config.my.host.authorizedKeys;
  };
  users.users.root.openssh.authorizedKeys.keys = config.my.host.rootAuthorizedKeys;
  services.openssh.openFirewall = false;
  services.tailscale = {
    enable = true;
    openFirewall = false;
    extraSetFlags = [ "--netfilter-mode=off" ];
  };
  virtualisation.docker.enable = false;
  virtualisation.podman.enable = false;
  services.cockpit.enable = false;
  environment.systemPackages = [
    pkgs.curl
    pkgs.jq
  ];
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  system.stateVersion = "26.05";
}
