import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, LightGroup } from '../js/light-group.js';
import { createStorage } from '../js/storage.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Stand-in for `ChainConnection`: records what is sent and connects instantly. */
class FakeConnection extends EventTarget {
  constructor(options) {
    super();
    this.options = options;
  }
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
    this.emitStatus(`Connected to ${this.options.displayName(device)}`);
    this.connected = true;
    this.dispatchEvent(new CustomEvent('connectionchange', { detail: { connected: true } }));
  }
  emitStatus(text) {
    this.dispatchEvent(new CustomEvent('status', { detail: text }));
  }
  /** Simulates a connection loss with the light's own message. */
  lose() {
    this.connected = false;
    this.dispatchEvent(new CustomEvent('connectionchange', { detail: { connected: false } }));
    this.emitStatus(`Connection to ${this.options.displayName(this.device)} lost.`);
  }
  send(bytes, key) {
    this.sent.push({ bytes, key });
  }
  setAutoConnect() {}
  async forget() {
    this.forgotten = true;
    this.connected = false;
  }
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
    createConnection: (options) => {
      const connection = new FakeConnection(options);
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

const neighbor = { id: 'n', name: 'ELK-BLEDOM' };

test('removing a light drops it from the list and forgets the device', async () => {
  const { group, connections } = setup({ paired: [strip, neighbor] });
  await group.autoConnect();
  await group.remove('n');
  assert.deepEqual(
    group.lights.map((light) => light.id),
    ['a'],
  );
  assert.equal(connections[1].forgotten, true);
});

test('removing the selected light selects all lights', async () => {
  const { group } = setup({ paired: [strip, neighbor] });
  await group.autoConnect();
  group.select('n');
  await group.remove('n');
  assert.equal(group.target, ALL);
});

test('a removed light is not connected again when the browser still lists it', async () => {
  const first = setup({ paired: [strip, neighbor] });
  await first.group.autoConnect();
  await first.group.remove('n');

  const second = setup({ paired: [strip, neighbor], data: first.data });
  await second.group.autoConnect();
  assert.deepEqual(
    second.group.lights.map((light) => light.id),
    ['a'],
  );
  assert.equal(second.connections.length, 1);
});

test('pairing a removed light again brings it back', async () => {
  const first = setup({ paired: [strip, neighbor] });
  await first.group.autoConnect();
  await first.group.remove('n');

  const second = setup({ paired: [strip, neighbor], picked: [neighbor], data: first.data });
  await second.group.autoConnect();
  await second.group.connectWithPicker();
  assert.deepEqual(
    second.group.lights.map((light) => light.id),
    ['a', 'n'],
  );
});

test('removing a light deletes its custom name', async () => {
  const { group } = setup({ paired: [neighbor], picked: [neighbor] });
  await group.autoConnect();
  group.rename('n', 'Vecino');
  await group.remove('n');
  await group.connectWithPicker();
  assert.equal(nameOf(group, 'n'), 'ELK-BLEDOM');
});

test('the status is empty while every light is connected', async () => {
  const { group } = setup({ paired: [strip, bars] });
  const shown = [];
  group.addEventListener('status', (event) => shown.push(event.detail));
  await group.autoConnect();
  assert.equal(group.status, '');
  assert.equal(shown.at(-1), '');
});

test("a light's problem is shown until it is connected again", async () => {
  const { group, connections } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  connections[1].lose();
  assert.equal(group.status, 'Connection to MELK-OC21 CF lost.');
  await connections[1].connectDevice(bars);
  assert.equal(group.status, '');
});

test('problems of several lights are shown together', async () => {
  const { group, connections } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  connections[0].lose();
  connections[1].lose();
  assert.equal(group.status, 'Connection to ELK-BLEDDM lost. · Connection to MELK-OC21 CF lost.');
});

test('light messages use the custom name', async () => {
  const { group, connections } = setup({ paired: [bars] });
  await group.autoConnect();
  group.rename('b', 'tv');
  connections[0].lose();
  assert.equal(group.status, 'Connection to tv lost.');
});

test('removing a light drops its message', async () => {
  const { group, connections } = setup({ paired: [strip, bars] });
  await group.autoConnect();
  connections[1].lose();
  await group.remove('b');
  assert.equal(group.status, '');
});

test('a group message is cleared once a light connects', async () => {
  const { group } = setup({ paired: [], picked: [strip] });
  await group.autoConnect();
  assert.notEqual(group.status, '');
  await group.connectWithPicker();
  assert.equal(group.status, '');
});
