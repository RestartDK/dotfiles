{ config, pkgs, ... }:

{
  # Nana has an NVIDIA GeForce RTX 3080. Use the proprietary NVIDIA stack
  # with open kernel modules and enable CDI generation for Docker GPU access.
  services.xserver.videoDrivers = [ "nvidia" ];

  hardware.graphics = {
    enable = true;
    enable32Bit = true;
  };

  hardware.nvidia = {
    modesetting.enable = true;
    open = true;
    nvidiaSettings = true;
    package = config.boot.kernelPackages.nvidiaPackages.stable;
  };

  hardware.nvidia-container-toolkit.enable = true;

  environment.systemPackages = with pkgs; [
    nvtopPackages.nvidia
  ];
}
