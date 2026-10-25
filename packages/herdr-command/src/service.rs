use crate::activation;
use crate::capture::{self, Captured};
use crate::manager;
use crate::protocol::{
    invalid, Cause, Claim, Evidence, LogCount, LogEnd, Outcome, Receipt, Spec, MAX_LOG,
};
use crate::store::Directory;
use serde::Deserialize;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixListener;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static CANCEL: AtomicBool = AtomicBool::new(false);

extern "C" fn cancel(_: libc::c_int) {
    CANCEL.store(true, Ordering::Relaxed);
}

fn handlers() -> io::Result<()> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = cancel as *const () as libc::sighandler_t;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    if unsafe { libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Cancellation {
    version: u8,
    nonce: String,
    spec_sha256: String,
}

fn cancellation(directory: &Directory, spec: &Spec, digest: &str) -> io::Result<bool> {
    if CANCEL.load(Ordering::Relaxed) {
        return Ok(true);
    }
    match directory.read("cancel.json", 1024) {
        Ok(bytes) => {
            let request: Cancellation = serde_json::from_slice(&bytes)
                .map_err(|_| invalid("Invalid cancellation record"))?;
            if request.version != 1 || request.nonce != spec.nonce || request.spec_sha256 != digest
            {
                return Err(invalid("Cancellation binding mismatch"));
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn no_start(directory: &Directory, evidence: Evidence, reason: &str) -> io::Result<()> {
    directory.publish(
        "exit.json",
        &Receipt {
            evidence,
            outcome: Outcome::NotStarted {
                reason: reason.to_owned(),
            },
            stdout: LogCount {
                kept: 0,
                dropped: 0,
                end: LogEnd::ServiceExit,
            },
            stderr: LogCount {
                kept: 0,
                dropped: 0,
                end: LogEnd::ServiceExit,
            },
        },
    )
}

fn syscall(result: libc::c_int) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn write_mapping(path: &[u8], value: &[u8]) -> io::Result<()> {
    let fd = unsafe { libc::open(path.as_ptr().cast(), libc::O_WRONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut remaining = value;
    let result = loop {
        let count = unsafe { libc::write(fd, remaining.as_ptr().cast(), remaining.len()) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            break Err(error);
        }
        if count == 0 {
            break Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Cannot write credential map",
            ));
        }
        remaining = &remaining[count as usize..];
        if remaining.is_empty() {
            break Ok(());
        }
    };
    unsafe {
        libc::close(fd);
    }
    result
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn command(spec: &Spec, captured: &Captured) -> io::Result<Command> {
    let mut command = Command::new(&spec.argv[0]);
    command
        .args(&spec.argv[1..])
        .env_clear()
        .envs(&captured.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let uid = spec.context.credentials.uid;
    let gid = spec.context.credentials.gid;
    let uid_map = format!("{uid} {uid} 1\n").into_bytes();
    let gid_map = format!("{gid} {gid} 1\n").into_bytes();
    let root = captured.fds[0].as_raw_fd();
    let cwd = captured.fds[1].as_raw_fd();
    let expected_cwd = spec.cwd.as_bytes().to_vec();
    let last: u32 = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
        .trim()
        .parse()
        .map_err(|_| invalid("Invalid capability range"))?;
    if last > 63 {
        return Err(invalid("Unsupported capability range"));
    }
    // pre_exec requires async-signal-safe operations until exec.
    unsafe {
        command.pre_exec(move || {
            syscall(libc::setsid())?;
            syscall(libc::unshare(libc::CLONE_NEWUSER))?;
            write_mapping(b"/proc/self/setgroups\0", b"deny\n")?;
            write_mapping(b"/proc/self/uid_map\0", &uid_map)?;
            write_mapping(b"/proc/self/gid_map\0", &gid_map)?;
            syscall(libc::fchdir(root))?;
            syscall(libc::chroot(c".".as_ptr()))?;
            syscall(libc::fchdir(cwd))?;
            let mut actual_cwd = [0_u8; 4096];
            let length = libc::syscall(libc::SYS_getcwd, actual_cwd.as_mut_ptr(), actual_cwd.len());
            if length < 0 {
                return Err(io::Error::last_os_error());
            }
            let length = length as usize;
            if length == 0
                || length > actual_cwd.len()
                || actual_cwd[length - 1] != 0
                || actual_cwd[..length - 1] != expected_cwd
            {
                return Err(io::Error::from_raw_os_error(libc::ESTALE));
            }
            syscall(libc::prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL,
                0,
                0,
                0,
            ))?;
            for capability in 0..=last {
                syscall(libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0))?;
            }
            let header = CapHeader {
                version: 0x20080522,
                pid: 0,
            };
            let data = [
                CapData {
                    effective: 0,
                    permitted: 0,
                    inheritable: 0,
                },
                CapData {
                    effective: 0,
                    permitted: 0,
                    inheritable: 0,
                },
            ];
            syscall(libc::syscall(libc::SYS_capset, &header, data.as_ptr()) as i32)?;
            syscall(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))?;
            Ok(())
        });
    }
    Ok(command)
}

enum Phase {
    Running,
    Stopping { since: Instant, cause: Cause },
}

struct Log<R> {
    source: R,
    file: File,
    count: LogCount,
}

impl<R: Read + AsRawFd> Log<R> {
    fn new(source: R, file: File) -> io::Result<Self> {
        let flags = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        syscall(unsafe {
            libc::fcntl(source.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
        })?;
        Ok(Self {
            source,
            file,
            count: LogCount {
                kept: 0,
                dropped: 0,
                end: LogEnd::ServiceExit,
            },
        })
    }

    fn drain(&mut self) -> io::Result<bool> {
        let mut progress = false;
        let mut bytes = [0_u8; 8192];
        for _ in 0..16 {
            let count = match self.source.read(&mut bytes) {
                Ok(0) => {
                    self.count.end = LogEnd::Eof;
                    break;
                }
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            progress = true;
            let kept = count.min(MAX_LOG.saturating_sub(self.count.kept as usize));
            self.file.write_all(&bytes[..kept])?;
            self.count.kept += kept as u64;
            self.count.dropped = self.count.dropped.saturating_add((count - kept) as u64);
        }
        Ok(progress)
    }

    fn finish(self) -> io::Result<LogCount> {
        self.file.sync_all()?;
        Ok(self.count)
    }
}

pub fn run(directory: &Directory, spec: &Spec, digest: &str) -> io::Result<()> {
    handlers()?;
    let evidence = activation::observe(spec, digest)?;
    for name in [
        "activation.json",
        "ready.json",
        "claim.json",
        "captured.json",
        "exit.json",
        "stdout.log",
        "stderr.log",
    ] {
        match directory.read(name, 1) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => {
                return Err(invalid(
                    "Execution already has helper evidence; refusing another activation",
                ))
            }
        }
    }
    directory.commit_new("activation.json", &evidence)?;
    if cancellation(directory, spec, digest)? {
        return no_start(directory, evidence, "cancelled-before-capture");
    }
    let listener = match UnixListener::bind(directory.descriptor_path("c.sock")?) {
        Ok(listener) => listener,
        Err(_) => return no_start(directory, evidence, "capture-socket-unavailable"),
    };
    fs::set_permissions(
        directory.descriptor_path("c.sock")?,
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    )?;
    listener.set_nonblocking(true)?;
    directory.publish("ready.json", &evidence)?;
    let deadline = Instant::now() + Duration::from_secs(6);
    let connection = loop {
        if cancellation(directory, spec, digest)? {
            return no_start(directory, evidence, "cancelled-before-capture");
        }
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => return no_start(directory, evidence, "capture-accept-failed"),
        }
        if Instant::now() >= deadline {
            return no_start(directory, evidence, "capture-deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (captured, mut connection) = match capture::receive(connection, spec, digest) {
        Ok(captured) => captured,
        Err(error) => {
            eprintln!("Capture refused: {error}");
            return no_start(directory, evidence, "capture-refused");
        }
    };
    if cancellation(directory, spec, digest)? {
        return no_start(directory, evidence, "cancelled-before-start");
    }
    let mut command = match command(spec, &captured) {
        Ok(command) => command,
        Err(_) => return no_start(directory, evidence, "execution-context-unavailable"),
    };
    if manager::notify_namespace_store(captured.fds[3].as_raw_fd()).is_err() {
        return no_start(directory, evidence, "namespace-store-unavailable");
    }
    directory.publish("captured.json", &evidence)?;
    let admission_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if cancellation(directory, spec, digest)? {
            return no_start(directory, evidence, "cancelled-before-admission");
        }
        match directory.read("admit.json", 32 * 1024) {
            Ok(bytes) => {
                let admitted: Evidence = match serde_json::from_slice(&bytes) {
                    Ok(admitted) => admitted,
                    Err(_) => return no_start(directory, evidence, "invalid-admission"),
                };
                if admitted != evidence {
                    return no_start(directory, evidence, "admission-binding-mismatch");
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return no_start(directory, evidence, "admission-unavailable"),
        }
        if Instant::now() >= admission_deadline {
            return no_start(directory, evidence, "admission-deadline");
        }
        thread::sleep(Duration::from_millis(10));
    }
    let stdout_file = directory.create("stdout.log")?;
    let stderr_file = directory.create("stderr.log")?;
    let context = capture::context(&captured.fds, capture::credentials()?)?;
    directory.commit_new(
        "claim.json",
        &Claim {
            evidence: evidence.clone(),
            context,
        },
    )?;
    if capture::acknowledge(&mut connection, digest).is_err() {
        return no_start(directory, evidence, "capture-acknowledgement-lost");
    }
    drop((connection, listener));
    if cancellation(directory, spec, digest)? {
        return no_start(directory, evidence, "cancelled-before-exec");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return no_start(directory, evidence, "command-exec-refused"),
    };
    let output = child
        .stdout
        .take()
        .ok_or_else(|| invalid("Command stdout missing"))?;
    let errors = child
        .stderr
        .take()
        .ok_or_else(|| invalid("Command stderr missing"))?;
    let mut stdout = Log::new(output, stdout_file)?;
    let mut stderr = Log::new(errors, stderr_file)?;
    let deadline = Instant::now() + Duration::from_secs(spec.timeout_seconds as u64);
    let mut phase = Phase::Running;
    let status = loop {
        let read_out = stdout.drain()?;
        let read_err = stderr.drain()?;
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let now = Instant::now();
        if matches!(&phase, Phase::Running) {
            let requested = if now >= deadline {
                Some(Cause::Timeout)
            } else {
                match cancellation(directory, spec, digest) {
                    Ok(true) => Some(Cause::Cancelled),
                    Ok(false) => None,
                    Err(_) => {
                        eprintln!("Command control record unavailable; terminating");
                        Some(Cause::ControlError)
                    }
                }
            };
            if let Some(cause) = requested {
                // The child is unreaped, so its session/group ID cannot be reused.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGTERM);
                }
                phase = Phase::Stopping { since: now, cause };
            }
        }
        match &phase {
            Phase::Stopping { since, .. }
                if now.duration_since(*since) >= Duration::from_millis(500) =>
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            },
            _ => {}
        }
        if !read_out && !read_err {
            thread::sleep(Duration::from_millis(10));
        }
    };
    let tail_deadline = Instant::now() + Duration::from_millis(100);
    while Instant::now() < tail_deadline {
        let out = stdout.drain()?;
        let err = stderr.drain()?;
        if !out && !err {
            break;
        }
    }
    let cause = match phase {
        Phase::Running => Cause::Normal,
        Phase::Stopping { cause, .. } => cause,
    };
    let outcome = match (status.code(), status.signal()) {
        (Some(code), _) => Outcome::Exit { code, cause },
        (_, Some(signal)) => Outcome::Signal { signal, cause },
        _ => return Err(invalid("Unknown child exit status")),
    };
    directory.publish(
        "exit.json",
        &Receipt {
            evidence,
            outcome,
            stdout: stdout.finish()?,
            stderr: stderr.finish()?,
        },
    )
}
