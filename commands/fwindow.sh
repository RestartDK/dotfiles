#!/bin/bash

## Raycast Script Command Template
#
# Duplicate this file and remove ".template" from the filename to get started.
# See full documentation here: https://github.com/raycast/script-commands
#
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Remove ghost windows
# @raycast.mode fullOutput
# @raycast.packageName Raycast Scripts
#
# Optional parameters:
# @raycast.icon 🪟
# @raycast.currentDirectoryPath ~
# @raycast.needsConfirmation false
#
# Documentation:
# @raycast.description This script is meant to find and close ghost windows which hopefully will be fixed soon from aeorspace
# @raycast.author Daniel Kumlin

ghost_window_ids=$(aerospace list-windows --all | grep -e '.*|.*| $' | awk '{print $1}')

for id in $ghost_window_ids ; do
    aerospace close --window-id "$id"
done
