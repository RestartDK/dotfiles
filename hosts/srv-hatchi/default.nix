{ ... }:
{
  imports = [
    ./foundation.nix
    ./options.nix
    ./secrets.nix
    ./edge.nix
    ./storage.nix
    ./services/dashboard.nix
    ./services/books.nix
    ./services/media.nix
    ./services/nextcloud.nix
    ./services/couchdb.nix
    ./services/monitoring.nix
    ./services/remote-nana.nix
  ];
}
