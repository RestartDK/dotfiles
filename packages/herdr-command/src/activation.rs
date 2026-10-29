use crate::capture::descriptor;
use crate::protocol::{hex, invalid, Activation, Cgroup, Claim, Evidence, Spec};
use crate::store::{sha256, Directory};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn start_ticks(stat: &str) -> io::Result<String> {
    let end = stat
        .rfind(')')
        .ok_or_else(|| invalid("Invalid process identity"))?;
    let value = stat[end + 1..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| invalid("Missing process start identity"))?;
    value
        .parse::<u64>()
        .map_err(|_| invalid("Invalid process start identity"))?;
    Ok(value.to_owned())
}

fn cgroup(text: &str) -> io::Result<String> {
    let mut paths = text.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = paths
        .next()
        .ok_or_else(|| invalid("Unified cgroup required"))?;
    if paths.next().is_some() || !path.starts_with('/') || path.split('/').any(|part| part == "..")
    {
        return Err(invalid("Invalid cgroup identity"));
    }
    Ok(path.to_owned())
}

pub fn observe(spec: &Spec, digest: &str) -> io::Result<Evidence> {
    let invocation_id = std::env::var("INVOCATION_ID")
        .map_err(|_| invalid("Systemd activation identity required"))?;
    if !hex(&invocation_id, 32) {
        return Err(invalid("Invalid systemd activation identity"));
    }
    let path = cgroup(&fs::read_to_string("/proc/self/cgroup")?)?;
    if Path::new(&path).file_name().and_then(|name| name.to_str()) != Some(spec.unit.as_str()) {
        return Err(invalid("Unexpected command unit"));
    }
    let metadata = fs::metadata(format!("/sys/fs/cgroup{path}"))?;
    let executable = File::open("/proc/self/exe")?;
    let activation = Activation {
        unit: spec.unit.clone(),
        invocation_id,
        pid: std::process::id(),
        start_ticks: start_ticks(&fs::read_to_string("/proc/self/stat")?)?,
        boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned(),
        executable: descriptor(executable.as_raw_fd())?,
        command_line_sha256: sha256(&fs::read("/proc/self/cmdline")?),
        cgroup: Cgroup {
            path,
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
        },
    };
    Ok(Evidence {
        version: 1,
        execution_id: spec.execution_id.clone(),
        workspace_id: spec.workspace_id.clone(),
        intent_id: spec.intent_id.clone(),
        nonce: spec.nonce.clone(),
        spec_sha256: digest.to_owned(),
        activation,
        mode: spec.mode.clone(),
    })
}

fn read_process(directory: &File, name: &str, limit: usize) -> io::Result<Vec<u8>> {
    let name = std::ffi::CString::new(name).map_err(|_| invalid("Invalid process field"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut bytes = Vec::new();
    unsafe { File::from_raw_fd(fd) }
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("Process field too large"));
    }
    Ok(bytes)
}

pub enum SignalAction {
    Verify,
    Cancel,
}

pub fn signal_original(
    directory: &Directory,
    spec: &Spec,
    digest: &str,
    action: SignalAction,
) -> io::Result<()> {
    let evidence = match directory.read("claim.json", 32 * 1024) {
        Ok(bytes) => {
            serde_json::from_slice::<Claim>(&bytes)
                .map_err(|_| invalid("Invalid command claim"))?
                .evidence
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            serde_json::from_slice::<Evidence>(&directory.read("ready.json", 32 * 1024)?)
                .map_err(|_| invalid("Invalid activation record"))?
        }
        Err(error) => return Err(error),
    };
    if evidence.version != 1
        || evidence.execution_id != spec.execution_id
        || evidence.workspace_id != spec.workspace_id
        || evidence.intent_id != spec.intent_id
        || evidence.nonce != spec.nonce
        || evidence.spec_sha256 != digest
        || evidence.activation.unit != spec.unit
    {
        return Err(invalid("Cancellation binding mismatch"));
    }
    let identity = &evidence.activation;
    if fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != identity.boot_id {
        return Err(invalid("Command belongs to a different kernel boot"));
    }
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let process = File::open(format!("/proc/{}", identity.pid))?;
    if process.metadata()?.uid() != spec.context.credentials.uid {
        return Err(invalid("Command process owner changed"));
    }
    let stat = read_process(&process, "stat", 16 * 1024)?;
    let stat = std::str::from_utf8(&stat).map_err(|_| invalid("Invalid process identity"))?;
    if start_ticks(stat)? != identity.start_ticks {
        return Err(invalid("Command process was replaced"));
    }
    let exe_name = std::ffi::CString::new("exe").map_err(|_| invalid("Invalid process field"))?;
    let executable = unsafe {
        libc::openat(
            process.as_raw_fd(),
            exe_name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if executable < 0 {
        return Err(io::Error::last_os_error());
    }
    let executable = unsafe { OwnedFd::from_raw_fd(executable) };
    if descriptor(executable.as_raw_fd())? != identity.executable
        || sha256(&read_process(&process, "cmdline", 32 * 1024)?) != identity.command_line_sha256
    {
        return Err(invalid("Command executable changed"));
    }
    let group = read_process(&process, "cgroup", 16 * 1024)?;
    let path =
        cgroup(std::str::from_utf8(&group).map_err(|_| invalid("Invalid cgroup identity"))?)?;
    let metadata = fs::metadata(format!("/sys/fs/cgroup{path}"))?;
    if path != identity.cgroup.path
        || metadata.dev().to_string() != identity.cgroup.device
        || metadata.ino().to_string() != identity.cgroup.inode
    {
        return Err(invalid("Command containment changed"));
    }
    let environment = read_process(&process, "environ", 128 * 1024)?;
    let expected = format!("INVOCATION_ID={}", identity.invocation_id);
    if !environment
        .split(|byte| *byte == 0)
        .any(|value| value == expected.as_bytes())
    {
        return Err(invalid("Command activation changed"));
    }
    let mut poll = libc::pollfd {
        fd: handle.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&mut poll, 1, 0) } != 0 {
        return Err(invalid("Command process is no longer live"));
    }
    let signal = match action {
        SignalAction::Verify => 0,
        SignalAction::Cancel => libc::SIGUSR1,
    };
    if unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            handle.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
