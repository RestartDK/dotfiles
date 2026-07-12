# pi-ssh

`pi-ssh` transfers images from macOS Ghostty to Pi running on an SSH host. The image bytes travel through the terminal and are written to a mode-`0600` temporary file on the remote host, whose path is inserted into Pi's editor.

## Install on macOS

The shared nix-darwin configuration installs Hammerspoon and links `~/.hammerspoon/init.lua`.

```bash
cd ~/.config/dotfiles

# Personal Mac
darwin-rebuild switch --flake .#dkumlin-macbook-pro

# Or work Mac
darwin-rebuild switch --flake .#dkumlin-twin-macbook-pro
```

Then:

1. Open Hammerspoon once.
2. Grant Hammerspoon Accessibility permission in **System Settings → Privacy & Security → Accessibility**.
3. Reload Hammerspoon if it was already running.

## Development workflow

1. Open Ghostty on the Mac.
2. SSH to the development host normally.
3. Start Herdr, focus the pane where you want to work, and start `pi` in the project directory.
4. In an existing Pi process, run `/reload` once after installing or changing the extension.
5. Copy a screenshot or image on the Mac and press `Cmd+V` while the Pi pane is focused.
6. Optionally use `/pi-ssh` to request an image through OSC 5522 on a terminal that supports that protocol.
7. Add text around the inserted path and press Enter. Pi receives the remote path and reads it as an image attachment.

Text on the clipboard continues to paste normally with `Cmd+V`. Herdr parses and forwards the Hammerspoon bracketed-paste marker to its focused pane, where `pi-ssh` consumes it. The bridge deliberately keys off the Ghostty application instead of Pi's terminal title because Herdr owns the outer terminal and does not forward a pane's title to Ghostty.

The focused Herdr pane must contain Pi. Sending an image while a shell or another application is focused will insert the bridge marker into that application instead.

PNG, JPEG, GIF, and WebP images up to 50 MB are accepted. macOS clipboard formats such as TIFF are converted to PNG before transfer.

## Why the bridge is needed

Ghostty 1.3.1 parses OSC 5522 but does not implement its clipboard read path. That work remains open in [ghostty#12030](https://github.com/ghostty-org/ghostty/pull/12030). Native Kitty drag-and-drop protocol support also remains open in [ghostty#12852](https://github.com/ghostty-org/ghostty/issues/12852).

The Hammerspoon bridge works with released Ghostty versions instead of depending on those unmerged changes. The extension retains OSC 5522 support for Kitty and future Ghostty releases.
