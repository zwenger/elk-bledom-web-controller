import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, LightGroup } from '../js/light-group.js';
import { createStorage } from '../js/storage.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Stand-in for `ChainConnection`: records what is sent and connects instantly. */
class FakeConnection extends EventTarget {
  device = null;
  sent = [];
  connected = false;
  get deviceId() {
    return this.device?.id ?? null;
  }
  get name() {
    return this.device?.name ?? '';
  }
  get isConnected() {
    return this.connected;
  }
  async connectDevice(device) {
    this.device = device;
    this.connected = true;
    this.dispatchEvent(new CustomEvent('connectionchange', { detail: { connected: true } }));
  }
  send(bytes, key) {
    this.sent.push({ bytes, key });
  }
  setAutoConnect() {}
}

function setup({ paired = [], picked = [], saved = {}, data = new Map() } = {}) {
  for (const [key, value] of Object.entries(saved)) data.set(key, JSON.stringify(value));
  const storage = createStorage({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  });
  const connections = [];
  const bluetooth = {
    getDevices: async () => paired,
    requestDevice: async () => picked.shift(),
  };
  const group = new LightGroup({
    storage,
    isAutoConnectEnabled: () => true,
    bluetooth,
    createConnection: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  });
  const sentTo = () => connections.map((connection) => connection.sent.length);
  return { group, connections, sentTo, data };
}

const strip = { id: 'a', name: 'ELK-BLEDDM       ' };
const bars = { id: 'b', name: 'MELK-OC21   CF' };

test('auto-connect connects every paired light and lists them with clean names', async () => {
  const { group } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  assert.deepEqual(group.lights, [
    { id: 'a', name: 'ELK-BLEDDM', connected: true },
    { id: 'b', name: 'MELK-OC21 CF', connected: true },
  ]);
  assert.equal(group.isConnected, true);
});

test('sends to all lights by default', async () => {
  const { group, sentTo } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  group.send(new Uint8Array([1]), 'color');
  assert.equal(group.target, ALL);
  assert.deepEqual(sentTo(), [1, 1]);
});

test('sends only to the selected light', async () => {
  const { group, sentTo } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  group.select('b');
  group.send(new Uint8Array([1]), 'color');
  assert.deepEqual(sentTo(), [0, 1]);
});

test('sendAll ignores the selection', async () => {
  const { group, sentTo } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  group.select('a');
  group.sendAll(new Uint8Array([1]), 'clock');
  assert.deepEqual(sentTo(), [1, 1]);
});

test('remembers the selected light across restarts', async () => {
  const first = setup({ paired: [strip, bars] });
  await first.group.autoConnect();
  first.group.select('b');

  const second = setup({ paired: [strip, bars], saved: { target: 'b' } });
  await second.group.autoConnect();
  assert.equal(second.group.target, 'b');
});

test('an unknown saved selection falls back to all lights', async () => {
  const { group } = setup({ paired: [strip], saved: { target: 'gone' } });
  await group.autoConnect();
  assert.equal(group.target, ALL);
});

test('pairing a new light adds and selects it', async () => {
  const { group, connections } = setup({ paired: [strip], picked: [bars] });
  await group.autoConnect();
  await group.connectWithPicker();
  assert.equal(connections.length, 2);
  assert.equal(group.target, 'b');
  assert.deepEqual(
    group.lights.map((light) => light.id),
    ['a', 'b'],
  );
});

test('picking a light that is already listed reuses its connection', async () => {
  const { group, connections } = setup({ paired: [strip], picked: [strip] });
  await group.autoConnect();
  await group.connectWithPicker();
  assert.equal(connections.length, 1);
  assert.equal(group.lights.length, 1);
});

test('announces list changes', async () => {
  const { group } = setup({ paired: [strip, bars] });
  let changes = 0;
  group.addEventListener('lightschange', () => changes++);
  await group.autoConnect();
  await flush();
  const afterConnect = changes;
  group.select('a');
  assert.ok(afterConnect > 0);
  assert.equal(changes, afterConnect + 1);
});

const nameOf = (group, id) => group.lights.find((light) => light.id === id).name;

test('a renamed light shows its new name', async () => {
  const { group } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  group.rename('a', '  Tira del escritorio ');
  assert.equal(nameOf(group, 'a'), 'Tira del escritorio');
  assert.equal(nameOf(group, 'b'), 'MELK-OC21 CF');
});

test('names are remembered across restarts', async () => {
  const first = setup({ paired: [strip] });
  await first.group.autoConnect();
  first.group.rename('a', 'Tira');

  const second = setup({ paired: [strip], data: first.data });
  await second.group.autoConnect();
  assert.equal(nameOf(second.group, 'a'), 'Tira');
});

test('a name is found by the Bluetooth name when the device id changed', async () => {
  const first = setup({ paired: [strip] });
  await first.group.autoConnect();
  first.group.rename('a', 'Tira');

  const second = setup({ paired: [{ ...strip, id: 'a2' }], data: first.data });
  await second.group.autoConnect();
  assert.equal(nameOf(second.group, 'a2'), 'Tira');
});

test('an empty name restores the Bluetooth name', async () => {
  const { group } = setup({ paired: [strip] });
  await group.autoConnect();
  group.rename('a', 'Tira');
  group.rename('a', '   ');
  assert.equal(nameOf(group, 'a'), 'ELK-BLEDDM');
});

test('renaming announces a list change', async () => {
  const { group } = setup({ paired: [strip] });
  await group.autoConnect();
  let changes = 0;
  group.addEventListener('lightschange', () => changes++);
  group.rename('a', 'Tira');
  assert.equal(changes, 1);
});
