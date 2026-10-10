# Substitutes {{ role }}, {{ role_strip }} and {{ role_rgb }} from a palette file
# whose lines are `role=#rrggbb`. An unknown role is an error, not a passthrough,
# so a typo in a template fails the render instead of shipping a broken config.
function hexdigit(c) { return index("0123456789abcdef", tolower(c)) - 1 }
function hexpair(s, i) { return hexdigit(substr(s, i, 1)) * 16 + hexdigit(substr(s, i + 1, 1)) }

BEGIN {
  while ((getline line < palette) > 0) {
    if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
      eq = index(line, "=")
      colour[substr(line, 1, eq - 1)] = substr(line, eq + 1)
    }
  }
  close(palette)
}

{
  line = $0
  out = ""
  while (match(line, /\{\{[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}/)) {
    out = out substr(line, 1, RSTART - 1)
    token = substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)

    name = token
    sub(/^\{\{[ \t]*/, "", name)
    sub(/[ \t]*\}\}$/, "", name)

    modifier = ""
    if (name ~ /_strip$/) {
      modifier = "strip"
      sub(/_strip$/, "", name)
    } else if (name ~ /_rgb$/) {
      modifier = "rgb"
      sub(/_rgb$/, "", name)
    }

    if (!(name in colour)) {
      printf "theme: unknown palette role '%s' in token %s\n", name, token > "/dev/stderr"
      failed = 1
      out = out token
      continue
    }

    value = colour[name]
    if (modifier == "strip") {
      sub(/^#/, "", value)
    } else if (modifier == "rgb") {
      value = sprintf("%d,%d,%d", hexpair(value, 2), hexpair(value, 4), hexpair(value, 6))
    }
    out = out value
  }
  print out line
}

END { exit failed }
