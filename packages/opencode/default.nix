{
  linkFarm,
  opencode2,
}:
# llm-agents installs OpenCode v2 as `opencode2` so it can coexist with v1.
# Publish it under the v1 binary name, which every caller here already uses.
linkFarm "opencode-${opencode2.version}" [
  {
    name = "bin/opencode";
    path = "${opencode2}/bin/opencode2";
  }
]
