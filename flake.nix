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
    opnix.url = "github:brizzbuzz/opnix/0ea3a9e6a94fdd0c444aa7729b98e568a0588222";
    opnix.inputs.nixpkgs.follows = "nixpkgs";
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
      sshSettings = (import ./modules/home/ssh.nix { }).programs.ssh.settings;
      fleetInventory = {
        schemaVersion = 1;
        hosts = map (name: { inherit name; }) (
          builtins.attrNames (nixpkgs.lib.filterAttrs (_: settings: settings ? IdentityFile) sshSettings)
        );
      };
      mkFleetPackage =
        pkgs:
        pkgs.writeShellApplication {
          name = "fleet";
          runtimeInputs = [
            pkgs.coreutils
            pkgs.hostname
            pkgs.jq
            pkgs.nix
            pkgs.openssh
          ];
          text = builtins.readFile ./bin/fleet;
        };
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
      hatchiPkgsModule = {
        nixpkgs.pkgs = pkgsFor linuxSystem;
      };
      hatchiPhysicalPlatform = import ./hosts/srv-hatchi/physical-platform.nix { inherit inputs; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          piPackages = nixpkgs.lib.genAttrs piPackageNames (
            name: pkgs.callPackage (./packages + "/${name}/package.nix") { }
          );
          fleet = mkFleetPackage pkgs;
          piPackageUpdater = mkPiPackageUpdater pkgs;
          traitor = mkTraitorPackage pkgs;
        in
        piPackages
        // {
          inherit fleet traitor;
          deploy-rs = inputs.deploy-rs.packages.${system}.default;
          home-manager = inputs.home-manager.packages.${system}.default;
          nixos-anywhere = inputs.nixos-anywhere.packages.${system}.default;
          opnix = inputs.opnix.packages.${system}.default;
          pi-profiled = pkgs.callPackage ./packages/pi-profiled {
            upstream = inputs.llm-agents.packages.${system}.pi;
          };
          pi-package-updater = piPackageUpdater;
          default = traitor;
        }
      );

      apps = forAllSystems (system: {
        fleet = {
          type = "app";
          program = "${self.packages.${system}.fleet}/bin/fleet";
        };
        traitor = {
          type = "app";
          program = "${self.packages.${system}.traitor}/bin/traitor";
        };
        deploy-rs = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.deploy-rs;
        };
        home-manager = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.home-manager;
        };
        update-pi-packages = {
          type = "app";
          program = "${self.packages.${system}.pi-package-updater}/bin/update-pi-packages";
        };
        default = self.apps.${system}.traitor;
      });

      formatter = forAllSystems (system: treefmtEval.${system}.config.build.wrapper);

      checks = forAllSystems (
        system:
        {
          fleet =
            (pkgsFor system).runCommand "fleet-tests"
              {
                nativeBuildInputs = [
                  (pkgsFor system).bash
                  (pkgsFor system).coreutils
                  (pkgsFor system).jq
                ];
              }
              ''
                FLEET_BIN=${./bin/fleet} FLEET_TEST_BASH=${(pkgsFor system).bash}/bin/bash bash ${./tests/fleet.sh}
                touch $out
              '';
          watch-pr =
            (pkgsFor system).runCommand "watch-pr-tests"
              {
                nativeBuildInputs = [
                  (pkgsFor system).bash
                  (pkgsFor system).coreutils
                  (pkgsFor system).jq
                ];
              }
              ''
                WATCH_PR_BIN=${./config/agents/skills-personal/dstack/dstack-mode/scripts/watch-pr} bash ${./tests/watch-pr.sh}
                touch $out
              '';
          pi-no-offers =
            (pkgsFor system).runCommand "pi-no-offers-tests"
              {
                nativeBuildInputs = [ (pkgsFor system).bun ];
              }
              ''
                export HOME=$TMPDIR
                bun test ${./config/pi/agent/extensions/pi-no-offers}
                touch $out
              '';
          traitor-flake-tools =
            (pkgsFor system).runCommand "traitor-flake-tools"
              {
                nativeBuildInputs = [
                  self.packages.${system}.deploy-rs
                  self.packages.${system}.home-manager
                ];
              }
              ''
                deploy --version
                home-manager --version
                touch $out
              '';
          traitor-sync =
            (pkgsFor system).runCommand "traitor-sync-tests"
              {
                nativeBuildInputs = [
                  (pkgsFor system).bash
                  (pkgsFor system).coreutils
                  (pkgsFor system).git
                ]
                ++ nixpkgs.lib.optionals (pkgsFor system).stdenv.hostPlatform.isLinux [
                  (pkgsFor system).util-linux
                ];
              }
              ''
                TRAITOR=${./bin/traitor} bash ${./tests/traitor-sync.sh}
                touch $out
              '';
          agent-profiles = import ./tests/agent-profiles.nix {
            pkgs = pkgsFor system;
            inherit self inputs;
          };
          personal-secrets = import ./tests/personal-secrets.nix {
            pkgs = pkgsFor system;
            inherit self inputs;
          };
          quality = treefmtEval.${system}.config.build.check self;
          srv-hatchi-policy = import ./tests/srv-hatchi/policy.nix {
            pkgs = pkgsFor system;
            inherit self inputs;
          };
        }
        // nixpkgs.lib.optionalAttrs (system == linuxSystem) (
          nixpkgs.lib.concatMapAttrs (
            nodeName: node:
            nixpkgs.lib.mapAttrs' (
              checkName: check: nixpkgs.lib.nameValuePair "${nodeName}-${checkName}" check
            ) (inputs.deploy-rs.lib.${linuxSystem}.deployChecks (self.deploy // { nodes.${nodeName} = node; }))
          ) self.deploy.nodes
          // {
            srv-nana-policy = import ./tests/srv-nana/policy.nix {
              pkgs = pkgsFor system;
              inherit self;
            };
            srv-hatchi-services = import ./tests/srv-hatchi/services.nix {
              pkgs = pkgsFor system;
              inherit self inputs;
            };
            srv-hatchi-onepassword = import ./tests/srv-hatchi/onepassword.nix {
              pkgs = pkgsFor system;
              inherit self inputs;
            };
          }
        )
      );

      inherit fleetInventory;

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
            hostname = self.nixosConfigurations.srv-hatchi.config.networking.hostName;
            sshUser = self.nixosConfigurations.srv-hatchi.config.my.host.userName;
            interactiveSudo = true;
            profiles.system = {
              user = "root";
              path =
                let
                  native = inputs.deploy-rs.lib.${linuxSystem}.activate.nixos self.nixosConfigurations.srv-hatchi;
                  activate = ''
                    if [[ "$(< /etc/hostname)" != srv-hatchi ]]; then
                      echo "srv-hatchi hostname mismatch; activation denied" >&2
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
                  self.nixosConfigurations.srv-hatchi.config.system.build.toplevel
                  activate;
            };
          };
        };
      };
      nixosModules.srv-hatchi = import ./hosts/srv-hatchi;
      nixosConfigurations.srv-hatchi = nixpkgs.lib.nixosSystem {
        system = linuxSystem;
        specialArgs = { inherit inputs; };
        modules = [
          hatchiPkgsModule
          self.nixosModules.srv-hatchi
          hatchiPhysicalPlatform
          ./hosts/srv-hatchi/production.nix
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
