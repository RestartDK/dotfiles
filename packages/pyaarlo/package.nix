{
  buildPythonPackage,
  click,
  cloudscraper,
  cryptography,
  curl-cffi,
  fetchPypi,
  paho-mqtt,
  pycryptodome,
  python-slugify,
  requests,
  unidecode,
}:

buildPythonPackage rec {
  pname = "pyaarlo";
  version = "0.8.0.23";
  format = "setuptools";

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-sWS/kcAI8fp7kcMk8IFpMRruEXgriSmmPJG3oO4zzfE=";
  };

  dependencies = [
    click
    cloudscraper
    cryptography
    curl-cffi
    paho-mqtt
    pycryptodome
    python-slugify
    requests
    unidecode
  ];

  doCheck = false;

  meta = {
    description = "Python module for interacting with Netgear Arlo cameras";
    homepage = "https://github.com/twrecked/pyaarlo";
  };
}
