{ inputs, network, ... }:

{
  imports = [ inputs.determinate.darwinModules.default ];

  determinateNix = {
    enable = true;
    customSettings = {
      extra-substituters = [
        "https://cache.${network.domain}"
        "https://cache.numtide.com"
      ];
      extra-trusted-public-keys = [
        "hatchi-cache-1:LrCQUUSFDL/+vRytC8mskDaygp91ALVrqAZ8jPwweJI="
        "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
      ];
    };
  };
}
