import os
import pty
import subprocess
import sys

wrapper = sys.argv[1]
for terminal, overrides, expected in [
    (True, {}, "kitty"),
    (False, {}, "unset"),
    (True, {"HERDR_ENV": "0"}, "unset"),
    (True, {"PI_IMAGE_PROTOCOL": "none"}, "none"),
    (True, {"PI_IMAGE_PROTOCOL": "iterm2"}, "iterm2"),
    (True, {"PI_IMAGE_PROTOCOL": "auto"}, "auto"),
    (True, {"TMUX": "/tmp/example"}, "unset"),
    (True, {"STY": "example"}, "unset"),
    (True, {"ZELLIJ": "1"}, "unset"),
    (True, {"TERM": "dumb"}, "unset"),
    (True, {"TERM": "screen-256color"}, "unset"),
]:
    env = {"PATH": os.environ["PATH"], "HERDR_ENV": "1", "TERM": "xterm-256color", **overrides}
    command = [wrapper, "first argument", "quote ' \" $"]
    expected = f"{expected}|{env['HERDR_ENV']}|{command[1]}|{command[2]}"
    if terminal:
        master, slave = pty.openpty()
        result = subprocess.run(command, env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE, check=True)
        os.close(slave)
        output = os.read(master, 1024).decode()
        os.close(master)
    else:
        output = subprocess.check_output(command, env=env, stdin=subprocess.DEVNULL).decode()
    assert output == expected, (terminal, overrides, output, expected)
print("Generated Pi wrapper passes arguments and exports Herdr image overrides to its child")
