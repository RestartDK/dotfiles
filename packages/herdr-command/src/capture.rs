use crate::protocol::{invalid, CaptureFrame, Context, Credentials, Descriptor, Spec, MAX_CAPTURE};
use crate::store::sha256;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const NS_GET_NSTYPE: libc::c_ulong = 0xb703;

pub struct Captured {
    pub fds: Vec<OwnedFd>,
    pub environment: std::collections::BTreeMap<String, String>,
}

pub fn descriptor(fd: RawFd) -> io::Result<Descriptor> {
    let path = format!("/proc/self/fd/{fd}");
    let metadata = fs::metadata(path)?;
    let info = fs::read_to_string(format!("/proc/self/fdinfo/{fd}"))?;
    let mount_id = info
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("Descriptor has no mount identity"))?;
    Ok(Descriptor {
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
        mount_id: mount_id.to_owned(),
    })
}

pub fn credentials() -> io::Result<Credentials> {
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if !(0..=128).contains(&count) {
        return Err(invalid("Cannot observe credential groups"));
    }
    let mut groups = vec![0_u32; count as usize];
    if unsafe { libc::getgroups(count, groups.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    groups.push(gid);
    groups.sort_unstable();
    groups.dedup();
    Ok(Credentials { uid, gid, groups })
}

pub fn frame(bytes: &[u8], spec: &Spec, digest: &str) -> io::Result<CaptureFrame> {
    if bytes.len() > MAX_CAPTURE {
        return Err(invalid("Capture frame too large"));
    }
    let frame: CaptureFrame =
        serde_json::from_slice(bytes).map_err(|_| invalid("Invalid capture frame"))?;
    if frame.version != 1 || frame.nonce != spec.nonce || frame.spec_sha256 != digest {
        return Err(invalid("Capture binding mismatch"));
    }
    for (key, value) in &frame.environment {
        let mut bytes = key.bytes();
        if !matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
            || !bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || value.contains('\0')
        {
            return Err(invalid("Invalid capture environment"));
        }
    }
    let encoded = serde_json::to_vec(&frame.environment)?;
    if sha256(&encoded) != spec.environment_sha256 {
        return Err(invalid("Environment binding mismatch"));
    }
    Ok(frame)
}

struct Packet {
    count: usize,
    fds: Vec<OwnedFd>,
    records: usize,
}

fn packet(stream: &UnixStream, bytes: &mut [u8]) -> io::Result<Packet> {
    let mut vector = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut ancillary = [0_usize; 16];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = size_of::<[usize; 16]>();
    let count = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut fds = Vec::new();
    let mut valid = true;
    let mut records = 0;
    let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    while !header.is_null() {
        let control = unsafe { &*header };
        records += 1;
        let base = unsafe { libc::CMSG_LEN(0) } as usize;
        let offset = header as usize - message.msg_control as usize;
        if control.cmsg_len < base
            || control.cmsg_len > message.msg_controllen.saturating_sub(offset)
        {
            valid = false;
            break;
        }
        if control.cmsg_level == libc::SOL_SOCKET && control.cmsg_type == libc::SCM_RIGHTS {
            let length = control.cmsg_len - base;
            if !length.is_multiple_of(size_of::<RawFd>()) {
                valid = false;
            }
            let data = unsafe { libc::CMSG_DATA(header).cast::<RawFd>() };
            for index in 0..length / size_of::<RawFd>() {
                let fd = unsafe { data.add(index).read_unaligned() };
                if fd < 0 {
                    valid = false;
                } else {
                    fds.push(unsafe { OwnedFd::from_raw_fd(fd) });
                }
            }
        } else {
            valid = false;
        }
        header = unsafe { libc::CMSG_NXTHDR(&message, header) };
    }
    if !valid || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
        return Err(invalid("Invalid or truncated ancillary transfer"));
    }
    Ok(Packet {
        count: count as usize,
        fds,
        records,
    })
}

fn receive_rights(stream: &UnixStream) -> io::Result<Vec<OwnedFd>> {
    let mut marker = [0_u8; 1];
    let received = packet(stream, &mut marker)?;
    if received.count != 1 || marker != [b'F'] || received.records != 1 || received.fds.len() != 5 {
        return Err(invalid("Incomplete descriptor transfer"));
    }
    Ok(received.fds)
}

fn read_clean_exact(stream: &UnixStream, mut bytes: &mut [u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let received = packet(stream, bytes)?;
        if received.records != 0 || !received.fds.is_empty() {
            return Err(invalid("Unexpected additional descriptor transfer"));
        }
        if received.count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Short capture frame",
            ));
        }
        bytes = &mut bytes[received.count..];
    }
    Ok(())
}

