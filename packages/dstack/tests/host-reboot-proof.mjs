import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.DSTACK_FAULT_VM, '1');
assert.equal(hostname(), 'durable-proof');
assert.equal(process.getuid(), 1000);
const root = '/home/proof/reboot', cwd = join(root, 'workspace'), config = join(root, 'config.json');
const node = process.env.DSTACK_TEST_NODE, fixture = process.env.DSTACK_VM_FIXTURE;
assert.ok(node?.startsWith('/nix/store/') && fixture?.startsWith('/nix/store/'));
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
function object(value) { assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; }
async function start() {
  const child = fork(fixture, [config, 'normal'], { execPath: node, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', next = 0, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const deadline = setTimeout(() => readyReject(new Error('VM backend readiness deadline')), 20000);
  child.stderr.on('data', chunk => { if (errors.length < 32768) errors += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', error => { readyReject(error); reject(error); });
    child.once('exit', (code, signal) => {
      const error = new Error(`VM backend exited ${code}/${signal}: ${errors}`);
      readyReject(error);
      for (const request of pending.values()) { clearTimeout(request.deadline); request.reject(error); }
      pending.clear(); resolve({ code, signal });
    });
  });
  child.on('message', value => {
    const message = object(value);
    if (message.event === 'ready') readyResolve();
    else if (typeof message.id === 'number') {
      const request = pending.get(message.id);
      if (request !== undefined) {
        clearTimeout(request.deadline); pending.delete(message.id);
        if ('error' in message) request.reject(new Error('VM trusted request refused'));
        else request.resolve(message.value);
      }
    }
  });
  try { await ready; } finally { clearTimeout(deadline); }
  return {
    child, exit,
    call(request) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { pending.delete(id); reject(new Error('VM request deadline')); }, 15000);
        pending.set(id, { resolve, reject, deadline }); child.send({ id, ...request });
      });
    },
  };
}
const stage = process.argv[2];
if (stage === 'before') {
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ identity: { deploymentId: 'private-vm-fault-proof', domain: 'personal', nodeId: 'durable-proof' }, stateRoot: join(root, 'state'), model: { provider: 'host-command-fixture', modelId: 'idle' }, thinkingLevel: 'off', authPath: join(root, 'unused-auth.json'), modelsPath: join(root, 'unused-models.json'), execution: { mode: 'durable', maxRecords: 128 } }), { flag: 'wx', mode: 0o600, flush: true });
}
const backend = await start();
const command = (op, intentId = 'once') => backend.call({ command: { op, workspaceId: 'coding', intentId } });
const operation = value => backend.call({ operation: value });
try {
  if (stage === 'before') {
    await operation({ op: 'create', requestId: 'create', workspaceId: 'coding', cwd });
    const authorization = { intentId: 'once', argv: [node, '-e', "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'wx',384);fs.writeFileSync(fd,'once');fs.fsyncSync(fd);fs.closeSync(fd);const d=fs.openSync(require('node:path').dirname(process.argv[1]),'r');fs.fsyncSync(d);fs.closeSync(d)", join(cwd, 'once.txt')], timeoutSeconds: 10 };
    const authorized = object(await backend.call({ command: { op: 'authorize', workspaceId: 'coding', authorization } }));
    const spec = JSON.parse(authorized.authorization.specJson);
    const sdk = object(await command('start'));
    let observation;
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      observation = object(await command('inspect'));
      if (observation.outcome.kind === 'recorded' && observation.containment.kind === 'empty') break;
      await delay(20);
    }
    assert.equal(observation.outcome.kind, 'recorded'); assert.equal(observation.containment.kind, 'empty');
    assert.deepEqual(observation.outcome.receipt.outcome, { kind: 'exit', code: 0, cause: 'normal' });
    assert.equal(observation.outcome.receipt.evidence.activation.bootId, bootId);
    await backend.call({ command: { op: 'authorize', workspaceId: 'coding', authorization: { intentId: 'unused', argv: [node, '-e', "require('node:fs').writeFileSync(process.argv[1],'replayed',{flag:'wx'})", join(cwd, 'must-not-run.txt')], timeoutSeconds: 10 } } });
    assert.equal(object(await command('describe', 'unused')).grant, 'live');
    const before = { bootId, spec, receipt: observation.outcome.receipt, sdk, status: await operation({ op: 'execution.status', workspaceId: 'coding' }) };
    await writeFile(join(root, 'before-ready.json'), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    console.log(JSON.stringify({ event: 'before-power-cut', bootId, unit: spec.unit, invocationId: observation.outcome.receipt.evidence.activation.invocationId, sdk }));
    await new Promise(() => undefined);
  } else {
    assert.equal(stage, 'after');
    const before = JSON.parse(await readFile(join(root, 'before-ready.json'), 'utf8'));
    assert.notEqual(bootId, before.bootId, 'Actual kernel boot UUID must change');
    assert.equal(await readFile(join(cwd, 'once.txt'), 'utf8'), 'once');
    assert.equal(object(await command('describe', 'unused')).grant, 'expired');
    const observation = object(await command('inspect'));
    assert.equal(observation.outcome.kind, 'recorded');
    assert.deepEqual(observation.outcome.receipt, before.receipt, 'Manager loss must preserve the bound original receipt');
    assert.equal(observation.containment.kind, 'unknown');
    assert.equal(object(await command('adopt')).phase.kind, 'activated', 'No fabricated empty containment after reboot');
    await assert.rejects(command('release'));
    const manager = process.env.DSTACK_SYSTEMCTL, runner = process.env.DSTACK_SYSTEMD_RUN;
    assert.ok(manager !== undefined && runner !== undefined);
    const replacement = spawnSync(runner, ['--user', '--quiet', `--unit=${before.spec.unit}`, '--service-type=exec', '--property=RuntimeMaxSec=60s', node, '-e', 'setInterval(()=>{},1000)'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(replacement.status, 0, replacement.stderr);
    function unit() {
      const result = spawnSync(manager, ['--user', 'show', before.spec.unit, '--property=InvocationID,MainPID,ActiveState'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      return Object.fromEntries(result.stdout.trim().split('\n').map(line => { const equal = line.indexOf('='); return [line.slice(0, equal), line.slice(equal + 1)]; }));
    }
    const originalReplacement = unit();
    assert.equal(originalReplacement.ActiveState, 'active');
    assert.notEqual(originalReplacement.InvocationID, before.receipt.evidence.activation.invocationId);
    assert.ok(Number(originalReplacement.MainPID) > 0);
    for (let index = 0; index < 2; index++) { await assert.rejects(command('cancel')); assert.deepEqual(unit(), originalReplacement, 'Never signal or stop the replacement unit'); }
    assert.equal(object(await command('start')).command.phase.kind, 'activated');
    const changed = object(await command('inspect'));
    assert.equal(changed.outcome.kind, 'recorded'); assert.deepEqual(changed.outcome.receipt, before.receipt); assert.equal(changed.containment.kind, 'unknown');
    await assert.rejects(operation({ op: 'command.reconcile', workspaceId: 'coding', intentId: 'once', reference: 'cannot borrow replacement containment', containment: { kind: 'manager' } }));
    await operation({ op: 'command.reconcile', workspaceId: 'coding', intentId: 'once', reference: 'driver observed original private VM power cut and a distinct kernel boot', containment: { kind: 'trusted-offline', reference: `private VM kernel ${before.bootId} stopped; current ${bootId}` } });
    await assert.rejects(command('release'), 'Offline acknowledgment must not invent manager release authority');
    await assert.rejects(command('start', 'unused'));
    await command('cancel', 'unused'); assert.equal(object(await command('describe', 'unused')).grant, 'revoked');
    await assert.rejects(readFile(join(cwd, 'must-not-run.txt')), { code: 'ENOENT' });
    const db = new DatabaseSync(join(root, 'state', 'host.sqlite'), { readOnly: true });
    try {
      const events = db.prepare('SELECT record_json FROM herdr_execution_records ORDER BY sequence').all().map(row => JSON.parse(String(row.record_json)).event);
      assert.equal(events.filter(event => event.kind === 'command.attempted').length, 1);
      assert.equal(events.filter(event => event.kind === 'command.adopted').length, 0);
      assert.equal(events.filter(event => event.kind === 'command.reconciled').length, 1);
    } finally { db.close(); }
    assert.deepEqual(object(await operation({ op: 'execution.status', workspaceId: 'coding' })).unresolved, []);
    assert.deepEqual(unit(), originalReplacement);
    const result = { proof: 'private-vm-kernel-reboot-and-unit-reuse', beforeBootId: before.bootId, bootId, actualKernelPowerCut: true, boundOriginalReceiptPreserved: true, missingOriginalContainmentStaysUnknown: true, replacementUnitNotSignaled: true, expiredGrantNotRecaptured: true, noReplay: true, explicitOfflineReconciliationDoesNotGrantRelease: true, replacement: originalReplacement };
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify(result));
  }
} finally {
  if (backend.child.connected) backend.child.disconnect();
  const end = await backend.exit; assert.equal(end.code, 0);
}
