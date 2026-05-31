{
  description = "Daniel's Nix-native cross-device configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ self, nixpkgs, home-manager, ... }:
  let
    linuxSystem = "x86_64-linux";
  in {
    nixosConfigurations.srv-nana = nixpkgs.lib.nixosSystem {
      system = linuxSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/nana
        home-manager.nixosModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.backupFileExtension = "hm-backup";
          home-manager.extraSpecialArgs = { inherit inputs; };
          home-manager.users.dkumlin = import ./home/dkumlin.nix;
        }
      ];
    };
  };
}
