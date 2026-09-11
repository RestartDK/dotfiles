{ pkgs }:
pkgs.writeShellApplication {
  name = "hatchi-adguard-credentials";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.jq
    pkgs.yq-go
  ];
  text = ''
    config=$1
    users=$(yq -o=json '.' "$CREDENTIALS_DIRECTORY/users" | jq -ce '
      .users | select(type == "array" and length > 0 and all(.[];
        type == "object" and keys == ["name", "password"] and
        (.name | type == "string" and length > 0) and
        (.password | type == "string" and test("^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}\\z"))))')
    umask 077
    staged=$(mktemp "$config.XXXXXX")
    trap 'rm -f "$staged"' EXIT
    export users
    yq '.users = (strenv(users) | from_json)' "$config" > "$staged"
    mv -f "$staged" "$config"
  '';
}
