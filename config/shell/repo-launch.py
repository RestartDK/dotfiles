import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


SHELL_SCRIPT = r'''
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
'''


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def main():
    if len(sys.argv) < 2:
        print('Usage: repo-exec COMMAND [ARG...]', file=sys.stderr)
        return 64
    shell = os.environ.get('SHELL', '')
    if Path(shell).name not in ('zsh', 'bash'):
        print('repo-exec: configure zsh or bash with repo_env_prepare', file=sys.stderr)
        return 69
    os.umask(0o077)
    directory = os.environ.get('REPO_LAUNCH_DIRECTORY')
    control = Path(directory) if directory else None
    config = json.loads((control / 'attempt.json').read_text()) if control else {}
    attempt_id = config.get('id', '')
    phase = 'shell'
    started = int(time.time() * 1000)
    phase_at = started
    environment_ms = config.get('environmentMs', 600_000)
    startup_ms = config.get('startupMs', 60_000)
    deadline = started + environment_ms
    lease_ms = config.get('leaseMs', 5_000)
    anchor = None
    transferred = False
    awaiting_grant = False
    stopped = None
    reported = None

    def source_alive():
        if not control:
            return True
        try:
            source = json.loads((control / 'source').read_text())
            if source['birth'].startswith('linux:'):
                record = Path(f"/proc/{source['pid']}/stat").read_text()
                fields = record[record.rfind(')') + 2:].split()
                return fields[0] != 'Z' and 'linux:' + fields[19] == source['birth']
            value = subprocess.check_output(['ps', '-p', str(source['pid']), '-o', 'stat=,lstart='], text=True).split(maxsplit=1)
            return len(value) == 2 and not value[0].startswith('Z') and 'ps:' + value[1].strip() == source['birth']
        except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
            return False

    def publish(kind, **extra):
        nonlocal reported
        if control and reported != (kind, phase):
            state = dict(id=attempt_id, kind=kind, phase=phase, at=int(time.time() * 1000),
                         phaseAt=phase_at, deadline=deadline, supervisorPid=os.getpid(), **extra)
            atomic_json(control / 'status', state)
            with (control / 'events.jsonl').open('a') as log:
                log.write(json.dumps(state) + '\n')
            reported = (kind, phase)

    def diagnostic(message):
        try:
            print(message, file=sys.stderr)
        except OSError:
            pass

    def stop_decision():
        claim = config.get('claimPath')
        if not claim:
            return 'stopped'
        claim = Path(claim)
        lock = Path(str(claim) + '.lock')
        try:
            lock.mkdir()
        except OSError:
            return 'uncertain'
        outcome = 'uncertain'
        try:
            owner = json.loads((claim / 'owner').read_text())
            if owner.get('id') == attempt_id:
                decision = claim / 'decision'
                try:
                    value = decision.read_text()
                except FileNotFoundError:
                    candidate = control / 'stop-decision'
                    candidate.write_text('stopped')
                    try:
                        os.link(candidate, decision)
                    except FileExistsError:
                        pass
                    value = decision.read_text()
                outcome = 'ready' if value == f'ready:{attempt_id}' else 'stopped' if value == 'stopped' else 'uncertain'
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        finally:
            try:
                lock.rmdir()
            except OSError:
                outcome = 'uncertain'
        return outcome

    def request_stop(signum, _frame):
        nonlocal stopped
        stopped = 'cancelled' if signum == signal.SIGINT else 'sourceLost'

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, request_stop)

    events_read, events_write = os.pipe()
    grant_read, grant_write = os.pipe()
    hold_read, hold_write = os.pipe()
    for name in ('events_write', 'grant_read'):
        old = events_write if name == 'events_write' else grant_read
        descriptor = fcntl.fcntl(old, fcntl.F_DUPFD, 10)
        os.set_inheritable(descriptor, True)
        os.close(old)
        if name == 'events_write':
            events_write = descriptor
        else:
            grant_read = descriptor
    anchor = os.fork()
    if anchor == 0:
        os.close(events_read)
        os.close(grant_write)
        os.close(hold_write)
        os.setsid()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        os.write(events_write, b'anchor\n')
        if os.read(hold_read, 1) != b's':
            os._exit(125)
        environment = dict(os.environ, REPO_ENV_LAUNCH='1',
                           REPO_ENV_EVENT_FD='5', REPO_ENV_GRANT_FD='6')
        os.dup2(1, 3)
        os.dup2(0, 4)
        os.dup2(events_write, 5)
        os.dup2(grant_read, 6)
        def reset_signals():
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(sig, signal.SIG_DFL)
        try:
            child = subprocess.Popen(
                [shell, '+m', '-ic', SHELL_SCRIPT, 'repo-exec', *sys.argv[1:]],
                env=environment, pass_fds=(3, 4, 5, 6),
                stdin=subprocess.DEVNULL, stdout=sys.stderr,
                preexec_fn=reset_signals,
            )
            while child.poll() is None:
                readable, _, _ = select.select([hold_read], [], [], 0.05)
                if readable and not os.read(hold_read, 1):
                    os.killpg(os.getpgrp(), signal.SIGKILL)
            code = child.returncode
            code = code if code >= 0 else 128 - code
        except OSError as error:
            print(f'repo-exec: cannot start shell ({error.strerror})', file=sys.stderr)
            code = 127
        os.write(events_write, f'exit:{code}\n'.encode())
        os.read(hold_read, 1)
        os.killpg(os.getpgrp(), signal.SIGKILL)
        os._exit(0)

    os.close(events_write)
    os.close(grant_read)
    os.close(hold_read)
    group_ready = False

    def forward_resize(signum, _frame):
        if group_ready:
            os.killpg(anchor, signum)

    signal.signal(signal.SIGWINCH, forward_resize)
    code = 125
    buffer = b''
    if control:
        (control / 'started').touch()
    publish('active')
    try:
        while True:
            now = int(time.time() * 1000)
            if control and not transferred:
                try:
                    decision = (control / 'stop').read_text().strip()
                    if decision in ('failed', 'cancelled', 'timedout', 'sourceLost'):
                        stopped = decision
                    else:
                        stopped = 'failed'
                except FileNotFoundError:
                    pass
                if not stopped and (control / 'transferred').exists():
                    if (control / 'transferred').read_text() != attempt_id:
                        stopped = 'failed'
                        continue
                    if awaiting_grant:
                        os.write(grant_write, b'start\n')
                        awaiting_grant = False
                    transferred = True
                    phase = 'transferred'
                    phase_at = now
                    publish('transferred')
                if not transferred and not source_alive():
                    stopped = stopped or 'sourceLost'
                if not transferred and now - (control / 'lease').stat().st_mtime * 1000 > lease_ms:
                    stopped = stopped or 'sourceLost'
            if not transferred and now >= deadline:
                stopped = stopped or 'timedout'
            if stopped:
                if not reported or reported[0] not in ('stopping', 'recoveryRequired'):
                    publish('stopping', reason=stopped)
                decision = stop_decision()
                if decision == 'ready':
                    transferred = True
                    stopped = None
                    phase = 'transferred'
                    phase_at = now
                    publish('transferred')
                elif decision == 'uncertain':
                    publish('recoveryRequired', reason=stopped)
                    select.select([], [], [], 0.05)
                    continue
                else:
                    break
            readable, _, _ = select.select([events_read], [], [], 0.05)
            if not readable:
                continue
            data = os.read(events_read, 4096)
            if not data:
                stopped = 'failed'
                break
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if line == b'anchor':
                    group_ready = True
                    os.write(hold_write, b's')
                elif line == b'environment':
                    phase = 'environment'
                    phase_at = now
                    publish('active')
                elif line == b'prepared':
                    phase = 'startup'
                    phase_at = now
                    deadline = now + startup_ms
                    if control and (control / 'stop').exists():
                        stopped = 'cancelled'
                        break
                    if not source_alive():
                        stopped = 'sourceLost'
                        break
                    if not control:
                        transferred = True
                        phase = 'transferred'
                    publish('transferred' if transferred else 'active')
                    if not control or config.get('claimPath'):
                        os.write(grant_write, b'start\n')
                    else:
                        awaiting_grant = True
                elif line.startswith(b'exit:'):
                    code = int(line[5:])
                    stopped = None if transferred else 'failed'
                    return_code = code
                    return return_code
    except (OSError, ValueError, TypeError, KeyError) as error:
        diagnostic(f'repo-exec: supervision failed ({type(error).__name__}); reconciling ownership')
        stopped = 'failed'
        code = 70
        while True:
            decision = 'ready' if transferred and stopped in (None, 'failed') else stop_decision()
            if decision == 'stopped':
                break
            if decision == 'ready':
                transferred = True
                stopped = None
                phase = 'transferred'
            try:
                publish('transferred' if transferred else 'recoveryRequired', **({} if transferred else {'reason': stopped}))
            except OSError:
                pass
            try:
                readable, _, _ = select.select([events_read], [], [], 0.05)
                if not readable:
                    continue
                data = os.read(events_read, 4096)
            except OSError:
                select.select([], [], [], 0.05)
                continue
            if not data:
                select.select([], [], [], 0.05)
                continue
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if line.startswith(b'exit:'):
                    code = int(line[5:])
                    return code
    finally:
        signal.signal(signal.SIGWINCH, signal.SIG_IGN)
        if group_ready:
            os.killpg(anchor, signal.SIGTERM)
            select.select([], [], [], 0.2)
            os.killpg(anchor, signal.SIGKILL)
        else:
            os.kill(anchor, signal.SIGKILL)
        quiescent = not group_ready
        cleanup_deadline = time.monotonic() + 2
        while group_ready and time.monotonic() < cleanup_deadline:
            try:
                processes = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True)
                quiescent = not any(int(fields[0]) == anchor and not fields[1].startswith('Z')
                                    for line in processes.splitlines() if len(fields := line.split()) == 2)
            except (OSError, ValueError, subprocess.SubprocessError):
                break
            if quiescent:
                break
            select.select([], [], [], 0.05)
        os.waitpid(anchor, 0)
        for fd in (events_read, grant_write, hold_write):
            os.close(fd)
        if stopped == 'timedout':
            code = 124
        elif stopped in ('cancelled', 'sourceLost'):
            code = 125
        try:
            if quiescent:
                publish('exited', code=code, reason=stopped, cleanup='confirmed')
            else:
                publish('recoveryRequired', reason=stopped or 'failed')
        except OSError:
            diagnostic('repo-exec: could not record cleanup; ownership recovery is required')
    return code


if __name__ == '__main__':
    sys.exit(main())
