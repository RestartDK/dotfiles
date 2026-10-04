# Tailnet DNS for the homelab

Machines outside the home LAN reach homelab services by name through
Tailscale. The design splits resolution from reachability, so each half has
one owner and neither depends on the other's machinery.

## The contract

- Tailnet split-DNS maps `*.chateauducipieres.com` to AdGuard over the
  tailnet: `100.85.39.42:53` (tailnet DNS store, reconciled by `tailnet-dns`).
- AdGuard answers with the wildcard rewrite configured in
  `hosts/srv-hatchi/edge.nix`: `192.168.200.70` (the LAN address).
- Tailscale reaches that LAN address through the advertised route
  `192.168.200.70/32` (`edge.nix` `extraSetFlags`), with `tailscale0` open on
  53, 80 and 443.
- Certificate issuance deliberately does not depend on any of this: the ACME
  `dnsResolver` is pinned to `1.1.1.1:53` (`edge.nix`), so a tailnet DNS
  outage cannot hold up certs the way it once did.
- The last two points are pinned by assertions in
  `tests/srv-hatchi/policy.nix`.

Both historical failure modes are closed by design: the resolver path no
longer feeds ACME, and the DNS answer always pairs with an advertised route.

## Applying the split-DNS mapping

The mapping lives in the Tailscale admin store, not in this repository. The
flake app reconciles it idempotently:

```sh
TS_API_KEY="$(op read 'op://Developer/Tailscale homelab api key/credential')" \
  nix run .#tailnet-dns
```

`TS_TAILNET` overrides the tailnet (default `tail33ee33.ts.net`). The desired
mapping is declared in `packages/tailnet-dns/default.nix`.

## Client flags

- NixOS hosts: `services.tailscale.acceptDns` and `acceptRoutes` (module in
  `modules/nixos/tailscale.nix`; `acceptRoutes` defaults true).
- macOS: Tailscale GUI installs accept neither by default. The darwin module
  `modules/darwin/tailscale.nix` runs `tailscale set --accept-routes=true
  --accept-dns=true` on every activation; existing GUI installs before this
  module get the flags set once by hand.

## Verifying

```sh
dig @100.100.100.100 mangy.chateauducipieres.com   # -> 192.168.200.70
curl -fsS https://mangy.chateauducipieres.com/    # -> 200 through the route
```