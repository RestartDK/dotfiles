import os
from pathlib import Path
import subprocess
import sys
from test_repo_env import RepoEnvironmentTests, ROOT, LAUNCHER

binary = str(Path(sys.argv[1]).resolve())
fixture = RepoEnvironmentTests()
fixture.setUp()
try:
    tools = fixture.home / "tools"
    tools.mkdir()
    pi = tools / "pi"
    pi.write_text('#!/bin/sh\nprintf "provider model\\n"\n'
                  'if [ "${TEST_REPO_VALUE:-}" = ready ]; then printf "fixture authenticated\\n"; fi\n')
    pi.chmod(0o700)
    fixture.rc.write_text(
        f'export PATH="{tools}:{os.environ["PATH"]}"\n'
        f'source "{ROOT}/config/shell/repo-env.zsh"\n'
    )
    (fixture.repo / ".scatterer.toml").write_text(f'[env]\nlauncher = ["{LAUNCHER}"]\n')
    fixture.allow("export TEST_REPO_VALUE=ready\n")
    before = subprocess.run([str(pi), "--list-models"], env=fixture.env,
                            capture_output=True, text=True, check=True)
    assert "authenticated" not in before.stdout
    print("BEFORE direct discovery misses repo-authenticated model")
    after = subprocess.run([binary, "models"], cwd=fixture.repo, env=fixture.env,
                           capture_output=True, text=True, timeout=30)
    assert after.returncode == 0, after.stderr
    assert "fixture/authenticated" in after.stdout, after.stdout
    print("AFTER Scatterer models discovers repo-authenticated model")
    fixture.allow("exit 17\n")
    failed = subprocess.run([binary, "models"], cwd=fixture.repo, env=fixture.env,
                            capture_output=True, text=True, timeout=30)
    assert failed.returncode != 0
    assert "default" not in failed.stdout
    print("PASS Scatterer reports activation failure instead of a reduced model list")
finally:
    fixture.doCleanups()
