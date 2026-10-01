{
  pkgs,
  self,
  inputs,
}:
let
  macHome = name: self.darwinConfigurations.${name}.config.home-manager.users.danielkumlin;
  cobb =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      extraSpecialArgs.osConfig.networking.hostName = "titan";
      modules = [
        self.homeManagerModules.cobb-daniel
        {
          home = {
            username = "daniel";
            homeDirectory = "/home/daniel";
            stateVersion = "26.05";
          };
        }
      ];
    }).config;
  piAiStub = pkgs.runCommand "pi-ai-resolution-stub" { } ''
    mkdir -p $out/node_modules/@earendil-works/pi-ai
    cat > $out/node_modules/@earendil-works/pi-ai/package.json <<'EOF'
    { "name": "@earendil-works/pi-ai", "version": "0.0.0", "type": "module", "main": "index.js" }
    EOF
    cat > $out/node_modules/@earendil-works/pi-ai/index.js <<'EOF'
    export function clampThinkingLevel() {
      throw new Error("pi-ai is a resolution stub in the agent-profiles check");
    }
    EOF
  '';
  piCodingAgentStub = pkgs.runCommand "pi-coding-agent-resolution-stub" { } ''
    mkdir -p $out/node_modules/@earendil-works/pi-coding-agent
    cat > $out/node_modules/@earendil-works/pi-coding-agent/package.json <<'EOF'
    { "name": "@earendil-works/pi-coding-agent", "version": "0.0.0", "type": "module", "main": "index.js" }
    EOF
    cat > $out/node_modules/@earendil-works/pi-coding-agent/index.js <<'EOF'
    export const CONFIG_DIR_NAME = ".pi";
    export function DefaultResourceLoader() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function ModelRuntime() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function SessionManager() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function SettingsManager() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function createAgentSession() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function createCodemodeExtension() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function getAgentDir() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function keyHint() { throw new Error("pi-coding-agent is a resolution stub"); }
    export function parseFrontmatter() { throw new Error("pi-coding-agent is a resolution stub"); }
    EOF
  '';
  owners = [
    {
      home = macHome "dkumlin-macbook-pro";
      profile = "personal";
      system = "aarch64-darwin";
      skillsPath = "config/agents/skills";
      claude = true;
    }
    {
      home = macHome "dkumlin-twin-macbook-pro";
      profile = "personal";
      system = "aarch64-darwin";
      skillsPath = "config/agents/skills";
      claude = true;
    }
    {
      home = self.homeConfigurations.twin.config;
      profile = "work";
      system = "x86_64-linux";
      skillsPath = "config/pi/agent/skills-twin";
      claude = false;
    }
    {
      home = cobb;
      profile = "work";
      system = "x86_64-linux";
      skillsPath = "config/agents/skills";
      claude = false;
    }
  ];
in
assert builtins.all (
  {
    claude,
    home,
    profile,
    skillsPath,
    system,
  }:
  home.my.ai.profile == profile
  &&
    home.xdg.configFile."dstack/models.json".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/model-profiles/${profile}.json"
  &&
    home.home.file.".agents/skills".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/${skillsPath}"
  &&
    home.home.file.".agents/agents".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/agents"
  && (home.home.file ? ".claude/skills") == claude
  && !(home.home.file ? ".pi/agent/skills")
  && !(home.home.file ? ".codex/skills")
  && !(home.xdg.configFile ? "opencode/skills")
  && !(home.xdg.configFile ? "agents/skills")
  && !(home.xdg.configFile ? "agents/agents")
  &&
    home.home.file.".pi/agent/lib".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/pi/agent/lib"
  && builtins.any (
    package:
    package.drvPath == self.packages.${system}.pi.drvPath
    || pkgs.lib.hasInfix (builtins.unsafeDiscardStringContext "${self.packages.${system}.pi}/bin/pi") (
      package.text or ""
    )
  ) home.home.packages
  && !(home.home.file ? ".pi/agent/auth.json")
) owners;
pkgs.runCommand "agent-profile-tests"
  {
    nativeBuildInputs = [
      pkgs.bun
      self.packages.${pkgs.stdenv.hostPlatform.system}.pi
    ];
  }
  ''
    export HOME=$TMPDIR
    cp -R ${../config} $TMPDIR/config
    cp -R ${../tests} $TMPDIR/tests
    cp -R ${piAiStub}/node_modules $TMPDIR/
    chmod -R u+w $TMPDIR/node_modules
    cp -R ${piCodingAgentStub}/node_modules/@earendil-works/pi-coding-agent $TMPDIR/node_modules/@earendil-works/
    cd $TMPDIR
    bun test tests/agent-profiles
    touch $out
  ''
