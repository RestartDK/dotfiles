{
  pkgs,
  domain,
  nameserver,
}:
pkgs.writeShellApplication {
  name = "tailnet-dns";
  runtimeInputs = [
    pkgs.curl
    pkgs.jq
  ];
  text = ''
    set -euo pipefail

    : "''${TS_API_KEY:?set TS_API_KEY to a tailnet admin API key}"
    tailnet="''${TS_TAILNET:-tail33ee33.ts.net}"
    mapping='{"${domain}":["${nameserver}"]}'

    current=$(
      curl -fsS \
        -H "Authorization: Bearer $TS_API_KEY" \
        "https://api.tailscale.com/api/v2/tailnet/$tailnet/dns/split-dns" \
        || echo null
    )
    if [ "$current" != "$mapping" ]; then
      echo "updating split-dns: $current -> $mapping"
      curl -fsS -X PUT \
        -H "Authorization: Bearer $TS_API_KEY" \
        -d "$mapping" \
        "https://api.tailscale.com/api/v2/tailnet/$tailnet/dns/split-dns" >/dev/null
    else
      echo "split-dns already correct"
    fi
  '';
}
