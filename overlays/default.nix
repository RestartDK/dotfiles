{ inputs }:
final: _prev: {
  terminal-browser = final.callPackage ../packages/terminal-browser {
    terminalBrowser = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system}.terminal-browser;
  };
}
