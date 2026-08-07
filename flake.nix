{
  description = "Daniel's Nix-native cross-device configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    hunk.url = "github:modem-dev/hunk";
    hunk.inputs.nixpkgs.follows = "nixpkgs";

    herdr.url = "github:ogulcancelik/herdr";
    herdr.inputs.nixpkgs.follows = "nixpkgs";

    llm-agents.url = "github:numtide/llm-agents.nix";

    scatterer-src = {
      url = "github:RestartDK/scatterer";
      flake = false;
    };

    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

  };

  outputs = inputs@{ self, nixpkgs, home-manager, nix-darwin, ... }:
  let
    linuxSystem = "x86_64-linux";
    darwinSystem = "aarch64-darwin";
    systems = [ linuxSystem darwinSystem ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = system: import nixpkgs {
      inherit system;
      config.allowUnfree = true;
    };
    mkTraitorPackage = pkgs: pkgs.stdenvNoCC.mkDerivation {
      pname = "traitor";
      version = "0.1.0";
      src = ./bin;
      dontConfigure = true;
      dontBuild = true;
      installPhase = ''
        mkdir -p $out/bin
        cp traitor $out/bin/traitor
        chmod +x $out/bin/traitor
      '';
    };
    twinPkgs = import inputs.nixpkgs-unstable {
      system = linuxSystem;
      config.allowUnfree = true;
    };
    homeSpecialArgs = {
      inherit inputs;
      dotfilesInputs = inputs;
    };
  in {
    packages = forAllSystems (system:
      let
        pkgs = pkgsFor system;
        traitor = mkTraitorPackage pkgs;
      in
      {
        inherit traitor;
        default = traitor;
      });

    apps = forAllSystems (system: {
      traitor = {
        type = "app";
        program = "${self.packages.${system}.traitor}/bin/traitor";
      };
      default = self.apps.${system}.traitor;
    });

    homeManagerModules =
      let
        withDotfilesInputs = module: extraImports: { ... }: {
          # Keep the embedding flake's generic `inputs` argument intact. Cobb
          # passes its own inputs through Home Manager extraSpecialArgs.
          _module.args.dotfilesInputs = inputs;
          imports = [ module ] ++ extraImports;
        };
        hunkModule = inputs.hunk.homeManagerModules.default;
      in
      {
        live-symlinks = withDotfilesInputs ./modules/home/live-symlinks.nix [ ];
        cobb-daniel = withDotfilesInputs ./profiles/home/cobb-daniel.nix [ hunkModule ];
      };

    nixosConfigurations.srv-nana = nixpkgs.lib.nixosSystem {
      system = linuxSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/srv-nana
        home-manager.nixosModules.home-manager
        {
          home-manager = {
            useGlobalPkgs = true;
            useUserPackages = true;
            backupFileExtension = "hm-backup";
            extraSpecialArgs = homeSpecialArgs;
            users.dkumlin = import ./hosts/srv-nana/home.nix;
          };
        }
      ];
    };

    # Dev-only profile for existing NixOS/Linux target machines. This is
    # intentionally Home Manager only: it does not change DNS, SSH, users,
    # groups, Docker, bootloader, or other host-level settings.
    homeConfigurations.twin = home-manager.lib.homeManagerConfiguration {
      pkgs = twinPkgs;
      extraSpecialArgs = homeSpecialArgs;
      modules = [ ./hosts/twin/home.nix ];
    };

    darwinConfigurations."dkumlin-macbook-pro" = nix-darwin.lib.darwinSystem {
      system = darwinSystem;
      specialArgs = { inherit inputs; };
      modules = [
        ./hosts/dkumlin-macbook-pro
        home-manager.darwinModules.home-manager
        {
          home-manager = {
            useGlobalPkgs = true;
            useUserPackages = true;
            backupFileExtension = "hm-backup";
            extraSpecialArgs = homeSpecialArgs;
            users.danielkumlin = import ./hosts/dkumlin-macbook-pro/home.nix;
          };
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
          home-manager = {
            useGlobalPkgs = true;
            useUserPackages = true;
            backupFileExtension = "hm-backup";
            extraSpecialArgs = homeSpecialArgs;
            users.danielkumlin = import ./hosts/dkumlin-twin-macbook-pro/home.nix;
          };
        }
      ];
    };
  };
}
