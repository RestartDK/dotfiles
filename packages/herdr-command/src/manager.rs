use crate::protocol::invalid;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{SocketAddr, UnixDatagram};
use std::time::Duration;

fn notify(socket: &UnixDatagram, bytes: &[u8], fd: RawFd) -> io::Result<()> {
    let mut vector = libc::iovec {
        iov_base: bytes.as_ptr().cast_mut().cast(),
        iov_len: bytes.len(),
    };
    let mut control = [0_usize; 8];
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) } as usize;
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    unsafe {
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as usize;
        libc::CMSG_DATA(header).cast::<RawFd>().write_unaligned(fd);
    }
    let count = unsafe { libc::sendmsg(socket.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    if count as usize != bytes.len() {
        return Err(invalid("Incomplete manager notification"));
    }
    Ok(())
}

pub fn notify_namespace_store(fd: RawFd) -> io::Result<()> {
    let address = std::env::var_os("NOTIFY_SOCKET")
        .ok_or_else(|| invalid("Manager descriptor-store notification socket required"))?;
    let bytes = address.as_bytes();
    let address = if let Some(name) = bytes.strip_prefix(b"@") {
        SocketAddr::from_abstract_name(name)?
    } else {
        SocketAddr::from_pathname(std::path::Path::new(&address))?
    };
    let socket = UnixDatagram::unbound()?;
    socket.set_write_timeout(Some(Duration::from_secs(1)))?;
    socket.connect_addr(&address)?;
    notify(
        &socket,
        b"FDSTORE=1\nFDNAME=herdr-workspace-view\nFDPOLL=0",
        fd,
    )?;
    let mut raw = [-1_i32; 2];
    if unsafe { libc::pipe2(raw.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(raw[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(raw[1]) };
    notify(&socket, b"BARRIER=1", write.as_raw_fd())?;
    drop(write);
    let mut poll = libc::pollfd {
        fd: read.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&mut poll, 1, 1000) } <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Manager notification barrier deadline",
        ));
    }
    let mut byte = [0_u8; 1];
    if unsafe { libc::read(read.as_raw_fd(), byte.as_mut_ptr().cast(), 1) } != 0 {
        return Err(invalid("Manager notification barrier incomplete"));
    }
    Ok(())
}
