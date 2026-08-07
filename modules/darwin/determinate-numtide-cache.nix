{ ... }:

{
  # Determinate Nix owns /etc/nix/nix.conf and includes this supported
  # user-managed file. Trust Numtide's cache for llm-agents.nix outputs.
  environment.etc."nix/nix.custom.conf".text = ''
    extra-substituters = https://cache.numtide.com
    extra-trusted-public-keys = niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=
  '';
}
