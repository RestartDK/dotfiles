use crate::protocol::invalid;
use std::io;
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

pub fn read_frame(fd: RawFd, limit: usize, timeout: Duration) -> io::Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    let mut result = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Capture input deadline"))?;
        let millis = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let status = unsafe { libc::poll(&mut poll, 1, millis) };
        if status < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if status == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Capture input deadline",
            ));
        }
        if poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(invalid("Capture input unavailable"));
        }
        let wanted = buffer.len().min(limit + 1 - result.len());
        let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), wanted) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Ok(result);
        }
        result.extend_from_slice(&buffer[..count as usize]);
        if result.len() > limit {
            return Err(invalid("Capture frame too large"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    #[test]
    fn input_is_bounded_by_time_and_bytes_and_requires_eof() {
        let (mut writer, reader) = UnixStream::pair().expect("pair");
        assert_eq!(
            read_frame(reader.as_raw_fd(), 16, Duration::from_millis(10))
                .expect_err("stalled input")
                .kind(),
            io::ErrorKind::TimedOut
        );
        writer.write_all(b"frame").expect("write");
        writer.shutdown(std::net::Shutdown::Write).expect("EOF");
        assert_eq!(
            read_frame(reader.as_raw_fd(), 16, Duration::from_secs(1)).expect("frame"),
            b"frame"
        );
        let (mut writer, reader) = UnixStream::pair().expect("pair");
        writer.write_all(&[b'x'; 17]).expect("write");
        assert_eq!(
            read_frame(reader.as_raw_fd(), 16, Duration::from_secs(1))
                .expect_err("oversized input")
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
