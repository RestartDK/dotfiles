use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;

pub const MAX_SPEC: usize = 32 * 1024;
pub const MAX_CAPTURE: usize = 128 * 1024;
pub const MAX_LOG: usize = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Descriptor {
    pub device: String,
    pub inode: String,
    pub mount_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Credentials {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Context {
    pub root: Descriptor,
    pub cwd: Descriptor,
    pub net: Descriptor,
    pub mount: Descriptor,
    pub user: Descriptor,
    pub credentials: Credentials,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub enum Mode {
    #[serde(rename = "trusted-user-mapped-fs")]
    TrustedUserMappedFs,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Spec {
    pub version: u8,
    pub execution_id: String,
    pub workspace_id: String,
    pub intent_id: String,
    pub nonce: String,
    pub unit: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub timeout_seconds: u32,
    pub mode: Mode,
    pub environment_sha256: String,
    pub context: Context,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureFrame {
    pub version: u8,
    pub nonce: String,
    pub spec_sha256: String,
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Cgroup {
    pub path: String,
    pub device: String,
    pub inode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Activation {
    pub unit: String,
    pub invocation_id: String,
    pub pid: u32,
    pub start_ticks: String,
    pub boot_id: String,
    pub executable: Descriptor,
    pub command_line_sha256: String,
    pub cgroup: Cgroup,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub version: u8,
    pub execution_id: String,
    pub workspace_id: String,
    pub intent_id: String,
    pub nonce: String,
    pub spec_sha256: String,
    pub activation: Activation,
    pub mode: Mode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Claim {
    pub evidence: Evidence,
    pub context: Context,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cause {
    Normal,
    Cancelled,
    Timeout,
    ControlError,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Outcome {
    NotStarted { reason: String },
    Exit { code: i32, cause: Cause },
    Signal { signal: i32, cause: Cause },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogEnd {
    Eof,
    ServiceExit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogCount {
    pub kept: u64,
    pub dropped: u64,
    pub end: LogEnd,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub evidence: Evidence,
    pub outcome: Outcome,
    pub stdout: LogCount,
    pub stderr: LogCount,
}

pub fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn name(value: &str, limit: usize) -> bool {
    !value
        .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        .is_empty()
        && value.len() <= limit
        && !value.contains('\0')
}

impl Spec {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1
            || !name(&self.execution_id, 128)
            || !name(&self.workspace_id, 200)
            || !name(&self.intent_id, 128)
            || !hex(&self.nonce, 64)
            || !hex(&self.environment_sha256, 64)
            || !self.unit.starts_with("hdj-")
            || !self.unit.ends_with(".service")
            || self.unit.len() > 80
            || !self
                .unit
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-.".contains(&c))
            || !self.cwd.starts_with('/')
            || self.cwd.contains('\0')
            || self.cwd.len() > 4095
            || self.argv.is_empty()
            || self.argv.len() > 128
            || !self.argv[0].starts_with('/')
            || self
                .argv
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 4096)
            || self.argv.iter().map(String::len).sum::<usize>() > 16 * 1024
            || !(1..=3600).contains(&self.timeout_seconds)
        {
            return Err(invalid("Invalid immutable command spec"));
        }
        for descriptor in [
            &self.context.root,
            &self.context.cwd,
            &self.context.net,
            &self.context.mount,
            &self.context.user,
        ] {
            for value in [&descriptor.device, &descriptor.inode, &descriptor.mount_id] {
                if value.is_empty()
                    || value.len() > 20
                    || !value.bytes().all(|c| c.is_ascii_digit())
                    || value.parse::<u64>().is_err()
                {
                    return Err(invalid("Invalid descriptor identity"));
                }
            }
        }
        if self.context.credentials.groups.len() > 128 {
            return Err(invalid("Excessive credential group set"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{name, Spec};

    #[test]
    fn opaque_names_follow_ecmascript_whitespace_without_trimming() {
        for value in ["\u{85}", " padded "] {
            assert!(name(value, 128));
        }
        for value in ["\u{feff}", " \t\u{feff}\u{a0}"] {
            assert!(!name(value, 128));
        }
    }

    fn fixture_spec() -> Spec {
        let descriptor = serde_json::json!({"device":"1","inode":"2","mountId":"3"});
        serde_json::from_value(serde_json::json!({
            "version":1,"executionId":"execution","workspaceId":"workspace","intentId":"intent",
            "nonce":"0".repeat(64),"unit":"hdj-codec.service","cwd":"/","argv":["/bin/true"],
            "timeoutSeconds":1,"mode":"trusted-user-mapped-fs","environmentSha256":"0".repeat(64),
            "context":{"root":descriptor,"cwd":descriptor,"net":descriptor,"mount":descriptor,"user":descriptor,
                "credentials":{"uid":1000,"gid":100,"groups":[100]}}
        })).unwrap()
    }

    #[test]
    fn workspace_identity_keeps_200_bytes_without_widening_execution_or_intent() {
        let mut spec = fixture_spec();
        for value in [
            "w".repeat(129),
            "w".repeat(200),
            format!("{}ab", "界".repeat(66)),
        ] {
            spec.workspace_id = value;
            assert!(spec.validate().is_ok());
        }
        for value in ["w".repeat(201), "界".repeat(67), "bad\0name".to_string()] {
            spec.workspace_id = value;
            assert!(spec.validate().is_err());
        }
        spec.workspace_id = "workspace".to_string();
        spec.execution_id = "e".repeat(129);
        assert!(spec.validate().is_err());
        spec.execution_id = "execution".to_string();
        spec.intent_id = "i".repeat(129);
        assert!(spec.validate().is_err());
    }

    #[test]
    fn cwd_fits_the_getcwd_buffer_including_nul() {
        let mut spec = fixture_spec();
        spec.cwd = format!("/{}", "x".repeat(4094));
        assert!(spec.validate().is_ok());
        spec.cwd.push('x');
        assert!(spec.validate().is_err());
        spec.cwd = format!("/{}", "ä".repeat(2048));
        assert!(spec.validate().is_err());
    }
}
