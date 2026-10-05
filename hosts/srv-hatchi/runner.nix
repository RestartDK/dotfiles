{
  config,
  lib,
  pkgs,
  ...
}:

let
  runnerName = "hatchi-deploy";
  runnerUser = "github-runner";
  runnerDir = "/srv/gh-runner/${runnerName}";
  tokenFile = "/var/lib/gh-runner/token";
  cacheKeyDir = "/var/lib/nix-cache";
  accessTokensFile = "/etc/nix/runner-access-tokens.conf";
  accessTokensTemplate = pkgs.writeText "runner-access-tokens.conf" ''
    access-tokens = github.com=@runner-access-token@
  '';
  runnerAccessToken = config.my.hatchi.onepassword.references.runnerAccessToken;
in
{
  nix.settings = {
    secret-key-files = [ "${cacheKeyDir}/secret" ];
    trusted-users = [
      "root"
      "deploy"
    ];
  };

  # The runner evaluates this flake, and the flake reads a private input, so the
  # runner needs a read-only token for dotfiles-private. It cannot live in
  # nix.settings, because NixOS regenerates nix.conf on every activation.
  #
  # !include rather than include: include treats a missing file as an error, so
  # a host that lost the file could not run nix at all, including the rebuild
  # that would restore it. An unreadable file is skipped silently, which keeps
  # the token readable only by root and the runner.
  nix.extraOptions = "!include ${accessTokensFile}";

  systemd.services.hatchi-runner-credential = lib.mkIf (runnerAccessToken != null) {
    description = "Render the CI runner's access token for private flake inputs";
    wantedBy = [ "multi-user.target" ];
    requires = [ "opnix-secrets.service" ];
    after = [ "opnix-secrets.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      UMask = "0077";
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadWritePaths = [ "/etc/nix" ];
      NoNewPrivileges = true;
    };
    script = ''
      ${pkgs.coreutils}/bin/test -s ${config.services.onepassword-secrets.secretPaths.runnerAccessToken}
      ${pkgs.coreutils}/bin/install -d -m755 /etc/nix
      ${pkgs.coreutils}/bin/install -m600 ${accessTokensTemplate} ${accessTokensFile}
      ${pkgs.replace-secret}/bin/replace-secret '@runner-access-token@' ${config.services.onepassword-secrets.secretPaths.runnerAccessToken} ${accessTokensFile}
      ${pkgs.coreutils}/bin/chown root:${runnerUser} ${accessTokensFile}
      ${pkgs.coreutils}/bin/chmod 640 ${accessTokensFile}
    '';
  };

  # The runner deploys this host, so its own unit must survive the activation it
  # triggers. restartIfChanged=false puts it in switch-to-configuration's skip
  # list, so a deploy that edits this file no longer stops the runner mid-job and
  # rolls itself back. The ephemeral runner restarts with the new definition once
  # the current job ends.
  systemd.services."github-runner-${runnerName}".restartIfChanged = false;

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
      after = [ "hatchi-runner-credential.service" ];
      requires = [ "hatchi-runner-credential.service" ];
    };
  };
}
