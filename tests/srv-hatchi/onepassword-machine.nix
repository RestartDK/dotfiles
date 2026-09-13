{
  lib,
  pkgs,
  self,
  ...
}:
{
  imports = [ self.nixosModules.srv-hatchi ];
  networking.hostName = lib.mkForce "hatchi-op-test";
  services.tailscale.enable = lib.mkForce false;
  services.openssh.enable = lib.mkForce false;
  services.adguardhome.settings.dns.bind_hosts = lib.mkForce [ "127.0.0.1" ];
  security.acme.certs = lib.mkForce { };
  services.caddy.virtualHosts =
    lib.genAttrs
      (builtins.attrNames self.nixosConfigurations.srv-hatchi.config.services.caddy.virtualHosts)
      (_: {
        useACMEHost = lib.mkForce null;
        extraConfig = lib.mkBefore "bind 127.0.0.1\ntls internal";
      });
  services.caddy.globalConfig = "skip_install_trust";
  fileSystems."/srv/media" = {
    device = "tmpfs";
    fsType = "tmpfs";
    options = [
      "size=64M"
      "mode=0755"
    ];
  };
  my.hatchi.onepassword = {
    enable = true;
    references = {
      glanceKey = lib.mkDefault null;
      grafanaKey = lib.mkDefault null;
    };
  };
  environment.systemPackages = [
    pkgs.python3
    pkgs.sops
    pkgs.age
  ];
}
