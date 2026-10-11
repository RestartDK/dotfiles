"""Process ownership for a crashed dstackd.

The daemon spawns workers carrying DSTACK_PROCESS_TOKEN or DSTACK_PROCESS_SCOPE in
their environment. After a crash it must find those workers again and quiesce them,
and it must never signal a process it cannot prove it owns.

`start` is opaque. It is compared for equality and never parsed or used
arithmetically, so the daemon does not care that Linux and macOS derive it
differently. Both are wall-clock seconds with microsecond precision.

psutil reads another process's environment through /proc/<pid>/environ on Linux and
through the KERN_PROCARGS2 sysctl on macOS. On macOS that sysctl requires the target
to be free of CS_RESTRICT, which Nix-built binaries are, and reports a refusal as
AccessDenied rather than as an empty environment. The two are kept apart here
because an unreadable environment is not evidence of absence.
"""

import json
import os
import signal
import sys

import psutil

TOKEN_KEY = "DSTACK_PROCESS_TOKEN"
SCOPE_KEY = "DSTACK_PROCESS_SCOPE"
KEYS = (TOKEN_KEY, SCOPE_KEY)
ACTIONS = ("SIGTERM", "SIGKILL")
USAGE = f"usage: dstack-proc owned <{'|'.join(KEYS)}> <token>\n       dstack-proc signal <pid> <start> <{'|'.join(KEYS)}> <token> <{'|'.join(ACTIONS)}>\n       dstack-proc verify"


def fail(message):
    print(f"dstack-proc: {message}", file=sys.stderr)
    sys.exit(1)


def start_of(process):
    return f"{process.create_time():.6f}"


def same_user_processes():
    """Live, non-zombie processes owned by this user, skipping the ones that die mid-scan."""
    uid = os.getuid()
    for process in psutil.process_iter():
        try:
            if process.uids().real != uid:
                continue
            if process.status() == psutil.STATUS_ZOMBIE:
                continue
            start = start_of(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        yield process, start


def environment(process):
    """The process environment as a name-to-value mapping, or None when the kernel
    refuses to disclose it. psutil returns a mapping, so membership is by name."""
    try:
        return process.environ()
    except psutil.NoSuchProcess:
        return {}
    except psutil.AccessDenied:
        return None


def owned(key, token):
    found = []
    unreadable = []
    for process, start in same_user_processes():
        disclosed = environment(process)
        if disclosed is None:
            unreadable.append(process.pid)
            continue
        if disclosed.get(key) == token:
            found.append({"pid": process.pid, "start": start})
    if unreadable:
        print(
            "dstack-proc: the environment of these same-user processes is not readable, so"
            f" ownership of them is unknown: {' '.join(str(pid) for pid in unreadable)}",
            file=sys.stderr,
        )
    print(json.dumps(found))


def send(pid, start, key, token, action):
    number = getattr(signal, action)
    try:
        process = psutil.Process(pid)
        if process.uids().real != os.getuid() or process.status() == psutil.STATUS_ZOMBIE:
            return
        if start_of(process) != start:
            return
        disclosed = environment(process)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return
    if disclosed is None or disclosed.get(key) != token:
        return
    try:
        os.kill(pid, number)
    except ProcessLookupError:
        return


def verify():
    """Prove the two things every scan depends on, before the daemon serves clients.

    Enumeration must work, and the environment of a process this daemon spawned must be
    readable. The second is the macOS precondition: KERN_PROCARGS2 permits reading a
    different process only when that process is not CS_RESTRICT. Reading our own
    environment would prove neither, because the kernel always allows that.
    """
    uid = os.getuid()
    marker = "DSTACK_PROC_VERIFY"
    seen_self = False
    for process, _ in same_user_processes():
        if process.pid == os.getpid():
            seen_self = True
            break
    if not seen_self:
        fail("cannot enumerate this process; the process table is not readable")

    import subprocess

    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        env={**os.environ, marker: "1"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        disclosed = environment(psutil.Process(child.pid))
        if disclosed is None or disclosed.get(marker) != "1":
            fail(
                "cannot read the environment of a process this daemon spawned, so ownership"
                " of a worker could not be re-proved after a crash"
            )
    except psutil.NoSuchProcess:
        fail("the process spawned for verification exited before it could be read")
    finally:
        child.kill()
        child.wait()
    print(json.dumps({"uid": uid}))


def main(argv):
    if not argv:
        print(USAGE, file=sys.stderr)
        return 2
    command, rest = argv[0], argv[1:]
    if command == "owned":
        if len(rest) != 2 or rest[0] not in KEYS:
            print(USAGE, file=sys.stderr)
            return 2
        owned(*rest)
        return 0
    if command == "signal":
        if len(rest) != 5 or rest[2] not in KEYS or rest[4] not in ACTIONS:
            print(USAGE, file=sys.stderr)
            return 2
        try:
            pid = int(rest[0])
        except ValueError:
            print(USAGE, file=sys.stderr)
            return 2
        send(pid, rest[1], rest[2], rest[3], rest[4])
        return 0
    if command == "verify":
        if rest:
            print(USAGE, file=sys.stderr)
            return 2
        verify()
        return 0
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
