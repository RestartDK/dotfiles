{ pkgs, domain }:
let
  baseline = (pkgs.formats.ini { }).generate "qbittorrent-baseline.conf" {
    LegalNotice.Accepted = true;
    Preferences = {
      "WebUI\\Address" = "127.0.0.1";
      "WebUI\\Username" = "daniel";
      "WebUI\\ServerDomains" = "qbittorrent.${domain}";
      "WebUI\\LocalHostAuth" = true;
      "WebUI\\AuthSubnetWhitelistEnabled" = false;
      "WebUI\\CSRFProtection" = true;
      "WebUI\\HostHeaderValidation" = true;
    };
    BitTorrent."Session\\DefaultSavePath" = "/srv/media/downloads";
  };
in
pkgs.writeShellApplication {
  name = "hatchi-qbittorrent-config";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.gawk
    pkgs.jq
  ];
  text = ''
    config=$1
    password=$(jq -ern --rawfile password "$CREDENTIALS_DIRECTORY/password" '
      $password | rtrimstr("\n") |
      select(test("^@ByteArray\\([A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}\\)\\z"))')
    encoded=''${password#@ByteArray(}
    encoded=''${encoded%)}
    salt=$(printf %s "''${encoded%%:*}" | base64 --decode | wc -c)
    key=$(printf %s "''${encoded#*:}" | base64 --decode | wc -c)
    if (( salt < 16 || key != 64 )); then
      echo "Invalid qBittorrent credential lengths" >&2
      exit 1
    fi
    umask 077
    staged=$(mktemp "$config.XXXXXX")
    trap 'rm -f "$staged"' EXIT
    existing=/dev/null
    if test -f "$config"; then existing=$config; fi
    export password
    awk '
      function flush( key, parts) {
        for (key in values) {
          split(key, parts, SUBSEP)
          if (parts[1] == section && !(key in written)) {
            print parts[2] "=" values[key]
            written[key] = 1
          }
        }
      }
      BEGIN { values["Preferences", "WebUI\\Password_PBKDF2"] = ENVIRON["password"] }
      { sub(/\r$/, "") }
      ENDFILE { if (ARGIND == 1) section = "" }
      /^\[/ {
        if (ARGIND == 2) flush()
        section = substr($0, 2, length($0) - 2)
        if (ARGIND == 2) { sections[section] = 1; print }
        next
      }
      {
        separator = index($0, "=")
        key = substr($0, 1, separator - 1)
        gsub(/^[ \t]+|[ \t]+$/, "", key)
        if (ARGIND == 1 && separator) { values[section, key] = substr($0, separator + 1); next }
        if (ARGIND == 2) {
          if (separator && (section, key) in values) {
            if (!((section, key) in written)) print key "=" values[section, key]
            written[section, key] = 1
          } else print
        }
      }
      END {
        flush()
        for (key in values) {
          split(key, parts, SUBSEP)
          section = parts[1]
          if (!(section in sections)) { print "[" section "]"; flush(); sections[section] = 1 }
        }
      }
    ' ${baseline} "$existing" > "$staged"
    mv -f "$staged" "$config"
  '';
}
