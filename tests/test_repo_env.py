import os
import json
import pty
import select
import time
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "bin/repo-exec"
ZSH = shutil.which("zsh")
DIRENV = shutil.which("direnv")


class RepoEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.repo = self.home / "repo"
        self.repo.mkdir()
        self.env = {
            "HOME": str(self.home),
            "ZDOTDIR": str(self.home),
            "PATH": os.environ["PATH"],
            "SHELL": ZSH,
            "TERM": "dumb",
            "XDG_DATA_HOME": str(self.home / "data"),
            "XDG_CACHE_HOME": str(self.home / "cache"),
            "XDG_CONFIG_HOME": str(self.home / "config"),
        }
        self.rc = self.home / ".zshrc"
        self.rc.write_text(
            f'export PATH={shlex.quote(os.environ["PATH"])}\n'
            f'source "{ROOT}/config/shell/repo-env.zsh"\n'
        )

    def run_command(self, *args, cwd=None, env=None):
        return subprocess.run(
            [str(LAUNCHER), *args],
            cwd=cwd or self.repo,
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=20,
        )

    def allow(self, text):
        (self.repo / ".envrc").write_text(text)
        subprocess.run([DIRENV, "allow", str(self.repo)], env=self.env, check=True,
                       capture_output=True)

    def test_plain_directory(self):
        result = self.run_command("sh", "-c", 'printf "%s" "$PWD"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, str(self.repo))

    def test_shell_initialization_and_registered_hook(self):
        with self.rc.open("a") as rc:
            rc.write('echo startup-noise\nprepare_custom() { export CUSTOM_ENV=ready; }\n'
                     'repo_env_hooks+=(prepare_custom)\n')
        result = self.run_command("sh", "-c", 'printf "%s" "$CUSTOM_ENV"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "ready")
        self.assertIn("startup-noise", result.stderr)

    def test_hook_failure_blocks_command(self):
        with self.rc.open("a") as rc:
            rc.write('prepare_custom() { return 42; }\nrepo_env_hooks+=(prepare_custom)\n')
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertFalse((self.repo / "started").exists())

    def test_interactive_zsh_keeps_preparation_in_the_owned_group(self):
        gate = self.home / "prepare-gate"
        marker = self.home / "prepare-pid"
        os.mkfifo(gate)
        gate_fd = os.open(gate, os.O_RDWR | os.O_NONBLOCK)
        master, slave = pty.openpty()
        with self.rc.open("a") as rc:
            rc.write(f'prepare_custom() {{ print $$ > {shlex.quote(str(marker))}; '
                     f'IFS= read -r release < {shlex.quote(str(gate))}; }}\n'
                     'repo_env_hooks+=(prepare_custom)\n')
        child = subprocess.Popen([str(LAUNCHER), "true"], cwd=self.repo, env=self.env,
                                 stdin=slave, stdout=slave, stderr=slave)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                select.select([], [], [], 0.01)
            self.assertTrue(marker.exists(), "Preparation never reached its gate")
            shell_pid = int(marker.read_text())
            identity = subprocess.check_output(
                ["ps", "-p", str(shell_pid), "-o", "ppid=,pgid="], text=True).split()
            self.assertEqual(identity[0], identity[1],
                             "Interactive preparation escaped its anchored process group")
        finally:
            os.write(gate_fd, b"release\n")
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            for fd in (gate_fd, master, slave):
                os.close(fd)

    def test_failed_status_publication_preserves_an_accepted_payload(self):
        self.check_publication_failure(launch="handoff", failure="persistent")

    def test_failed_status_publication_does_not_strand_generic_authorization(self):
        self.check_publication_failure(launch="generic", failure="once")

    def check_publication_failure(self, *, launch, failure):
        control = self.home / "attempt"
        claim = self.home / "claim"
        control.mkdir()
        claim.mkdir()
        attempt_id = "accepted-fixture"
        (control / "attempt.json").write_text(json.dumps({
            "id": attempt_id, "claimPath": str(claim) if launch == "handoff" else None,
            "leaseMs": 60_000,
            "environmentMs": 60_000, "startupMs": 60_000,
        }))
        (claim / "owner").write_text(json.dumps({"id": attempt_id}))
        if sys.platform == "linux":
            stat = Path(f"/proc/{os.getpid()}/stat").read_text()
            birth = "linux:" + stat[stat.rfind(")") + 2:].split()[19]
        else:
            identity = subprocess.check_output(
                ["ps", "-p", str(os.getpid()), "-o", "stat=,lstart="], text=True)
            birth = "ps:" + identity.split(maxsplit=1)[1].strip()
        (control / "source").write_text(json.dumps({"pid": os.getpid(), "birth": birth}))
        (control / "lease").write_text(str(int(time.time() * 1000)))
        gate = self.home / "accepted-gate"
        started = self.home / "accepted-started"
        completed = self.home / "accepted-completed"
        fault = self.home / "publication-faults"
        os.mkfifo(gate)
        gate_fd = os.open(gate, os.O_RDWR | os.O_NONBLOCK)
        driver = r'''
import errno, importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('repo_launch', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.atomic_json
fault = Path(sys.argv[2])
failure = sys.argv[3]
count = 0
def fail_transferred(path, state):
    global count
    if state['kind'] == 'transferred':
        count += 1
        fault.write_text(str(count))
        if failure == 'persistent' or count == 1:
            raise OSError(errno.ENOSPC, 'injected publication failure')
    original(path, state)
module.atomic_json = fail_transferred
sys.argv = ['repo-exec', *sys.argv[4:]]
sys.exit(module.main())
'''
        payload = (f'touch {shlex.quote(str(started))}; '
                   f'IFS= read -r release < {shlex.quote(str(gate))}; '
                   f'touch {shlex.quote(str(completed))}')
        child = subprocess.Popen(
            [sys.executable, "-c", driver, str(ROOT / "config/shell/repo-launch.py"),
             str(fault), failure, "sh", "-c", payload], cwd=self.repo,
            env={**self.env, "REPO_LAUNCH_DIRECTORY": str(control)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            ready = False
            while time.monotonic() < deadline:
                status = control / "status"
                ready = (started.exists() if launch == "handoff" else
                         status.exists() and json.loads(status.read_text())["phase"] == "startup")
                if ready:
                    break
                select.select([], [], [], 0.01)
            self.assertTrue(ready, "Launch never reached its authorization boundary")
            if launch == "handoff":
                (claim / "decision").write_text(f"ready:{attempt_id}")
            candidate = control / "authorization-candidate"
            candidate.write_text(attempt_id)
            os.link(candidate, control / "transferred")
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                if fault.exists() and int(fault.read_text() or "0") >= 2:
                    break
                select.select([], [], [], 0.01)
            self.assertTrue(fault.exists() and int(fault.read_text() or "0") >= 2,
                            "Supervisor did not preserve accepted ownership after publication failed")
            self.assertIsNone(child.poll(), "Publication failure killed the accepted payload")
            deadline = time.monotonic() + 5
            while not started.exists() and time.monotonic() < deadline:
                select.select([], [], [], 0.01)
            self.assertTrue(started.exists(), "Authorized payload remained blocked on its grant")
            self.assertFalse(completed.exists())
        finally:
            os.write(gate_fd, b"release\n")
            try:
                _, stderr = child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                _, stderr = child.communicate()
            os.close(gate_fd)
        self.assertEqual(child.returncode, 0, stderr)
        self.assertTrue(completed.exists())
        receipt = json.loads((control / "status").read_text())
        self.assertEqual((receipt["kind"], receipt["cleanup"]), ("exited", "confirmed"))

    def test_allowed_parent_environment(self):
        self.allow('export TEST_REPO_VALUE=loaded\n')
        subdir = self.repo / "nested"
        subdir.mkdir()
        result = self.run_command("sh", "-c", 'printf "%s" "$TEST_REPO_VALUE"', cwd=subdir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "loaded")

    def test_blocked_environment_never_runs_command(self):
        (self.repo / ".envrc").write_text('export TEST_REPO_VALUE=blocked\n')
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / "started").exists())
        self.assertIn("blocked", result.stderr)

    def test_failed_environment_never_runs_command(self):
        self.allow('echo activation-failed >&2\nexit 17\n')
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / "started").exists())
        self.assertIn("activation-failed", result.stderr)

    def test_startup_cannot_consume_command_stdin(self):
        with self.rc.open("a") as rc:
            rc.write('read -r startup_input || true\n')
        result = subprocess.run(
            [str(LAUNCHER), "sh", "-c", 'IFS= read -r line; printf "%s" "$line"'],
            cwd=self.repo, env=self.env, input="command payload\n",
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "command payload")

    def test_argv_and_exit_code(self):
        value = "space ' quote ; $(touch never)\nnext line"
        result = self.run_command("printf", "%s", value)
        self.assertEqual(result.stdout, value)
        self.assertFalse((self.repo / "never").exists())
        result = self.run_command("sh", "-c", "exit 23")
        self.assertEqual(result.returncode, 23)

    def test_removes_previous_repo_environment(self):
        self.allow('export TEST_REPO_VALUE=private\n')
        result = subprocess.run(
            [DIRENV, "exec", str(self.repo), "sh", "-c",
             'cd "$1" && exec "$2" sh -c \'printf "%s" "${TEST_REPO_VALUE-unset}"\'',
             "sh", str(self.home), str(LAUNCHER)],
            cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "unset")

    def test_reapplies_environment_after_shell_initialization(self):
        self.allow('export TEST_REPO_VALUE=correct\n')
        with self.rc.open("a") as rc:
            rc.write('export TEST_REPO_VALUE=overwritten-by-startup\n')
        result = subprocess.run(
            [DIRENV, "exec", str(self.repo), str(LAUNCHER), "sh", "-c",
             'printf "%s" "$TEST_REPO_VALUE"'],
            cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "correct")

    def test_selected_lorri_provider_blocks_before_direnv_and_preserves_exports(self):
        tools = self.home / "tools"
        tools.mkdir()
        lorri = tools / "lorri"
        lorri.write_text('#!/bin/sh\n'
                         'test "$*" = "watch --once" || exit 91\n'
                         'python3 -c "import time; time.sleep(0.2)"\n'
                         'printf ready > provider-result\n')
        lorri.chmod(0o700)
        self.allow('test -f provider-result || exit 71\n'
                   'export TEST_REPO_VALUE="$(<provider-result)"\n')
        with self.rc.open("a") as rc:
            rc.write(f'export PATH={shlex.quote(str(tools))}:$PATH\n'
                     f'repo_env_providers+=({shlex.quote(str(self.repo))} lorri)\n')
        result = self.run_command("sh", "-c", 'printf "%s" "$TEST_REPO_VALUE"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "ready")

    def test_unselected_provider_never_runs_and_unknown_provider_blocks_payload(self):
        self.allow('export TEST_REPO_VALUE=ready\n')
        with self.rc.open("a") as rc:
            rc.write('lorri() { return 99; }\n')
        self.assertEqual(self.run_command("true").returncode, 0)
        with self.rc.open("a") as rc:
            rc.write(f'repo_env_providers+=({shlex.quote(str(self.repo))} unsupported)\n')
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertEqual(result.returncode, 69, result.stderr)
        self.assertFalse((self.repo / "started").exists())

    def test_missing_shell_contract_fails(self):
        self.rc.write_text("")
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / "started").exists())
        self.assertIn("repo_env_prepare", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
