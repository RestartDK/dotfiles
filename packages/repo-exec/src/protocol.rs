use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub const ENVIRONMENT_MS: u64 = 600_000;
pub const STARTUP_MS: u64 = 60_000;
const LEASE_MS: u64 = 5_000;

pub enum Mode {
    Standalone,
    Managed(Attempt),
}

pub struct Attempt {
    directory: PathBuf,
    options: Options,
    reported: Option<(Phase, ReceiptKind)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    id: String,
    claim_path: Option<PathBuf>,
    #[serde(default = "environment_ms")]
    environment_ms: u64,
    #[serde(default = "startup_ms")]
    startup_ms: u64,
    #[serde(default = "lease_ms")]
    lease_ms: u64,
}

fn environment_ms() -> u64 {
    ENVIRONMENT_MS
}
fn startup_ms() -> u64 {
    STARTUP_MS
}
fn lease_ms() -> u64 {
    LEASE_MS
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Shell,
    Environment,
    Startup,
    Transferred,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Failed,
    Cancelled,
    Timedout,
    SourceLost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Authorization {
    Absent,
    Committed,
    Mismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Arbitration {
    Accepted,
    Stopped,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReceiptKind {
    Active,
    Transferred,
    Stopping {
        reason: StopReason,
    },
    RecoveryRequired {
        reason: StopReason,
    },
    Exited {
        code: u8,
        reason: Option<StopReason>,
        cleanup: Cleanup,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Cleanup {
    Confirmed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    id: &'a str,
    #[serde(flatten)]
    kind: ReceiptKind,
    phase: Phase,
    at: u64,
    phase_at: u64,
    deadline: u64,
    supervisor_pid: u32,
}

pub struct Timeline {
    pub phase: Phase,
    pub phase_at: u64,
    pub deadline: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    drop(file);
    fs::rename(temporary, path)
}

impl Mode {
    pub fn from_environment() -> io::Result<Self> {
        match std::env::var_os("REPO_LAUNCH_DIRECTORY").filter(|path| !path.is_empty()) {
            None => Ok(Self::Standalone),
            Some(directory) => {
                let directory = PathBuf::from(directory);
                let options: Options =
                    serde_json::from_slice(&fs::read(directory.join("attempt.json"))?)?;
                if options.environment_ms == 0 || options.startup_ms == 0 || options.lease_ms == 0 {
                    return Err(invalid("launch budgets must be positive"));
                }
                Ok(Self::Managed(Attempt {
                    directory,
                    options,
                    reported: None,
                }))
            }
        }
    }

    pub fn environment_ms(&self) -> u64 {
        match self {
            Self::Standalone => ENVIRONMENT_MS,
            Self::Managed(attempt) => attempt.options.environment_ms,
        }
    }

    pub fn startup_ms(&self) -> u64 {
        match self {
            Self::Standalone => STARTUP_MS,
            Self::Managed(attempt) => attempt.options.startup_ms,
        }
    }

    pub fn is_handoff(&self) -> bool {
        matches!(self, Self::Managed(attempt) if attempt.options.claim_path.is_some())
    }

    pub fn mark_started(&self) -> io::Result<()> {
        if let Self::Managed(attempt) = self {
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(attempt.directory.join("started"))?;
        }
        Ok(())
    }

    pub fn publish(&mut self, timeline: &Timeline, kind: ReceiptKind) -> io::Result<()> {
        let Self::Managed(attempt) = self else {
            return Ok(());
        };
        if attempt.reported == Some((timeline.phase, kind)) {
            return Ok(());
        }
        let state = Receipt {
            id: &attempt.options.id,
            kind,
            phase: timeline.phase,
            at: now_ms(),
            phase_at: timeline.phase_at,
            deadline: timeline.deadline,
            supervisor_pid: std::process::id(),
        };
        let mut bytes = serde_json::to_vec(&state)?;
        atomic_write(&attempt.directory.join("status"), &bytes)?;
        bytes.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(attempt.directory.join("events.jsonl"))?
            .write_all(&bytes)?;
        attempt.reported = Some((timeline.phase, kind));
        Ok(())
    }

    pub fn arbitrate_stop(&self) -> Arbitration {
        match self {
            Self::Standalone => Arbitration::Stopped,
            Self::Managed(attempt) if attempt.options.claim_path.is_some() => {
                attempt.arbitrate_claim()
            }
            Self::Managed(attempt) => attempt.arbitrate_authorization(),
        }
    }
}

impl Attempt {
    fn arbitrate_authorization(&self) -> Arbitration {
        let candidate = self.directory.join("stop-decision");
        let denied = format!("stopped:{}", self.options.id);
        let decision = atomic_write(&candidate, denied.as_bytes())
            .and_then(|()| fs::hard_link(candidate, self.directory.join("transferred")));
        if decision.is_ok() {
            return Arbitration::Stopped;
        }
        match self.authorization() {
            Ok(Authorization::Committed) => Arbitration::Accepted,
            Ok(Authorization::Mismatch) => Arbitration::Stopped,
            Ok(Authorization::Absent) | Err(_) => Arbitration::Uncertain,
        }
    }

    pub fn stop_requested(&self) -> io::Result<Option<StopReason>> {
        Ok(
            read_optional(&self.directory.join("stop"))?.map(|value| match value.trim() {
                "cancelled" => StopReason::Cancelled,
                "timedout" => StopReason::Timedout,
                "sourceLost" => StopReason::SourceLost,
                _ => StopReason::Failed,
            }),
        )
    }

    pub fn authorization(&self) -> io::Result<Authorization> {
        Ok(match read_optional(&self.directory.join("transferred"))? {
            None => Authorization::Absent,
            Some(id) if id == self.options.id => Authorization::Committed,
            Some(_) => Authorization::Mismatch,
        })
    }

    pub fn source_alive(&self) -> io::Result<bool> {
        #[derive(Deserialize)]
        struct Source {
            pid: i32,
            birth: String,
        }
        let source: Source = serde_json::from_slice(&fs::read(self.directory.join("source"))?)?;
        if source.pid <= 0 {
            return Err(invalid("invalid source pid"));
        }
        if source.birth.starts_with("linux:") {
            let record = match fs::read_to_string(format!("/proc/{}/stat", source.pid)) {
                Ok(record) => record,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(error),
            };
            let Some((_, fields)) = record.rsplit_once(')') else {
                return Err(invalid("invalid source process identity"));
            };
            let fields: Vec<_> = fields.split_whitespace().collect();
            let (Some(state), Some(birth)) = (fields.first(), fields.get(19)) else {
                return Err(invalid("incomplete source process identity"));
            };
            return Ok(*state != "Z"
                && !birth.is_empty()
                && birth.bytes().all(|byte| byte.is_ascii_digit())
                && source.birth == format!("linux:{birth}"));
        }
        if !source.birth.starts_with("ps:") {
            return Ok(false);
        }
        let output = Command::new("ps")
            .args(["-p", &source.pid.to_string(), "-o", "stat=,lstart="])
            .output()?;
        if !output.status.success() {
            return Ok(false);
        }
        let value = std::str::from_utf8(&output.stdout)
            .map_err(|_| invalid("invalid ps output"))?
            .trim();
        let mut fields = value.splitn(2, char::is_whitespace);
        let (Some(state), Some(birth)) = (fields.next(), fields.next()) else {
            return Ok(false);
        };
        Ok(!state.starts_with('Z') && source.birth == format!("ps:{}", birth.trim()))
    }

    pub fn lease_alive(&self, now: u64) -> io::Result<bool> {
        let modified = fs::metadata(self.directory.join("lease"))?.modified()?;
        let timestamp = modified
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid("invalid lease timestamp"))?
            .as_millis();
        Ok(u128::from(now).saturating_sub(timestamp) <= u128::from(self.options.lease_ms))
    }

    fn arbitrate_claim(&self) -> Arbitration {
        let Some(claim) = &self.options.claim_path else {
            return Arbitration::Uncertain;
        };
        let mut lock: OsString = claim.as_os_str().to_owned();
        lock.push(".lock");
        let lock = PathBuf::from(lock);
        if fs::create_dir(&lock).is_err() {
            return Arbitration::Uncertain;
        }
        let result = self
            .decide_under_lock(claim)
            .unwrap_or(Arbitration::Uncertain);
        if fs::remove_dir(lock).is_err() {
            Arbitration::Uncertain
        } else {
            result
        }
    }

    fn decide_under_lock(&self, claim: &Path) -> io::Result<Arbitration> {
        #[derive(Deserialize)]
        struct Owner {
            id: String,
        }
        let owner: Owner = serde_json::from_slice(&fs::read(claim.join("owner"))?)?;
        if owner.id != self.options.id {
            return Ok(Arbitration::Uncertain);
        }
        let decision = claim.join("decision");
        let value = match read_optional(&decision)? {
            Some(value) => value,
            None => {
                let candidate = self.directory.join("stop-decision");
                atomic_write(&candidate, b"stopped")?;
                match fs::hard_link(candidate, &decision) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
                fs::read_to_string(decision)?
            }
        };
        Ok(if value == format!("ready:{}", self.options.id) {
            Arbitration::Accepted
        } else if value == "stopped" {
            Arbitration::Stopped
        } else {
            Arbitration::Uncertain
        })
    }
}
