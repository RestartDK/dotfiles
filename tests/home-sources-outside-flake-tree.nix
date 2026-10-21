{
  pkgs,
  self,
}:
let
  inherit (pkgs) lib;

  plain = value: builtins.unsafeDiscardStringContext (toString value);

  # Interpolating the flake root into a string copies the tree to a store path
  # whose name embeds the tree's own store basename. Reproduce that copy so the
  # comparison below sees exactly what the broken pattern produces.
  flakeTreeCopy = builtins.unsafeDiscardStringContext "${(/. + (plain self.outPath))}";

  fileSets = [
    {
      name = "home.file";
      files = user: user.home.file or { };
    }
    {
      name = "xdg.configFile";
      files = user: user.xdg.configFile or { };
    }
  ];

  offendersIn =
    hostName: userName: fileSet: user:
    let
      files = fileSet.files user;
    in
    lib.concatMap (
      target:
      let
        source = files.${target}.source or null;
      in
      lib.optional (source != null && lib.hasPrefix flakeTreeCopy (plain source)) {
        fileSet = fileSet.name;
        inherit hostName userName target;
        source = plain source;
      }
    ) (lib.attrNames files);

  offendersInHost =
    hostName:
    let
      users = self.nixosConfigurations.${hostName}.config.home-manager.users or { };
    in
    lib.concatMap (
      userName: lib.concatMap (fileSet: offendersIn hostName userName fileSet users.${userName}) fileSets
    ) (lib.attrNames users);

  offenders = lib.concatMap offendersInHost [
    "srv-nana"
    "srv-hatchi"
  ];

  describe =
    offender:
    "${offender.hostName} links ${offender.fileSet}.\"${offender.target}\" from ${offender.source}";
in
if offenders != [ ] then
  throw ''
    Home-manager file sources must not resolve inside the flake tree, because
    that makes the whole tree an input to the host derivation and uncaches it on
    every commit. Copy each referenced config path to its own store path:
    ${lib.concatMapStringsSep "\n" describe offenders}
  ''
else
  pkgs.runCommand "home-sources-outside-flake-tree" { } ''
    touch $out
  ''
