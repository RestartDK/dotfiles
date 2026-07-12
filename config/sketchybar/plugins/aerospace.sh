#!/usr/bin/env bash
source "$CONFIG_DIR/colors.sh"

FOCUSED_WORKSPACE=$(aerospace list-workspaces --focused --format "%{workspace}")

# Get apps in this workspace and convert to icons
icons=""
APPS_INFO=$(aerospace list-windows --workspace "$1" --json --format "%{app-name}")
for app_name in $(echo "$APPS_INFO" | jq -r "map(.\"app-name\") | .[]"); do
  icons+=$("$CONFIG_DIR/plugins/icon_map_fn.sh" "$app_name")
  icons+=" "
done

# Update the workspace item
if [ "$1" = "$FOCUSED_WORKSPACE" ]; then
    sketchybar --set "$NAME" \
        label="$icons" \
        background.drawing=on \
        background.color="$ACCENT_COLOR" \
        label.color="$BACKGROUND"
else
    sketchybar --set "$NAME" \
        label="$icons" \
        background.drawing=off \
        label.color="$ACCENT_COLOR"
fi