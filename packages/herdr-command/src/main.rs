mod activation;
mod capture;
mod input;
mod manager;
mod protocol;
mod service;
mod store;

use protocol::{hex, invalid, Spec, MAX_CAPTURE, MAX_SPEC};
use std::io;
use std::os::unix::net::UnixStream;
use std::path::Path;
use store::Directory;

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--help" {
        println!(
            "dstack-command-helper <send|service|signal> <private-job-directory> <spec-sha256> [--check for signal]"
        );
        return Ok(());
    }
    let action = match args.as_slice() {
        [_, mode, _, _, flag] if mode == "signal" && flag == "--check" => {
            activation::SignalAction::Verify
        }
        [_, _, _, _] => activation::SignalAction::Cancel,
        _ => {
            return Err(invalid(
                "Expected mode, private job directory and spec digest",
            ))
        }
    };
    if !hex(&args[3], 64) {
        return Err(invalid(
            "Expected mode, private job directory and spec digest",
        ));
    }
    if args[1] == "service"
        && (store::current_uid() == 0
            || unsafe { libc::getuid() } != store::current_uid()
            || unsafe { libc::getgid() != libc::getegid() })
    {
        return Err(invalid(
            "Command service requires an ordinary user identity",
        ));
    }
    unsafe {
        libc::umask(0o077);
    }
    let directory = Directory::open(Path::new(&args[2]))?;
    let bytes = directory.read("spec.json", MAX_SPEC)?;
    if store::sha256(&bytes) != args[3] {
        return Err(invalid("Immutable spec digest mismatch"));
    }
    let spec: Spec = serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid command spec"))?;
    spec.validate()?;
    match args[1].as_str() {
        "service" => service::run(&directory, &spec, &args[3]),
        "send" => {
            let frame = input::read_frame(0, MAX_CAPTURE, std::time::Duration::from_secs(5))?;
            let connection = UnixStream::connect(directory.descriptor_path("c.sock")?)?;
            capture::send(connection, &frame, &spec, &args[3])
        }
        "signal" => activation::signal_original(&directory, &spec, &args[3], action),
        _ => Err(invalid("Unknown command helper mode")),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("dstack-command-helper: {error}");
        std::process::exit(1);
    }
}
