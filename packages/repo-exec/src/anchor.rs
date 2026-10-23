use crate::diagnostic;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const SHELL_SCRIPT: &str = r#"
printf 'environment\n' >&$REPO_ENV_EVENT_FD
if ! command -v repo_env_prepare >/dev/null 2>&1; then
  printf 'repo-exec: shell must define repo_env_prepare\n' >&2
  exit 69
fi
repo_env_prepare
result=$?
if [ "$result" -ne 0 ]; then exit "$result"; fi
printf 'prepared\n' >&$REPO_ENV_EVENT_FD
IFS= read -r permission <&$REPO_ENV_GRANT_FD
if [ "$permission" != start ]; then exit 125; fi
exec 5>&- 6<&-
unset REPO_ENV_EVENT_FD REPO_ENV_GRANT_FD REPO_ENV_LAUNCH REPO_LAUNCH_DIRECTORY
exec 1>&3 3>&- 0<&4 4<&-
exec "$@"
"#;

static STOP_SIGNAL: AtomicI32 = AtomicI32::new(0);
static RESIZE: AtomicBool = AtomicBool::new(false);

extern "C" fn stop_signal(signal: libc::c_int) {
    STOP_SIGNAL.store(signal, Ordering::Relaxed);
}

extern "C" fn resize_signal(_: libc::c_int) {
    RESIZE.store(true, Ordering::Relaxed);
}

pub fn take_stop_signal() -> Option<i32> {
    match STOP_SIGNAL.swap(0, Ordering::Relaxed) {
        0 => None,
        signal => Some(signal),
    }
}

pub fn take_resize() -> bool {
    RESIZE.swap(false, Ordering::Relaxed)
}

fn set_handler(signal: i32, handler: libc::sighandler_t) -> io::Result<()> {
    // SAFETY: sigaction is initialized before use; these handlers only store atomics.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(signal, &action, std::ptr::null_mut()) == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn install_signal_handlers() -> io::Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        set_handler(signal, stop_signal as *const () as libc::sighandler_t)?;
    }
    set_handler(
        libc::SIGWINCH,
        resize_signal as *const () as libc::sighandler_t,
    )?;
    // Inherited SIG_IGN or SA_NOCLDWAIT would release the anchor PID before cleanup.
    set_handler(libc::SIGCHLD, libc::SIG_DFL)?;
    set_handler(libc::SIGPIPE, libc::SIG_IGN)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AnchorState {
    AwaitingAck,
    Gated,
    Running,
}

pub enum Event {
    Anchored,
    Environment,
    Prepared,
    Exited(u8),
    Closed,
    Invalid,
}

pub enum CleanupResult {
    Confirmed,
    Unknown,
}

pub struct OwnedAnchor {
    pid: libc::pid_t,
    state: AnchorState,
    events: OwnedFd,
    grant: OwnedFd,
    hold: OwnedFd,
    buffer: Vec<u8>,
    events_closed: bool,
}

