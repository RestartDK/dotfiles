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
      default = "Daniel Kumlin";
      description = "GECOS/full name for the primary user.";
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
      default = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGAxMdKa0tzi0uq+OhhWQslqaK5Jjnb7XFvnzlf83DQD danielkumlinwork@gmail.com"
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINP2i4TskZfwyLSApLt8FziTHNyO3/XMrCIndXWSQ04E dkumlin@192.168.200.182"
      ];
      description = "SSH public keys authorized for the primary user.";
    };

    rootAuthorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGAxMdKa0tzi0uq+OhhWQslqaK5Jjnb7XFvnzlf83DQD danielkumlinwork@gmail.com"
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCoxPQY9dhr7Xkq0Cwe6NO51EdYbFYTXVQwqtso75jq2PbKqeExh7+NWLQnI0JzxutczGzYGy6MSWnoQ2Ztaxzfsno6rrdsuxnI5PZCOKUn0ymC/gEBRMLfW0xKOGOgY+34k55L8kbVO0nvVYm79VoYqGo3m3htesff8cW9dLFwMqGjC3541BGCSeXTStMkFEARznInpIlmauwrsnB6x9xI10dy5fbGM4+74hk6wnAGHNzn3EgFiIRwvC+EyGnxTY89OPskKE6MBANRZJoUeOj2gPHqi1qimgyf9Z680G24Uflw9wZ2nDFxjpixb8J38efZNV1n0XqJT0IjnedNUOjIXb/6BzGycOSXR2X4X6OuMZ9iYx29sUHS3jO5SVbKPDFuf1om70oSVRLmXRK+s9ff4xzRh5S+IAg9mJ1aq5tZ8Tpx+o8mChJhb7nLNA2e7DdcgwfaoyDtVsxCtXdjqD57YNjHohSIHFfb/hFEtm2CVDGrqYL3VC+29U+Y28m80HsbCqDQG7004d7jx2+9ljoMn0Hz/aggltafe9hP0+Pe4bRqqU8btW9GVkQGdntc1otDEWgc1djaRj5/fvH1NbA/F3Dpgo6ljVMPapsNPAcc1cCAHr87XiPTHBj2HCzIGES6R9gz+HL8KjPtKrGkFmiVh9IpNHbylKDwL138dhKdfQ== root@192.168.200.182"
      ];
      description = "SSH public keys authorized for root break-glass access.";
    };
  };

  config = lib.mkIf (cfg.hostName != null) {
    networking.hostName = lib.mkDefault cfg.hostName;
  };
}
