{ config, lib, ... }:

let
  cfg = config.my.host;
in
{
  options.my.host = {
    hostName = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "srv-nana";
      description = "Host name to set through networking.hostName. Leave null to let another module set it.";
    };

    userName = lib.mkOption {
      type = lib.types.str;
      default = "dkumlin";
      example = "daniel";
      description = "Primary interactive user managed by the shared NixOS modules.";
    };

    uid = lib.mkOption {
      type = lib.types.nullOr lib.types.int;
      default = null;
      example = 1000;
      description = "Optional fixed UID for the primary user. Null lets NixOS keep/allocate the UID.";
    };

    homeDirectory = lib.mkOption {
      type = lib.types.str;
      default = "/home/${cfg.userName}";
      example = "/home/daniel";
      description = "Home directory for the primary user.";
    };

    fullName = lib.mkOption {
      type = lib.types.str;
      default = cfg.userName;
      description = "GECOS/full name for the primary user. The private input supplies the real name.";
    };

    extraGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "wheel"
        "networkmanager"
        "docker"
      ];
      description = "Supplementary groups for the primary user.";
    };

    authorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "SSH public keys authorized for the primary user. The private input supplies them.";
    };

    rootAuthorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "SSH public keys authorized for root break-glass access. The private input supplies them.";
    };
  };

  config = lib.mkIf (cfg.hostName != null) {
    networking.hostName = lib.mkDefault cfg.hostName;
  };
}