fn expect_eof(stream: &UnixStream) -> io::Result<()> {
    let mut byte = [0_u8; 1];
    let received = packet(stream, &mut byte)?;
    if received.count != 0 || received.records != 0 || !received.fds.is_empty() {
        return Err(invalid("Unexpected capture frame suffix"));
    }
    Ok(())
}

pub fn receive(
    stream: UnixStream,
    spec: &Spec,
    digest: &str,
) -> io::Result<(Captured, UnixStream)> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut peer: libc::ucred = unsafe { zeroed() };
    let mut size = size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size as usize != size_of::<libc::ucred>()
        || peer.uid != spec.context.credentials.uid
        || peer.gid != spec.context.credentials.gid
    {
        return Err(invalid("Capture peer credentials mismatch"));
    }
    let mut groups = [0_u32; 128];
    let mut length = size_of::<[u32; 128]>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERGROUPS,
            groups.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if !(length as usize).is_multiple_of(size_of::<u32>())
        || length as usize > size_of::<[u32; 128]>()
    {
        return Err(invalid("Invalid peer group context"));
    }
    let mut groups = groups[..length as usize / size_of::<u32>()].to_vec();
    groups.push(peer.gid);
    groups.sort_unstable();
    groups.dedup();
    if groups != spec.context.credentials.groups {
        return Err(invalid("Capture peer groups mismatch"));
    }
    let fds = receive_rights(&stream)?;
    let actual: Vec<Descriptor> = fds
        .iter()
        .map(|fd| descriptor(fd.as_raw_fd()))
        .collect::<io::Result<_>>()?;
    let expected = [
        &spec.context.root,
        &spec.context.cwd,
        &spec.context.net,
        &spec.context.mount,
        &spec.context.user,
    ];
    if actual.iter().zip(expected).any(|(got, want)| got != want) {
        return Err(invalid("Captured lookup context changed"));
    }
    for (fd, kind) in
        fds[2..]
            .iter()
            .zip([libc::CLONE_NEWNET, libc::CLONE_NEWNS, libc::CLONE_NEWUSER])
    {
        if unsafe { libc::ioctl(fd.as_raw_fd(), NS_GET_NSTYPE) } != kind {
            return Err(invalid("Transferred namespace has the wrong kind"));
        }
    }
    for fd in &fds[..2] {
        let mode = fs::metadata(format!("/proc/self/fd/{}", fd.as_raw_fd()))?.mode();
        if mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(invalid("Capture root or cwd is not a directory"));
        }
    }
    let net = File::open("/proc/self/ns/net")?;
    if descriptor(net.as_raw_fd())? != spec.context.net {
        return Err(invalid("Approved network context unavailable"));
    }
    if credentials()? != spec.context.credentials {
        return Err(invalid("Service credential context mismatch"));
    }
    let mut length = [0_u8; 4];
    read_clean_exact(&stream, &mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_CAPTURE {
        return Err(invalid("Capture frame too large"));
    }
    let mut bytes = vec![0_u8; length];
    read_clean_exact(&stream, &mut bytes)?;
    expect_eof(&stream)?;
    let frame = frame(&bytes, spec, digest)?;
    Ok((
        Captured {
            fds,
            environment: frame.environment,
        },
        stream,
    ))
}

pub fn acknowledge(stream: &mut UnixStream, digest: &str) -> io::Result<()> {
    stream.write_all(digest.as_bytes())
}

pub fn send(mut stream: UnixStream, bytes: &[u8], spec: &Spec, digest: &str) -> io::Result<()> {
    frame(bytes, spec, digest)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let raw: Vec<RawFd> = (3..=7).collect();
    let expected = [
        &spec.context.root,
        &spec.context.cwd,
        &spec.context.net,
        &spec.context.mount,
        &spec.context.user,
    ];
    for (&fd, wanted) in raw.iter().zip(expected) {
        if descriptor(fd)? != *wanted {
            return Err(invalid("Inherited descriptor context mismatch"));
        }
    }
    let mut marker = [b'F'];
    let mut vector = libc::iovec {
        iov_base: marker.as_mut_ptr().cast(),
        iov_len: 1,
    };
    let mut ancillary = [0_usize; 16];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen =
        unsafe { libc::CMSG_SPACE((raw.len() * size_of::<RawFd>()) as u32) } as usize;
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    unsafe {
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN((raw.len() * size_of::<RawFd>()) as u32) as usize;
        std::ptr::copy_nonoverlapping(
            raw.as_ptr().cast::<u8>(),
            libc::CMSG_DATA(header),
            raw.len() * size_of::<RawFd>(),
        );
    }
    if unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) } != 1 {
        return Err(io::Error::last_os_error());
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    stream.shutdown(std::net::Shutdown::Write)?;
    let mut acknowledgement = [0_u8; 64];
    stream.read_exact(&mut acknowledgement)?;
    if acknowledgement != digest.as_bytes() {
        return Err(invalid("Capture acknowledgement mismatch"));
    }
    Ok(())
}

