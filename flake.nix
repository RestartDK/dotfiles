{
  description = "Daniel's Nix-native cross-device configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    disko.url = "github:nix-community/disko/ff8702b4de27f72b4c78573dfb89ec74e36abdf1";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    nixos-anywhere.url = "github:nix-community/nixos-anywhere/9df41112343713520ba071674cf8e45e91c25845";
    nixos-anywhere.inputs.nixpkgs.follows = "nixpkgs";
    nixos-anywhere.inputs.disko.follows = "disko";
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
    deploy-rs.url = "github:serokell/deploy-rs/414ac5f35d79aabe5a0bf52451d8cf61eadf6c88";
    deploy-rs.inputs.nixpkgs.follows = "nixpkgs";

    determinate.url = "https://flakehub.com/f/DeterminateSystems/determinate/3";

    llm-agents.url = "github:numtide/llm-agents.nix";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";

    scatterer = {
      url = "github:RestartDK/scatterer";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      home-manager,
      nix-darwin,
      ...
    }:
    let
      linuxSystem = "x86_64-linux";
      darwinSystem = "aarch64-darwin";
      systems = [
        linuxSystem
        darwinSystem
      ];
      piPackageNames = import ./packages/pi-package-names.nix;
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      treefmtEval = forAllSystems (
        system: inputs.treefmt-nix.lib.evalModule (pkgsFor system) ./treefmt.nix
      );
      mkTraitorPackage =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
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
      mkPiPackageUpdater =
        pkgs:
        pkgs.writeShellApplication {
          name = "update-pi-packages";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.gnutar
            pkgs.jq
            pkgs.nix-update
            pkgs.nodejs
          ];
          text = ''
            packages=(${nixpkgs.lib.escapeShellArgs piPackageNames})
            backup_dir="$(mktemp -d)"

            restore() {
              trap - ERR INT TERM
              for package in "''${packages[@]}"; do
                cp "$backup_dir/$package/package.nix" "packages/$package/package.nix"
                cp "$backup_dir/$package/package-lock.json" "packages/$package/package-lock.json"
              done
              rm -rf "$backup_dir"
            }

            restore_on_error() {
              local status=$?
              restore
              exit "$status"
            }

            restore_on_signal() {
              restore
              exit 1
            }

            for package in "''${packages[@]}"; do
              mkdir -p "$backup_dir/$package"
              cp "packages/$package/package.nix" "$backup_dir/$package/package.nix"
              cp "packages/$package/package-lock.json" "$backup_dir/$package/package-lock.json"
            done

            trap restore_on_error ERR
            trap restore_on_signal INT TERM

            for package in "''${packages[@]}"; do
              package_file="packages/$package/package.nix"
              nix-update "$package" \
                --flake \
                --src-only \
                --override-filename "$package_file"

              version="$(nix eval --raw ".#$package.version")"
              package_work="$backup_dir/work/$package"
              mkdir -p "$package_work"
              archive="$(npm pack "$package@$version" --silent --pack-destination "$package_work")"
              tar -xzf "$package_work/$archive" -C "$package_work"
              jq 'del(.devDependencies)' "$package_work/package/package.json" > "$package_work/package/package.json.tmp"
              mv "$package_work/package/package.json.tmp" "$package_work/package/package.json"
              (
                cd "$package_work/package"
                npm install \
                  --package-lock-only \
                  --ignore-scripts \
                  --legacy-peer-deps \
                  --no-audit \
                  --no-fund
              )
              cp "$package_work/package/package-lock.json" "packages/$package/package-lock.json"

              nix-update "$package" \
                --flake \
                --version=skip \
                --no-src \
                --build \
                --override-filename "$package_file"
            done

            trap - ERR INT TERM
            rm -rf "$backup_dir"
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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          piPackages = nixpkgs.lib.genAttrs piPackageNames (
            name: pkgs.callPackage (./packages + "/${name}/package.nix") { }
          );
          piPackageUpdater = mkPiPackageUpdater pkgs;
          traitor = mkTraitorPackage pkgs;
        in
        piPackages
        // {
          inherit traitor;
          pi-package-updater = piPackageUpdater;
          default = traitor;
        }
      );

      apps = forAllSystems (system: {
        traitor = {
          type = "app";
          program = "${self.packages.${system}.traitor}/bin/traitor";
        };
        update-pi-packages = {
          type = "app";
          program = "${self.packages.${system}.pi-package-updater}/bin/update-pi-packages";
        };
        default = self.apps.${system}.traitor;
      });

      formatter = forAllSystems (system: treefmtEval.${system}.config.build.wrapper);

      checks = forAllSystems (system: {
        quality = treefmtEval.${system}.config.build.check self;
      });

      homeManagerModules =
        let
          withDotfilesInputs = module: extraImports: { ... }: {
            # Keep the embedding flake's generic `inputs` argument intact. Cobb
            # passes its own inputs through Home Manager extraSpecialArgs.
            _module.args.dotfilesInputs = inputs;
            imports = [ module ] ++ extraImports;
          };
        in
        {
          live-symlinks = withDotfilesInputs ./modules/home/live-symlinks.nix [ ];
          cobb-daniel = withDotfilesInputs ./profiles/home/cobb-daniel.nix [ ];
        };

      hatchiCommissioning = import ./hosts/srv-hatchi/commissioning.nix;
      deploy = {
        autoRollback = true;
        magicRollback = true;
        sshOpts = [
          "-o"
          "StrictHostKeyChecking=yes"
        ];
        nodes = {
          srv-nana = {
            hostname = self.nixosConfigurations.srv-nana.config.networking.hostName;
            sshUser = self.nixosConfigurations.srv-nana.config.my.host.userName;
            interactiveSudo = true;
            profiles.system = {
              user = "root";
              path =
                let
                  native = inputs.deploy-rs.lib.${linuxSystem}.activate.nixos self.nixosConfigurations.srv-nana;
                  activate = ''
                    if [[ "$(< /etc/hostname)" != srv-nana ]]; then
                      echo "srv-nana hostname mismatch; activation denied" >&2
                      exit 1
                    fi
                    exec ${native}/deploy-rs-activate
                  '';
                in
                (
                  inputs.deploy-rs.lib.${linuxSystem}.activate.custom
                  // {
                    dryActivate = activate;
                    boot = activate;
                    test = activate;
                  }
                )
                  self.nixosConfigurations.srv-nana.config.system.build.toplevel
                  activate;
            };
          };
          srv-hatchi = {
            hostname = "uncommissioned.invalid";
            profiles.system = {
              user = "root";
              path =
                let
                  refuse = ''echo "srv-hatchi is uncommissioned; activation denied" >&2; exit 1'';
                in
                (
                  inputs.deploy-rs.lib.${linuxSystem}.activate.custom
                  // {
                    dryActivate = refuse;
                    boot = refuse;
                    test = refuse;
                  }
                )
                  self.nixosConfigurations.srv-hatchi.config.system.build.toplevel
                  refuse;
            };
          };
        };
      };
      nixosModules = {
        srv-hatchi = import ./hosts/srv-hatchi;
        srv-hatchi-bootstrap = import ./hosts/srv-hatchi/bootstrap.nix;
      };
      nixosConfigurations.srv-hatchi-bootstrap = nixpkgs.lib.nixosSystem {
        system = linuxSystem;
        specialArgs = { inherit inputs; };
        modules = [
          self.nixosModules.srv-hatchi-bootstrap
          ./tests/srv-hatchi/fixtures/reference-platform.nix
        ];
      };
      nixosConfigurations.srv-hatchi = nixpkgs.lib.nixosSystem {
        system = linuxSystem;
        specialArgs = { inherit inputs; };
        modules = [
          self.nixosModules.srv-hatchi
          ./tests/srv-hatchi/fixtures/reference-platform.nix
        ];
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
