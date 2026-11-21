_:

{
  # Linux port of the Karabiner rules in config/karabiner/src/index.ts, with
  # Command mapped to Super so the Hyprland SUPER binds sit on D and K.
  # Caps Lock taps to Escape, and a held Shift acts as Hyper.
  services.kanata = {
    enable = true;
    keyboards.default = {
      extraDefCfg = "process-unmapped-keys yes";
      config = ''
        (defsrc caps a s d f j k l ; lsft rsft)

        (defvar
          tap-time 200
          hold-time 200
        )

        (defalias
          a (tap-hold-release $tap-time $hold-time a lctl)
          s (tap-hold-release $tap-time $hold-time s lalt)
          d (tap-hold-release $tap-time $hold-time d lmet)
          f (tap-hold-release $tap-time $hold-time f lsft)
          j (tap-hold-release $tap-time $hold-time j rsft)
          k (tap-hold-release $tap-time $hold-time k rmet)
          l (tap-hold-release $tap-time $hold-time l ralt)
          ; (tap-hold-release $tap-time $hold-time ; rctl)
          lhyp (tap-hold-press $tap-time $hold-time lsft (multi lsft lmet lalt lctl))
          rhyp (tap-hold-press $tap-time $hold-time rsft (multi rsft rmet ralt rctl))
        )

        (deflayer base esc @a @s @d @f @j @k @l @; @lhyp @rhyp)
      '';
    };
  };
}