pub fn context(fds: &[OwnedFd], credentials: Credentials) -> io::Result<Context> {
    if fds.len() != 5 {
        return Err(invalid("Incomplete context"));
    }
    Ok(Context {
        root: descriptor(fds[0].as_raw_fd())?,
        cwd: descriptor(fds[1].as_raw_fd())?,
        net: descriptor(fds[2].as_raw_fd())?,
        mount: descriptor(fds[3].as_raw_fd())?,
        user: descriptor(fds[4].as_raw_fd())?,
        credentials,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn count_fds() -> usize {
        fs::read_dir("/proc/self/fd").expect("fd directory").count()
    }

    fn transmit(stream: &UnixStream, bytes: &[u8], fd: RawFd, count: usize) {
        let raw = vec![fd; count];
        let mut vector = libc::iovec {
            iov_base: bytes.as_ptr().cast_mut().cast(),
            iov_len: bytes.len(),
        };
        let space = unsafe { libc::CMSG_SPACE((count * size_of::<RawFd>()) as u32) } as usize;
        let mut control = vec![0_usize; space.div_ceil(size_of::<usize>())];
        let mut message: libc::msghdr = unsafe { zeroed() };
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        if count > 0 {
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = space;
            let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
            unsafe {
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN((count * size_of::<RawFd>()) as u32) as usize;
                std::ptr::copy_nonoverlapping(
                    raw.as_ptr().cast::<u8>(),
                    libc::CMSG_DATA(header),
                    count * size_of::<RawFd>(),
                );
            }
        }
        assert_eq!(
            unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) },
            bytes.len() as isize
        );
    }

    #[test]
    fn rejected_transfers_close_every_received_descriptor() {
        if std::env::var_os("DSTACK_FD_TEST_CHILD").is_none() {
            let status = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "capture::tests::rejected_transfers_close_every_received_descriptor",
                    "--test-threads=1",
                ])
                .env("DSTACK_FD_TEST_CHILD", "1")
                .status()
                .expect("isolated fd test");
            assert!(status.success());
            return;
        }
        let source = File::open("/dev/null").expect("source");
        for (marker, count) in [
            (b'F', 0),
            (b'F', 1),
            (b'F', 4),
            (b'F', 6),
            (b'F', 40),
            (b'X', 5),
        ] {
            let (send, receive) = UnixStream::pair().expect("pair");
            let before = count_fds();
            transmit(&send, &[marker], source.as_raw_fd(), count);
            assert!(
                receive_rights(&receive).is_err(),
                "marker={marker}, count={count}"
            );
            assert_eq!(count_fds(), before, "refusal leaked descriptors");
        }
        let (send, receive) = UnixStream::pair().expect("pair");
        let before = count_fds();
        transmit(&send, b"F", source.as_raw_fd(), 5);
        let received = receive_rights(&receive).expect("complete transfer");
        assert_eq!(count_fds(), before + 5);
        drop(received);
        assert_eq!(count_fds(), before);

        let (send, receive) = UnixStream::pair().expect("pair");
        let before = count_fds();
        transmit(&send, &[0, 0, 0, 1], source.as_raw_fd(), 1);
        assert!(read_clean_exact(&receive, &mut [0_u8; 4]).is_err());
        assert_eq!(
            count_fds(),
            before,
            "mid-frame ancillary leaked a descriptor"
        );

        let (mut send, receive) = UnixStream::pair().expect("pair");
        send.write_all(&[0, 0]).expect("short header");
        send.shutdown(std::net::Shutdown::Write).expect("shutdown");
        assert_eq!(
            read_clean_exact(&receive, &mut [0_u8; 4])
                .expect_err("short header")
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        let (send, receive) = UnixStream::pair().expect("pair");
        let before = count_fds();
        transmit(&send, b"X", source.as_raw_fd(), 1);
        assert!(expect_eof(&receive).is_err());
        assert_eq!(count_fds(), before, "suffix ancillary leaked a descriptor");
    }
}
