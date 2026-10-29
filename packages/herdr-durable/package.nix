{
  lib,
  upstream,
  dstack ? null,
  makeWrapper,
}:

assert upstream.version == "0.9.5";
upstream.overrideAttrs (old: {
  patches = (old.patches or [ ]) ++ [ ./host.patch ];
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ lib.optional (dstack != null) makeWrapper;
  postInstall =
    (old.postInstall or "")
    + lib.optionalString (dstack != null) ''
      wrapProgram "$out/bin/herdr" \
        --set-default HERDR_DURABLE_HOST_EXECUTABLE ${dstack}/bin/dstack-host
    '';
})
