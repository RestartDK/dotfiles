import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (exe, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
});
const json = async name => JSON.parse(await fs.readFile(name, 'utf8'));
const exists = async name => { try { await fs.access(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function until(operation, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result !== undefined) return result; await delay(20); }
  throw new Error('Proof deadline');
}
async function publish(name, value) {
  const temporary = `${name}.pending`;
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  assert.equal(await exists(name), false);
  await fs.rename(temporary, name);
  const directory = await fs.open(path.dirname(name), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function describe(file) {
  const status = await file.stat({ bigint: true });
  const info = await fs.readFile(`/proc/self/fdinfo/${file.fd}`, 'utf8');
  const mountId = info.match(/^mnt_id:\s+([0-9]+)$/m)?.[1];
  assert.ok(mountId);
  return { device: status.dev.toString(), inode: status.ino.toString(), mountId };
}

async function owner(root) {
  const mounted = await run('/run/current-system/sw/bin/mount', ['--bind', path.join(root, 'inside'), path.join(root, 'lookup')]);
  assert.equal(mounted.code, 0, mounted.stderr);
  process.chdir(repo);
  const files = [];
  for (const name of ['/', repo, '/proc/self/ns/net', '/proc/self/ns/mnt', '/proc/self/ns/user']) files.push(await fs.open(name, 'r'));
  const [rootFd, cwd, net, mount, user] = await Promise.all(files.map(describe));
  process.send({ kind: 'context', context: { root: rootFd, cwd, net, mount, user }, visible: { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() } });
  process.on('message', async message => {
    if (message.kind !== 'capture') return;
    try {
      const sender = spawn(message.helper, ['send', root, message.digest], {
        stdio: ['pipe', 'ignore', 'pipe', ...files.map(file => file.fd)],
      });
      let stderr = '';
      sender.stderr.on('data', bytes => { stderr += bytes; });
      const completed = new Promise((resolve, reject) => { sender.on('error', reject); sender.on('close', code => resolve(code)); });
      sender.stdin.end(JSON.stringify({ version: 1, nonce: message.nonce, specSha256: message.digest, environment: message.environment }));
      const code = await completed;
      assert.equal(code, 0, stderr);
      await Promise.all(files.map(file => file.close()));
      process.send({ kind: 'captured' });
    } catch (error) { process.send({ kind: 'error', message: error.message }); }
  });
}

async function payload(root, nixpkgs, variant) {
  await until(async () => await exists(path.join(root, 'owner-gone')) ? true : undefined, 20000);
  const status = await fs.readFile('/proc/self/status', 'utf8');
  const fields = Object.fromEntries(status.split('\n').filter(line => /^(CapEff|CapPrm|CapInh|CapAmb|CapBnd|NoNewPrivs):/.test(line)).map(line => line.split(':').map(part => part.trim())));
  const marker = await fs.readFile(path.join(root, 'lookup/marker'), 'utf8');
  const git = await run('/run/current-system/sw/bin/git', ['--no-optional-locks', '-C', repo, 'status', '--porcelain=v1', '--untracked-files=no']);
  const nix = '/run/current-system/sw/bin/nix';
  const evaluation = await run(nix, ['--extra-experimental-features', 'nix-command flakes', 'eval', '--offline', '--json', '--expr', '1 + 1']);
  const expression = `let p = import ${nixpkgs} { system = "x86_64-linux"; }; in p.mkShellNoCC { packages = [ p.git ]; }`;
  const shell = await run(nix, ['--extra-experimental-features', 'nix-command flakes', 'develop', '--offline', '--impure', '--expr', expression, '--command', 'git', '--version']);
  await publish(path.join(root, 'observed.json'), {
    pid: process.pid, uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
    cwd: process.cwd(), marker, fields, git, evaluation, shell,
    namespaces: Object.fromEntries(await Promise.all(['mnt', 'user', 'net'].map(async key => [key, await fs.readlink(`/proc/self/ns/${key}`)]))),
  });
  if (variant === 'helper-loss') {
    const descendant = spawn(process.execPath, [script, 'loss-child', root], { detached: true, stdio: 'ignore' });
    descendant.unref();
  }
  await until(async () => await exists(path.join(root, 'payload-finish')) ? true : undefined, 20000);
}

async function lossChild(root) {
  process.on('SIGTERM', () => {
    writeFileSync(path.join(root, 'after-helper-loss.json'), JSON.stringify({
      pid: process.pid, marker: readFileSync(path.join(root, 'lookup/marker'), 'utf8'),
      net: readlinkSync('/proc/self/ns/net'), status: readFileSync('/proc/self/status', 'utf8'),
    }), { flag: 'wx', mode: 0o600 });
  });
  await publish(path.join(root, 'descendant-ready.json'), { pid: process.pid, marker: await fs.readFile(path.join(root, 'lookup/marker'), 'utf8') });
  setInterval(() => {}, 50);
}

async function observer(variant) {
  const helper = process.env.DSTACK_COMMAND_HELPER_TEST;
  assert.ok(helper?.startsWith('/nix/store/'), 'Explicit matching packaged helper required');
  assert.equal(process.platform, 'linux');
  const root = await fs.mkdtemp(path.join(repo, '.audit/helper-'));
  await fs.chmod(root, 0o700);
  for (const directory of ['inside', 'lookup', 'home']) await fs.mkdir(path.join(root, directory), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'inside/marker'), 'inside\n');
  await fs.writeFile(path.join(root, 'lookup/marker'), 'outside\n');
  const resolved = await run('/run/current-system/sw/bin/nix', ['--extra-experimental-features', 'nix-command flakes', 'eval', '--impure', '--raw', '--expr', `(builtins.getFlake ${JSON.stringify(`git+file://${repo}`)}).inputs.nixpkgs.outPath`]);
  assert.equal(resolved.code, 0, resolved.stderr);
  const unit = `hdj-${randomUUID()}.service`;
  const nonce = randomBytes(32).toString('hex');
  const groups = [...new Set([...process.getgroups(), process.getgid()])].sort((a, b) => a - b);
  const credentials = { uid: process.getuid(), gid: process.getgid(), groups };
  const entries = [];
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'NIX_SSL_CERT_FILE', 'SSL_CERT_FILE', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key] !== undefined) entries.push([key, process.env[key]]);
  }
  entries.push(['HOME', path.join(root, 'home')], ['USER', process.env.USER ?? 'dkumlin']);
  const environment = Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const messages = [];
  const child = spawn('/run/current-system/sw/bin/unshare', ['--user', '--map-root-user', '--mount', '--propagation', 'private', process.execPath, script, 'owner', root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let ownerError = '';
  child.stderr.on('data', bytes => { ownerError += bytes; });
  child.on('message', message => messages.push(message));
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  const ctl = (...args) => run('/run/current-system/sw/bin/systemctl', ['--user', ...args]);
  const show = () => ctl('show', unit, '--property=LoadState,InvocationID,ActiveState,SubState,MainPID,NFileDescriptorStore,FileDescriptorStoreMax,FileDescriptorStorePreserve,NotifyAccess');
  const fields = output => Object.fromEntries(output.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  const processes = () => run('/run/current-system/sw/bin/busctl', ['--user', '--json=short', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnitProcesses', 's', unit]);
  let digest, expected;
  try {
    const context = await until(async () => { const found = messages.find(message => message.kind === 'context'); if (found) return found; if (child.exitCode !== null || child.signalCode !== null) throw new Error(ownerError); });
    const spec = { version: 1, executionId: randomUUID(), workspaceId: 'component-proof', intentId: 'retained-view', nonce, unit, cwd: repo,
      argv: [process.execPath, script, 'payload', root, resolved.stdout, variant], timeoutSeconds: 120, mode: 'trusted-user-mapped-fs',
      environmentSha256: sha(JSON.stringify(environment)), context: { ...context.context, credentials } };
    const bytes = JSON.stringify(spec);
    digest = sha(bytes);
    await fs.writeFile(path.join(root, 'spec.json'), bytes, { flag: 'wx', mode: 0o600 });
    const specFile = await fs.open(path.join(root, 'spec.json'), 'r'); await specFile.sync(); await specFile.close();
    const started = await run('/run/current-system/sw/bin/systemd-run', ['--user', '--quiet', `--unit=${unit}`, '--service-type=exec',
      '--property=Restart=no', '--property=KillMode=control-group', '--property=TimeoutStopSec=2s', '--property=RuntimeMaxSec=150s',
      '--property=NotifyAccess=main', '--property=FileDescriptorStoreMax=1', '--property=FileDescriptorStorePreserve=yes', helper, 'service', root, digest]);
    assert.equal(started.code, 0, started.stderr);
    await until(async () => await exists(path.join(root, 'ready.json')) ? json(path.join(root, 'ready.json')) : undefined);
    child.send({ kind: 'capture', helper, digest, nonce, environment });
    expected = await until(async () => {
      const failure = messages.find(message => message.kind === 'error'); if (failure) throw new Error(failure.message);
      if (await exists(path.join(root, 'exit.json'))) throw new Error(JSON.stringify(await json(path.join(root, 'exit.json'))));
      return await exists(path.join(root, 'captured.json')) ? json(path.join(root, 'captured.json')) : undefined;
    });
    const custody = await until(async () => { const result = await show(); const value = fields(result.stdout); return value.NFileDescriptorStore === '1' ? { result, value } : undefined; });
    assert.equal(custody.value.MainPID, String(expected.activation.pid));
    assert.equal(custody.value.InvocationID, expected.activation.invocationId);
    assert.equal(custody.value.NotifyAccess, 'main');
    assert.equal(custody.value.FileDescriptorStoreMax, '1');
    assert.equal(custody.value.FileDescriptorStorePreserve, 'yes');
    await publish(path.join(root, 'admit.json'), expected);
    await until(async () => { const failure = messages.find(message => message.kind === 'error'); if (failure) throw new Error(failure.message); return messages.find(message => message.kind === 'captured'); });
    child.kill('SIGKILL');
    const ownerExit = await exited;
    assert.equal(ownerExit.signal, 'SIGKILL');
    await fs.writeFile(path.join(root, 'owner-gone'), 'reaped');
    const observed = await until(async () => await exists(path.join(root, 'observed.json')) ? json(path.join(root, 'observed.json')) : undefined, 100000);
    const hostStatus = await fs.readFile(`/proc/${observed.pid}/status`, 'utf8');
    const hostGroups = hostStatus.match(/^Groups:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number).sort((a, b) => a - b);
    assert.deepEqual(hostGroups, groups);
    for (const [field, id] of [['Uid', credentials.uid], ['Gid', credentials.gid]]) {
      const actual = hostStatus.match(new RegExp(`^${field}:\\s+(.+)$`, 'm'))?.[1].trim().split(/\s+/).map(Number);
      assert.deepEqual(actual, [id, id, id, id]);
    }
    assert.equal(observed.uid, credentials.uid); assert.equal(observed.gid, credentials.gid);
    assert.deepEqual([...observed.groups].sort((a, b) => a - b), groups.map(group => group === credentials.gid ? group : 65534).sort((a, b) => a - b));
    assert.notEqual(observed.namespaces.mnt, `mnt:[${context.context.mount.inode}]`);
    assert.equal(observed.namespaces.net, `net:[${context.context.net.inode}]`);
    assert.equal(observed.marker, 'inside\n');
    assert.equal(await fs.readFile(path.join(root, 'lookup/marker'), 'utf8'), 'outside\n');
    for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']) assert.equal(observed.fields[key], '0000000000000000');
    assert.equal(observed.fields.NoNewPrivs, '1');
    assert.equal(observed.git.code, 0, observed.git.stderr);
    assert.equal(observed.evaluation.code, 0, observed.evaluation.stderr); assert.equal(observed.evaluation.stdout, '2\n');
    assert.equal(observed.shell.code, 0, observed.shell.stderr);
    let receipt, afterLoss;
    if (variant === 'helper-loss') {
      const descendant = await until(async () => await exists(path.join(root, 'descendant-ready.json')) ? json(path.join(root, 'descendant-ready.json')) : undefined);
      assert.equal(descendant.marker, 'inside\n');
      const original = fields((await show()).stdout);
      assert.equal(original.InvocationID, expected.activation.invocationId);
      assert.equal(original.MainPID, String(expected.activation.pid));
      const python = "import os,select,signal,sys\npid=int(sys.argv[1]);fd=os.pidfd_open(pid)\ns=open('/proc/%d/stat'%pid).read().rsplit(')',1)[1].split()[19]\nassert s==sys.argv[2]\np=select.poll();p.register(fd,select.POLLIN);assert not p.poll(0)\nsignal.pidfd_send_signal(fd,signal.SIGKILL)\nos.close(fd)";
      const killed = await run('/run/current-system/sw/bin/python3', ['-c', python, String(expected.activation.pid), expected.activation.startTicks]);
      assert.equal(killed.code, 0, killed.stderr);
      afterLoss = await until(async () => await exists(path.join(root, 'after-helper-loss.json')) ? json(path.join(root, 'after-helper-loss.json')) : undefined);
      assert.equal(afterLoss.pid, descendant.pid);
      assert.equal(afterLoss.marker, 'inside\n');
      assert.equal(afterLoss.net, `net:[${context.context.net.inode}]`);
      assert.equal(await fs.readFile(path.join(root, 'lookup/marker'), 'utf8'), 'outside\n');
    } else {
      await fs.writeFile(path.join(root, 'payload-finish'), 'finish');
      receipt = await until(async () => await exists(path.join(root, 'exit.json')) ? json(path.join(root, 'exit.json')) : undefined);
      assert.deepEqual(receipt.outcome, { kind: 'exit', code: 0, cause: 'normal' });
    }
    const drained = await until(async () => {
      const before = fields((await show()).stdout); if (before.InvocationID !== expected.activation.invocationId) throw new Error('Activation changed');
      if (before.ActiveState !== (variant === 'helper-loss' ? 'failed' : 'inactive')) return undefined;
      assert.equal(before.MainPID, '0'); assert.equal(before.NFileDescriptorStore, '1');
      const result = await processes(); assert.equal(result.code, 0); if (JSON.parse(result.stdout).data[0].length !== 0) return undefined;
      const after = fields((await show()).stdout); assert.equal(after.InvocationID, expected.activation.invocationId);
      assert.equal(after.NFileDescriptorStore, '1'); assert.equal(after.MainPID, '0'); return { before, result, after };
    });
    if (variant === 'helper-loss') assert.equal(await exists(path.join(root, 'exit.json')), false);
    const verdict = variant === 'helper-loss' ? 'packaged-private-helper-loss-only' : 'packaged-helper-component-only';
    await publish(path.join(root, 'result.json'), { verdict, helper, unit, root, sourceVisible: context.visible, custody, observed, hostGroups, ownerExit, receipt, afterLoss, drained });
    console.log(JSON.stringify({ verdict, root, helper, unit }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await fs.writeFile(path.join(root, 'payload-finish'), 'finish').catch(() => {});
    if (digest) {
      if (!await exists(path.join(root, 'cancel.json'))) await publish(path.join(root, 'cancel.json'), { version: 1, nonce, specSha256: digest }).catch(() => {});
      await run(helper, ['signal', root, digest]).catch(() => {});
      const final = await until(async () => { const value = fields((await show()).stdout); return ['inactive', 'failed'].includes(value.ActiveState) || value.LoadState === 'not-found' ? value : undefined; }, 15000);
      if (expected && final.InvocationID) assert.equal(final.InvocationID, expected.activation.invocationId);
      const live = await processes();
      if (live.code === 0) assert.deepEqual(JSON.parse(live.stdout).data, [[]]);
      if (final.ActiveState === 'failed') {
        const reset = await ctl('reset-failed', unit); assert.equal(reset.code, 0, reset.stderr);
        const inactive = fields((await show()).stdout);
        assert.equal(inactive.InvocationID, expected.activation.invocationId);
        assert.equal(inactive.ActiveState, 'inactive');
      }
      if (final.NFileDescriptorStore !== '0') {
        const clean = await ctl('clean', '--what=fdstore', unit); assert.equal(clean.code, 0, clean.stderr);
      }
      const after = await show(); assert.equal(fields(after.stdout).NFileDescriptorStore, '0');
      await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ final, live, after, ownerExited: true }, null, 2));
    }
  }
}

const mode = process.argv[2];
if (mode === 'owner') await owner(process.argv[3]);
else if (mode === 'payload') await payload(process.argv[3], process.argv[4], process.argv[5]);
else if (mode === 'loss-child') await lossChild(process.argv[3]);
else await observer(mode === 'helper-loss' ? 'helper-loss' : 'normal');
