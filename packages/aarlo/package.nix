{
  aiofiles,
  buildHomeAssistantComponent,
  fetchFromGitHub,
  pyaarlo,
  unidecode,
}:

buildHomeAssistantComponent rec {
  owner = "twrecked";
  domain = "aarlo";
  version = "0.8.1.23";

  src = fetchFromGitHub {
    owner = "twrecked";
    repo = "hass-aarlo";
    tag = "v${version}";
    hash = "sha256-O+FDdhw6pBAUYJKqUfOCWV08YKj/3M90hRu6h08Sy5Y=";
  };

  dependencies = [
    aiofiles
    pyaarlo
    unidecode
  ];

  meta = {
    changelog = "https://github.com/twrecked/hass-aarlo/releases/tag/v${version}";
    description = "Asynchronous Arlo component for Home Assistant";
    homepage = "https://github.com/twrecked/hass-aarlo";
  };
}
