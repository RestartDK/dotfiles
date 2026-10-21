{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  lib,
}:

buildHomeAssistantComponent rec {
  owner = "AlexxIT";
  domain = "sonoff";
  version = "3.13.1";

  src = fetchFromGitHub {
    owner = "AlexxIT";
    repo = "SonoffLAN";
    tag = "v${version}";
    hash = "sha256-ECQKv2WZ8/2+trmfg6fFFNhwkEWIwBzEWIJSpoFm5aM=";
  };

  meta = {
    changelog = "https://github.com/AlexxIT/SonoffLAN/releases/tag/v${version}";
    description = "Control Sonoff and eWeLink devices from Home Assistant";
    homepage = "https://github.com/AlexxIT/SonoffLAN";
    license = lib.licenses.mit;
  };
}
