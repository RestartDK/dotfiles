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
const root = '/home/proof/manager', cwd = join(root, 'workspace'), config = join(root, 'config.json');
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

await mkdir(cwd, {recursive:true,mode:0o700});
await writeFile(config,JSON.stringify({identity:{deploymentId:'private-manager-proof',domain:'personal',nodeId:'durable-proof'},stateRoot:join(root,'state'),model:{provider:'host-command-fixture',modelId:'idle'},thinkingLevel:'off',authPath:join(root,'unused-auth.json'),modelsPath:join(root,'unused-models.json'),execution:{mode:'durable',maxRecords:128}}),{flag:'wx',mode:0o600,flush:true});
const backend=await start(), originalPid=backend.child.pid;
const command=(op,intentId='once')=>backend.call({command:{op,workspaceId:'coding',intentId}});
const operation=value=>backend.call({operation:{workspaceId:'coding',...value}});
async function until(action){const deadline=performance.now()+20000;while(performance.now()<deadline){const value=await action();if(value!==undefined)return value;await delay(20);}throw new Error('Manager proof observation deadline');}
async function marker(name){const deadline=performance.now()+60000;while(performance.now()<deadline){try{await readFile(join(root,name));return;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(20);}throw new Error('Manager driver marker deadline '+name);}
async function save(name,value){await writeFile(join(root,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600,flush:true});}
function alive(){assert.equal(backend.child.pid,originalPid);assert.equal(backend.child.exitCode,null);assert.equal(backend.child.signalCode,null);assert.ok(backend.child.connected);}
try{
 await operation({op:'create',requestId:'create',cwd});
 const authorized=object(await backend.call({command:{op:'authorize',workspaceId:'coding',authorization:{intentId:'once',argv:[node,'-e',"const fs=require('node:fs');const f=fs.openSync(process.argv[1],'wx',384);fs.writeFileSync(f,'once');fs.fsyncSync(f);fs.closeSync(f)",join(cwd,'once.txt')],timeoutSeconds:10}}}));
 const spec=JSON.parse(authorized.authorization.specJson),sdk=await command('start');
 const observed=await until(async()=>{const value=object(await command('inspect'));return value.outcome.kind==='recorded'&&value.containment.kind==='empty'?value:undefined;});
 assert.deepEqual(observed.outcome.receipt.outcome,{kind:'exit',code:0,cause:'normal'});
 await backend.call({command:{op:'authorize',workspaceId:'coding',authorization:{intentId:'unused',argv:[node,'-e',"require('node:fs').writeFileSync(process.argv[1],'explicit only',{flag:'wx'})",join(cwd,'explicit-only.txt')],timeoutSeconds:10}}});
 const beforeGrant=object(await command('describe','unused'));assert.equal(beforeGrant.grant,'live');
 await save('before-ready.json',{bootId,originalPid,sdk,spec,receipt:observed.outcome.receipt,beforeGrant});
 console.log(JSON.stringify({event:'ready-manager-stop',originalPid,bootId}));
 await marker('manager-stopped');
 alive();assert.equal((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),bootId);
 const missing=object(await command('inspect'));assert.equal(missing.outcome.kind,'recorded');assert.deepEqual(missing.outcome.receipt,observed.outcome.receipt);assert.equal(missing.containment.kind,'unknown');
 assert.equal(object(await command('adopt')).phase.kind,'activated');await assert.rejects(command('release'));
 assert.deepEqual(await command('describe','unused'),beforeGrant);
 await save('manager-missing.json',{originalPid,bootId,missing,sourceGrantStillLive:true});
 await marker('manager-started');
 alive();assert.equal((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),bootId);
 const after=object(await command('inspect'));assert.equal(after.outcome.kind,'recorded');assert.deepEqual(after.outcome.receipt,observed.outcome.receipt);assert.equal(after.containment.kind,'unknown');
 const runner=process.env.DSTACK_SYSTEMD_RUN,manager=process.env.DSTACK_SYSTEMCTL;assert.ok(runner&&manager);
 const replacement=spawnSync(runner,['--user','--quiet',`--unit=${spec.unit}`,'--service-type=exec','--property=RuntimeMaxSec=120s',node,'-e','setInterval(()=>{},1000)'],{encoding:'utf8',timeout:10000});assert.equal(replacement.status,0,replacement.stderr);
 function unit(){const value=spawnSync(manager,['--user','show',spec.unit,'--property=InvocationID,MainPID,ActiveState'],{encoding:'utf8',timeout:5000});assert.equal(value.status,0,value.stderr);return Object.fromEntries(value.stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));}
 const originalReplacement=unit();assert.equal(originalReplacement.ActiveState,'active');assert.notEqual(originalReplacement.InvocationID,observed.outcome.receipt.evidence.activation.invocationId);assert.ok(Number(originalReplacement.MainPID)>0);
 for(let i=0;i<2;i++){await assert.rejects(command('cancel'));assert.deepEqual(unit(),originalReplacement);}
 assert.equal(object(await command('start')).command.phase.kind,'activated');
 const changed=object(await command('inspect'));assert.deepEqual(changed.outcome.receipt,observed.outcome.receipt);assert.equal(changed.containment.kind,'unknown');
 await assert.rejects(operation({op:'command.reconcile',intentId:'once',reference:'replacement is not original custody',containment:{kind:'manager'}}));
 await operation({op:'command.reconcile',intentId:'once',reference:'driver stopped only guest user manager while original source Node stayed alive',containment:{kind:'trusted-offline',reference:'original guest manager custody lost, no empty-containment or release proof'}});
 await assert.rejects(command('release'));
 assert.deepEqual(await command('describe','unused'),beforeGrant,'Live descriptors survive manager loss; never metadata-recapture');
 await assert.rejects(readFile(join(cwd,'explicit-only.txt')),{code:'ENOENT'});
 const unusedSdk=await command('start','unused');
 const unused=await until(async()=>{const value=object(await command('inspect','unused'));return value.outcome.kind==='recorded'&&value.containment.kind==='empty'?value:undefined;});
 assert.deepEqual(unused.outcome.receipt.outcome,{kind:'exit',code:0,cause:'normal'});assert.equal(await readFile(join(cwd,'explicit-only.txt'),'utf8'),'explicit only');
 assert.equal(object(await command('adopt','unused')).phase.kind,'adopted');await command('release','unused');
 const unusedSpec=JSON.parse(beforeGrant.command.authorization.specJson),released=spawnSync(manager,['--user','show',unusedSpec.unit,'--property=NFileDescriptorStore'],{encoding:'utf8',timeout:5000});assert.match(released.stdout,/^NFileDescriptorStore=0$/m);
 const db=new DatabaseSync(join(root,'state','host.sqlite'),{readOnly:true});
 try{const events=db.prepare('SELECT record_json FROM herdr_execution_records ORDER BY sequence').all().map(row=>JSON.parse(String(row.record_json)).event);assert.equal(events.filter(e=>e.kind==='command.attempted'&&e.intentId==='once').length,1);assert.equal(events.filter(e=>e.kind==='command.attempted'&&e.intentId==='unused').length,1);assert.equal(events.filter(e=>e.kind==='command.adopted'&&e.intentId==='once').length,0);assert.equal(events.filter(e=>e.kind==='command.reconciled'&&e.intentId==='once').length,1);}finally{db.close();}
 assert.equal(await readFile(join(cwd,'once.txt'),'utf8'),'once');assert.deepEqual(unit(),originalReplacement);assert.deepEqual((await operation({op:'execution.status'})).unresolved,[]);assert.equal((await backend.call({tasks:true})).providerCalls,0);
 await save('result.json',{proof:'same-kernel-manager-loss-live-source',bootId,originalPid,sdk,unusedSdk,actualSourceBackendSurvived:true,originalReceiptRetainedWithUnknownContainment:true,replacementNeverSignaled:true,liveGrantNotConfusedWithExpiredGrant:true,unusedConsumedOnlyAfterExplicitStart:true,originalOfflineAcknowledgmentNoRelease:true,noReplay:true,replacement:originalReplacement});
}finally{if(backend.child.connected)backend.child.disconnect();assert.equal((await backend.exit).code,0);}
await save('done.json',{done:true});
