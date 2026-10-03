{ network, lib, ... }:
{
  my.domain = lib.mkDefault network.domain;
  my.hosts = lib.mkDefault network.hosts;
  my.network = lib.mkDefault network.network;
  my.host.fullName = lib.mkDefault network.fullName;
  my.host.authorizedKeys = lib.mkDefault network.authorizedKeys.user;
  my.host.rootAuthorizedKeys = lib.mkDefault network.authorizedKeys.root;
}
