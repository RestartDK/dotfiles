import os
from pathlib import Path
import shutil
import shlex
import subprocess
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

    def test_missing_shell_contract_fails(self):
        self.rc.write_text("")
        result = self.run_command("touch", str(self.repo / "started"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / "started").exists())
        self.assertIn("repo_env_prepare", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
