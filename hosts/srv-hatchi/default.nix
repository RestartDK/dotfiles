{ ... }:
{
  imports = [
    ./cache.nix
    ./foundation.nix
    ./options.nix
    ./secrets.nix
    ./edge.nix
    ./storage.nix
    ./iot-link.nix
    ./services/dashboard.nix
    ./services/books.nix
    ./services/media.nix
    ./services/nextcloud.nix
    ./services/couchdb.nix
    ./services/monitoring.nix
    ./services/remote-nana.nix
    ./services/home-assistant.nix
    ./services/matter-server.nix
    ./runner.nix
  ];
}
