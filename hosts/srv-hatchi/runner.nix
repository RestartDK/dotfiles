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
  # Hatchi is the binary cache the other hosts substitute from, so it signs
  # what it builds. Generate the key pair once, then declare the public half on
  # the consumers:
  #   nix-store --generate-binary-cache-key hatchi-cache-1 \
  #     /var/lib/nix-cache/secret /var/lib/nix-cache/public
  nix.settings = {
    secret-key-files = [ "${cacheKeyDir}/secret" ];
    trusted-users = [
      "root"
      "deploy"
    ];
  };

  systemd.tmpfiles.rules = [
    "d ${cacheKeyDir} 0700 root root -"
    "d /var/lib/gh-runner 0750 ${runnerUser} ${runnerUser} -"
    "d ${runnerDir} 0755 ${runnerUser} ${runnerUser} -"
    "f ${tokenFile} 0640 ${runnerUser} ${runnerUser} -"
  ];

  # The registration token is a fine-grained PAT with Administration read and
  # write on the repository, written into ${tokenFile} once. Ephemeral runners
  # re-register for every job, which a one hour registration token cannot do.
  services.github-runners.${runnerName} = {
    enable = true;
    name = runnerName;
    url = "https://github.com/RestartDK/dotfiles";
    tokenFile = tokenFile;
    extraLabels = [ "lan-deploy" ];
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
