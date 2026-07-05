{
  description = "Daniel's Nix-native cross-device configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    hunk.url = "github:modem-dev/hunk";
    hunk.inputs.nixpkgs.follows = "nixpkgs-unstable";

    scatterer-src = {
      url = "github:RestartDK/scatterer";
      flake = false;
    };

    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    # Track Pi directly so `nix flake update` can advance it independently of
    # the version packaged in nixpkgs-unstable.
    pi-src = {
      url = "github:earendil-works/pi";
      flake = false;
    };
  };

  outputs = inputs@{ self, nixpkgs, home-manager, nix-darwin, ... }:
  let
    linuxSystem = "x86_64-linux";
    darwinSystem = "aarch64-darwin";
    twinPkgs = import inputs.nixpkgs-unstable {
      system = linuxSystem;
      config.allowUnfree = true;
    };
  in {
    nixosConfigurations.srv-nana = nixpkgs.lib.nixosSystem {
      system = linuxSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/srv-nana
        home-manager.nixosModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.backupFileExtension = "hm-backup";
          home-manager.extraSpecialArgs = { inherit inputs; };
          home-manager.users.dkumlin = import ./hosts/srv-nana/home.nix;
        }
      ];
    };

    # Dev-only profile for existing NixOS/Linux target machines. This is
    # intentionally Home Manager only: it does not change DNS, SSH, users,
    # groups, Docker, bootloader, or other host-level settings.
    homeConfigurations.twin = home-manager.lib.homeManagerConfiguration {
      pkgs = twinPkgs;
      extraSpecialArgs = { inherit inputs; };
      modules = [ ./hosts/twin/home.nix ];
    };

    darwinConfigurations."dkumlin-macbook-pro" = nix-darwin.lib.darwinSystem {
      system = darwinSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/dkumlin-macbook-pro
        home-manager.darwinModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.backupFileExtension = "hm-backup";
          home-manager.extraSpecialArgs = { inherit inputs; };
          home-manager.users.danielkumlin = import ./hosts/dkumlin-macbook-pro/home.nix;
        }
      ];
    };

    darwinConfigurations."dkumlin-twin-macbook-pro" = nix-darwin.lib.darwinSystem {
      system = darwinSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/dkumlin-twin-macbook-pro
        home-manager.darwinModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.backupFileExtension = "hm-backup";
          home-manager.extraSpecialArgs = { inherit inputs; };
          home-manager.users.danielkumlin = import ./hosts/dkumlin-twin-macbook-pro/home.nix;
        }
      ];
    };
  };
}
