import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const moduleSource = await readFile(new URL('../packet-tracer/routed.js', import.meta.url), 'utf8');

function loadModule() {
  const context = {};
  runInNewContext(moduleSource, context);
  return context;
}

test('configures IOS through the native parser with explicit initial and save modes', () => {
  const context = loadModule();
  const commands = [
    'configure terminal', 'vlan 20', 'name STAFF', 'exit',
    'interface FastEthernet0/1', 'switchport mode access',
    'switchport access vlan 20', 'end', 'write memory',
  ];
  const executed = [];
  const state = {
    name: 'HQ-SW', readyAt: 0, index: 0, commands,
    device: {
      enterCommand(command, mode) {
        executed.push({ command, mode });
        return { first: 0, second: '' };
      },
      getCommandLine() {
        throw new Error('The visible console stays at Switch> while the parser has its own mode.');
      },
    },
  };

  for (let tick = 0; tick < commands.length; tick++) context.advanceRoutedConsole(state, tick);

  assert.equal(state.index, commands.length);
  assert.deepEqual(executed, commands.map((command, index) => ({
    command,
    mode: index === 0 || index === commands.length - 1 ? 'enable' : '',
  })));
  context.advanceRoutedConsole(state, 100);
  assert.equal(executed.length, commands.length);
});

test('configures router-facing trunks using the saved Packet Tracer default VLAN range', () => {
  const context = loadModule();
  const makeSite = ids => ({
    switchName: 'HQ-SW',
    vlans: ids.map(id => ({ id, name: `VLAN_${id}`, pcs: [] })),
  });
  const normal = Array.from(context.routedSwitchCommands(makeSite([1, 20, 1001])));
  assert.ok(normal.includes('vlan 1001'));
  assert.deepEqual(normal.slice(-4), [
    'interface FastEthernet0/24', 'switchport mode trunk', 'end', 'write memory',
  ]);
});

test('keeps a rejected parser command pending and reports the device and command', () => {
  const context = loadModule();
  for (const response of [
    { first: 2, second: '% Invalid input' },
    { first: 0, second: '% Incomplete command' },
    undefined,
  ]) {
    const state = {
      name: 'HQ-SW', readyAt: 0, index: 0, commands: ['configure terminal'],
      device: { enterCommand: () => response },
    };
    assert.throws(() => context.advanceRoutedConsole(state, 1), /HQ-SW rejected "configure terminal"/);
    assert.equal(state.index, 0);
  }
});
