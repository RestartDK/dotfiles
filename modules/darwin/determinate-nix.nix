{ inputs, ... }:

{
  imports = [ inputs.determinate.darwinModules.default ];

  determinateNix = {
    enable = true;
    customSettings = {
      extra-substituters = [ "https://cache.numtide.com" ];
      extra-trusted-public-keys = [
        "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
      ];
    };
  };
}
