{
  lib,
  stdenv,
  fetchurl,
}:

let
  version = "1.0.2";

  targets = {
    aarch64-darwin = {
      binary = "agent-desktop-darwin-arm64";
      helper = "agent-desktop-macos-helper-darwin-arm64";
      helperName = "agent-desktop-macos-helper";
    };
    x86_64-darwin = {
      binary = "agent-desktop-darwin-x64";
      helper = "agent-desktop-macos-helper-darwin-x64";
      helperName = "agent-desktop-macos-helper";
    };
    aarch64-linux = {
      binary = "agent-desktop-linux-arm64";
      helper = "agent-desktop-linux-clipboard-owner-linux-arm64";
      helperName = "agent-desktop-linux-clipboard-owner";
    };
    x86_64-linux = {
      binary = "agent-desktop-linux-x64";
      helper = "agent-desktop-linux-clipboard-owner-linux-x64";
      helperName = "agent-desktop-linux-clipboard-owner";
    };
  };

  target =
    targets.${stdenv.hostPlatform.system}
      or (throw "agent-desktop has no prebuilt binary for ${stdenv.hostPlatform.system}");
in
stdenv.mkDerivation {
  pname = "agent-desktop";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/agent-desktop/-/agent-desktop-${version}.tgz";
    hash = "sha256-aiu8wb2iz5KiPlJnWtfKPzb9jLKsZJzQE2G/yLOCCyg=";
  };

  sourceRoot = "package";

  dontConfigure = true;
  dontBuild = true;
  # Upstream ships ad hoc signed binaries; stripping would invalidate the signature.
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    install -Dm755 bin/${target.binary} "$out/bin/agent-desktop"
    install -Dm755 bin/${target.helper} "$out/bin/${target.helperName}"

    runHook postInstall
  '';

  meta = {
    description = "Computer use for AI agents: observe and operate desktop apps through the accessibility tree";
    homepage = "https://github.com/vercel-labs/agent-desktop";
    license = lib.licenses.asl20;
    mainProgram = "agent-desktop";
    platforms = lib.attrNames targets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
