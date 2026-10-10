const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(process.argv[2], 'utf8');
const match = source.match(/function clientLaunchCommand\(argv\) \{[\s\S]*?\n\}/);
assert.ok(match, 'The installed CLI must expose the split launch function');

for (const env of [{}, {
  TERMINAL_BROWSER_NAMESPACE: 'dev-test-18',
  TERMINAL_BROWSER_NAMESPACE_LAUNCHER: '/store/namespace-launcher',
}]) {
  const launch = vm.runInNewContext(`${match[0]}; clientLaunchCommand`, {
    process: { env },
    DIST_ROOT2: '/store/upstream',
    import_node_path10: { default: require('node:path') },
  });
  const args = ['https://example.com/a b', "single'quote", '--no-merge'];
  const command = [...launch(args)];
  assert.deepEqual(command, env.TERMINAL_BROWSER_NAMESPACE
    ? ['/store/namespace-launcher', '--namespace', 'dev-test-18', 'open', ...args]
    : ['/store/upstream/bin/terminal-browser', 'open', ...args]);
}
console.log('Built CLI preserves split namespace, quoting and upstream host behavior');
