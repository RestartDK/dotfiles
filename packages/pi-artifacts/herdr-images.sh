#!/usr/bin/env bash
if [ "${HERDR_ENV:-}" = 1 ] && [ -t 0 ] && [ -t 1 ] &&
  [ -z "${PI_IMAGE_PROTOCOL+x}" ] && [ -z "${TMUX:-}${STY:-}${ZELLIJ:-}" ]; then
  case "${TERM:-}" in
  dumb | screen* | tmux*) ;;
  *) export PI_IMAGE_PROTOCOL=kitty ;;
  esac
fi
