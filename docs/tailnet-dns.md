# Tailnet DNS for the homelab

Machines outside the home LAN reach homelab services by name through
Tailscale. The design splits resolution from reachability, so each half has
one owner and neither depends on the other's machinery.

## The contract

- Tailnet split-DNS maps *.<domain> to AdGuard over the tailnet at
  hatchi's tailnet address (tailnet DNS store, reconciled by `tailnet-dns`).
- AdGuard answers with the wildcard rewrite configured in
  `hosts/srv-hatchi/edge.nix`: hatchi's LAN address.
- Tailscale reaches that LAN address through the advertised route
  (hatchi's LAN address /32, `edge.nix` `extraSetFlags`), with `tailscale0`
  open on 53, 80 and 443.
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

`TS_TAILNET` overrides the tailnet (default: discovered from the local
tailscale). The desired mapping is declared in `packages/tailnet-dns`, fed
from the private values (domain and hatchi's tailnet address).

## Client flags

- NixOS hosts: `services.tailscale.acceptDns` and `acceptRoutes` (module in
  `modules/nixos/tailscale.nix`; `acceptRoutes` defaults true).
- macOS: Tailscale GUI installs accept neither by default. The darwin module
  `modules/darwin/tailscale.nix` runs `tailscale set --accept-routes=true
  --accept-dns=true` on every activation; existing GUI installs before this
  module get the flags set once by hand.

## Verifying

```sh
dig @100.100.100.100 mangy.<domain>   # -> hatchi's LAN address
curl -fsS https://mangy.<domain>/     # -> 200 through the route
```