impl OwnedAnchor {
    pub fn spawn(shell: &OsStr, payload: &[OsString]) -> io::Result<Self> {
        let (events_read, events_write) = pipe()?;
        let (grant_read, grant_write) = pipe()?;
        let (hold_read, hold_write) = pipe()?;
        // SAFETY: this executable is single-threaded, including libraries, before fork.
        let pid = unsafe { libc::fork() };
        if pid == -1 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            drop((events_read, grant_write, hold_write));
            if let Err(error) = run_anchor(shell, payload, events_write, grant_read, hold_read) {
                diagnostic(&format!("anchor failed ({error})"));
            }
            kill_own_group();
        }
        drop((events_write, grant_read, hold_read));
        Ok(Self {
            pid,
            state: AnchorState::AwaitingAck,
            events: events_read,
            grant: grant_write,
            hold: hold_write,
            buffer: Vec::new(),
            events_closed: false,
        })
    }

    pub fn acknowledge(&mut self) -> io::Result<()> {
        if self.state != AnchorState::AwaitingAck {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "duplicate anchor acknowledgement",
            ));
        }
        self.state = AnchorState::Gated;
        Ok(())
    }

    pub fn start(&mut self) -> io::Result<()> {
        if self.state == AnchorState::Gated {
            write_all(self.hold.as_raw_fd(), b"s")?;
            self.state = AnchorState::Running;
        }
        Ok(())
    }

    pub fn grant(&self) -> io::Result<()> {
        write_all(self.grant.as_raw_fd(), b"start\n")
    }

    pub fn resize(&self) -> io::Result<()> {
        if self.state != AnchorState::AwaitingAck {
            signal_process(-self.pid, libc::SIGWINCH)?;
        }
        Ok(())
    }

    pub fn events(&mut self) -> io::Result<Vec<Event>> {
        if self.events_closed {
            thread::sleep(Duration::from_millis(50));
            return Ok(Vec::new());
        }
        if !readable(self.events.as_raw_fd(), 50)? {
            return Ok(Vec::new());
        }
        let mut data = [0_u8; 4096];
        let count = read(self.events.as_raw_fd(), &mut data)?;
        if count == 0 {
            self.events_closed = true;
            return Ok(vec![Event::Closed]);
        }
        self.buffer.extend_from_slice(&data[..count]);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = &self.buffer[..end];
            let event = match line {
                b"anchor" => Event::Anchored,
                b"environment" => Event::Environment,
                b"prepared" => Event::Prepared,
                line if line.starts_with(b"exit:") => {
                    match std::str::from_utf8(&line[5..])
                        .ok()
                        .and_then(|value| value.parse::<u8>().ok())
                    {
                        Some(code) => Event::Exited(code),
                        None => Event::Invalid,
                    }
                }
                _ => Event::Invalid,
            };
            events.push(event);
            self.buffer.drain(..=end);
        }
        if self.buffer.len() > 4096 {
            self.buffer.clear();
            events.push(Event::Invalid);
        }
        Ok(events)
    }

    pub fn group_quiescent(&self) -> io::Result<bool> {
        let output = Command::new("ps").args(["-axo", "pgid=,stat="]).output()?;
        if !output.status.success() {
            return Err(io::Error::other("cannot inspect owned process group"));
        }
        let processes = std::str::from_utf8(&output.stdout)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid process listing"))?;
        for line in processes.lines().filter(|line| !line.trim().is_empty()) {
            let mut fields = line.split_whitespace();
            let group = fields
                .next()
                .and_then(|value| value.parse::<libc::pid_t>().ok());
            let status = fields.next();
            let (Some(group), Some(status), None) = (group, status, fields.next()) else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "incomplete process listing",
                ));
            };
            if group == self.pid && !status.starts_with('Z') {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn cleanup(self) -> CleanupResult {
        let mut confirmed = false;
        if self.state == AnchorState::AwaitingAck {
            // The gate is still closed, so only this unreaped child can exist.
            if signal_process(self.pid, libc::SIGKILL).is_ok() {
                confirmed = true;
            }
        } else {
            let _ = signal_process(-self.pid, libc::SIGTERM);
            thread::sleep(Duration::from_millis(200));
            let _ = signal_process(-self.pid, libc::SIGKILL);
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match self.group_quiescent() {
                    Ok(true) => {
                        confirmed = true;
                        break;
                    }
                    Ok(false) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
        }
        // Reaping releases the PID. All group signaling and inspection must precede it.
        if reap(self.pid).is_err() {
            confirmed = false;
        }
        if confirmed {
            CleanupResult::Confirmed
        } else {
            CleanupResult::Unknown
        }
    }
}

fn run_anchor(
    shell: &OsStr,
    payload: &[OsString],
    events: OwnedFd,
    grant: OwnedFd,
    hold: OwnedFd,
) -> io::Result<()> {
    // SAFETY: only the freshly forked child creates this session, before spawning a payload.
    if unsafe { libc::setsid() } == -1 {
        return Err(io::Error::last_os_error());
    }
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGWINCH] {
        set_handler(signal, libc::SIG_IGN)?;
    }
    write_all(events.as_raw_fd(), b"anchor\n")?;
    let mut gate = [0_u8; 1];
    if read(hold.as_raw_fd(), &mut gate)? != 1 || gate[0] != b's' {
        kill_own_group();
    }

    let original_stdout = duplicate(1)?;
    let original_stdin = duplicate(0)?;
    // Reserve 3..6 before Command allocates its exec-error pipe or redirects stdio.
    let saved = [
        duplicate_to(original_stdout.as_raw_fd(), 3)?,
        duplicate_to(original_stdin.as_raw_fd(), 4)?,
        duplicate_to(events.as_raw_fd(), 5)?,
        duplicate_to(grant.as_raw_fd(), 6)?,
    ];
    let mut command = Command::new(shell);
    command
        .args([
            OsStr::new("+m"),
            OsStr::new("-ic"),
            OsStr::new(SHELL_SCRIPT),
            OsStr::new("repo-exec"),
        ])
        .args(payload)
        .env("REPO_ENV_LAUNCH", "1")
        .env("REPO_ENV_EVENT_FD", "5")
        .env("REPO_ENV_GRANT_FD", "6")
        .stdin(Stdio::null())
        .stdout(Stdio::from(duplicate(2)?));
    // SAFETY: pre_exec uses only fcntl and sigaction. All borrowed FDs remain owned by this anchor.
    unsafe {
        command.pre_exec(|| {
            for fd in 3..=6 {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            for signal in [
                libc::SIGTERM,
                libc::SIGINT,
                libc::SIGHUP,
                libc::SIGWINCH,
                libc::SIGPIPE,
            ] {
                set_handler(signal, libc::SIG_DFL)?;
            }
            Ok(())
        });
    }
    let spawned = command.spawn();
    drop((command, saved, original_stdout, original_stdin, grant));
    let code = match spawned {
        Ok(mut child) => loop {
            if let Some(status) = child.try_wait()? {
                break status
                    .code()
                    .map(|code| code as u8)
                    .or_else(|| status.signal().map(|signal| (128 + signal) as u8))
                    .unwrap_or(70);
            }
            if readable(hold.as_raw_fd(), 50)? && read(hold.as_raw_fd(), &mut gate)? == 0 {
                kill_own_group();
            }
        },
        Err(error) => {
            diagnostic(&format!("cannot start shell ({error})"));
            if error.kind() == io::ErrorKind::NotFound {
                127
            } else {
                126
            }
        }
    };
    write_all(events.as_raw_fd(), format!("exit:{code}\n").as_bytes())?;
    let _ = read(hold.as_raw_fd(), &mut gate);
    kill_own_group();
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1; 2];
    // SAFETY: pipe initializes both entries on success; each is then owned exactly once.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    Ok((duplicate(read.as_raw_fd())?, duplicate(write.as_raw_fd())?))
}

