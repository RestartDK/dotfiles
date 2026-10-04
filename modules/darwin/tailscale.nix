{ ... }:
{
  # Tailscale GUI installs do not accept advertised subnet routes by default.
  # The homelab resolves *.chateauducipieres.com to the LAN address and
  # reaches it over the tailnet through the advertised route, so every
  # machine that leaves the LAN needs both flags. Idempotent; harmless when
  # tailscaled is not running yet (activation runs again on the next build).
  system.activationScripts.tailscale-routes.text = ''
    /Applications/Tailscale.app/Contents/MacOS/Tailscale set --accept-routes=true --accept-dns=true 2>/dev/null \
      || tailscale set --accept-routes=true --accept-dns=true 2>/dev/null \
      || true
  '';
}
