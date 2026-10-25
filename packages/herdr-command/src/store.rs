use crate::protocol::invalid;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub struct Directory {
    file: File,
}

fn component(name: &str) -> io::Result<CString> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return Err(invalid("Invalid record name"));
    }
    CString::new(name).map_err(|_| invalid("Invalid record name"))
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn current_uid() -> u32 {
    unsafe { libc::geteuid() }
}

pub fn private_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != current_uid()
        || metadata.nlink() != 1
    {
        return Err(invalid("Record is not a private single-link file"));
    }
    Ok(())
}

impl Directory {
    pub fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || fs::canonicalize(path)? != path {
            return Err(invalid("Job directory is not canonical"));
        }
        let raw = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| invalid("Invalid job directory"))?;
        let fd = unsafe {
            libc::open(
                raw.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if metadata.mode() & 0o7777 != 0o700 || metadata.uid() != current_uid() {
            return Err(invalid("Job directory is not private"));
        }
        let mut status: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(fd, &mut status) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if [0x6969, 0xff534d42, 0x517b].contains(&status.f_type) {
            return Err(invalid("Command state must use a local filesystem"));
        }
        Ok(Self { file })
    }

    pub fn descriptor_path(&self, name: &str) -> io::Result<PathBuf> {
        component(name)?;
        Ok(PathBuf::from(format!(
            "/proc/self/fd/{}/{}",
            self.file.as_raw_fd(),
            name
        )))
    }

    pub fn read(&self, name: &str, limit: usize) -> io::Result<Vec<u8>> {
        let name = component(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        private_file(&file)?;
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(invalid("Record exceeds its byte limit"));
        }
        Ok(bytes)
    }

    pub fn create(&self, name: &str) -> io::Result<File> {
        let name = component(name)?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        private_file(&file)?;
        Ok(file)
    }

    pub fn commit_new<T: Serialize>(&self, name: &str, value: &T) -> io::Result<()> {
        let bytes = serde_json::to_vec(value)?;
        let mut file = self.create(name)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        self.file.sync_all()
    }

    pub fn publish<T: Serialize>(&self, name: &str, value: &T) -> io::Result<()> {
        let temporary = format!(".{name}.pending");
        self.commit_new(&temporary, value)?;
        let from = component(&temporary)?;
        let to = component(name)?;
        let fd = self.file.as_raw_fd();
        if unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                fd,
                from.as_ptr(),
                fd,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        self.file.sync_all()
    }
}