fn duplicate(fd: RawFd) -> io::Result<OwnedFd> {
    // SAFETY: fcntl returns a fresh descriptor, above the reserved shell descriptors.
    let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if copy == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(copy) })
    }
}

fn duplicate_to(fd: RawFd, target: RawFd) -> io::Result<OwnedFd> {
    // SAFETY: all owned source descriptors are >=10; targets 3..6 are reserved only here.
    if unsafe { libc::dup2(fd, target) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let copy = unsafe { OwnedFd::from_raw_fd(target) };
    if unsafe { libc::fcntl(target, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(copy)
}

fn read(fd: RawFd, bytes: &mut [u8]) -> io::Result<usize> {
    loop {
        // SAFETY: the writable buffer has exactly the supplied length and the FD is borrowed.
        let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count >= 0 {
            return Ok(count as usize);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn write_all(fd: RawFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: the readable buffer has exactly the supplied length and the FD is borrowed.
        let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "closed control pipe",
            ));
        }
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        bytes = &bytes[count as usize..];
    }
    Ok(())
}

fn readable(fd: RawFd, timeout: i32) -> io::Result<bool> {
    let mut poll = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll receives one initialized record, valid for the duration of the call.
    let result = unsafe { libc::poll(&mut poll, 1, timeout) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    if poll.revents & libc::POLLNVAL != 0 {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "invalid control descriptor",
        ));
    }
    Ok(result != 0)
}

fn signal_process(pid: libc::pid_t, signal: i32) -> io::Result<()> {
    // SAFETY: callers use only the unreaped child PID or its acknowledged private group.
    if unsafe { libc::kill(pid, signal) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

fn reap(pid: libc::pid_t) -> io::Result<()> {
    loop {
        // SAFETY: this child remains unreaped until all group operations have completed.
        if unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) } >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn kill_own_group() -> ! {
    // SAFETY: the fork child signals only a group whose leader is its own PID.
    unsafe {
        let pid = libc::getpid();
        if libc::getpgrp() == pid {
            libc::kill(-pid, libc::SIGKILL);
        }
        libc::_exit(70);
    }
}
