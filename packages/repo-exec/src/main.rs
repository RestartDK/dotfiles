mod anchor;
mod protocol;
mod supervision;

use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::Path;

pub(crate) fn diagnostic(message: &str) {
    let _ = writeln!(io::stderr().lock(), "repo-exec: {message}");
}

fn main() {
    std::process::exit(i32::from(run()));
}

fn run() -> u8 {
    let mut argv = std::env::args_os();
    let executable = argv.next();
    let mut payload: Vec<_> = argv.collect();
    if executable
        .as_deref()
        .and_then(|name| Path::new(name).file_name())
        == Some(OsStr::new("repo-bash"))
    {
        payload.insert(0, "bash".into());
    }
    if payload.is_empty() {
        diagnostic("Usage: repo-exec COMMAND [ARG...]");
        return 64;
    }
    let shell = match std::env::var_os("SHELL") {
        Some(shell)
            if matches!(
                Path::new(&shell).file_name(),
                Some(name) if name == "bash" || name == "zsh"
            ) =>
        {
            shell
        }
        _ => {
            diagnostic("configure zsh or bash with repo_env_prepare");
            return 69;
        }
    };
    unsafe { libc::umask(0o077) };
    let mode = match protocol::Mode::from_environment() {
        Ok(mode) => mode,
        Err(error) => {
            diagnostic(&format!("cannot read launch attempt ({error})"));
            return 70;
        }
    };
    if let Err(error) = anchor::install_signal_handlers() {
        diagnostic(&format!("cannot install signal handlers ({error})"));
        return 70;
    }
    match anchor::OwnedAnchor::spawn(&shell, &payload) {
        Ok(anchor) => supervision::run(mode, anchor),
        Err(error) => {
            diagnostic(&format!("cannot start supervisor ({error})"));
            70
        }
    }
}
