{
  pkgs,
  ...
}:

let
  runnerName = "hatchi-deploy";
  runnerUser = "github-runner";
  runnerDir = "/srv/gh-runner/${runnerName}";
  tokenFile = "/var/lib/gh-runner/token";
  cacheKeyDir = "/var/lib/nix-cache";
in
{
  nix.settings = {
    secret-key-files = [ "${cacheKeyDir}/secret" ];
    trusted-users = [
      "root"
      "deploy"
    ];
  };

  users.groups.${runnerUser} = { };

  users.users.${runnerUser} = {
    isSystemUser = true;
    group = runnerUser;
    home = runnerDir;
  };

  systemd.tmpfiles.rules = [
    "d ${cacheKeyDir} 0700 root root -"
    "d /var/lib/gh-runner 0750 ${runnerUser} ${runnerUser} -"
    "d ${runnerDir} 0755 ${runnerUser} ${runnerUser} -"
    "f ${tokenFile} 0640 ${runnerUser} ${runnerUser} -"
  ];

  services.github-runners.${runnerName} = {
    enable = true;
    name = runnerName;
    url = "https://github.com/RestartDK/dotfiles";
    inherit tokenFile;
    user = runnerUser;
    group = runnerUser;
    extraLabels = [
      "lan-deploy"
      "lan-ci"
    ];
    replace = true;
    ephemeral = true;
    workDir = runnerDir;
    extraPackages = with pkgs; [
      coreutils
      git
      jq
      nix
      openssh
    ];
    serviceOverrides = {
      MemoryMax = "12G";
      CPUQuota = "400%";
    };
  };
}
