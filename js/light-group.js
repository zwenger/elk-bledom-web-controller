/**
 * Several light chains at once.
 *
 * `LightGroup` keeps one `ChainConnection` per paired device, all connected at the same time, and sends to the
 * selected target: one light (its device id) or every light (`ALL`). It offers the same methods and events as
 * `ChainConnection`, so the UI modules work unchanged, plus:
 *   - `lightschange` the list of lights, their names, their connection or the selection changed
 *
 * Removed lights are remembered as well: browsers without `BluetoothDevice.forget()` keep listing them in
 * `getDevices()`, and they must not come back on the next start.
 *
 * Custom names are stored by device id and by Bluetooth name, so they survive a new pairing that changes the id.
 */
import { ChainConnection, friendlyError, pickerOptions } from './bluetooth.js';
import { t } from './i18n.js';
import { KEYS } from './storage.js';

/** Target that sends to every light. */
export const ALL = 'all';

/** Bluetooth names come padded with spaces ("ELK-BLEDDM       "). */
const clean = (name) => name.replace(/\s+/g, ' ').trim();

export class LightGroup extends EventTarget {
  /** @type {Map<string, ChainConnection>} */ #lights = new Map();
  #storage;
  #isAutoConnectEnabled;
  #bluetooth;
  #createConnection;
  /** @type {string} */ #target;

  /**
   * @param {object} options
   * @param {ReturnType<import('./storage.js').createStorage>} options.storage
   * @param {() => boolean} options.isAutoConnectEnabled
   * @param {Bluetooth} [options.bluetooth] defaults to `navigator.bluetooth`
   * @param {(options: object) => ChainConnection} [options.createConnection]
   */
  constructor({
    storage,
    isAutoConnectEnabled,
    bluetooth = globalThis.navigator?.bluetooth,
    createConnection = (options) => new ChainConnection(options),
  }) {
    super();
    this.#storage = storage;
    this.#isAutoConnectEnabled = isAutoConnectEnabled;
    this.#bluetooth = bluetooth;
    this.#createConnection = createConnection;
    this.#target = storage.get(KEYS.target, ALL);
  }

  /** @returns {{ id: string, name: string, connected: boolean }[]} in pairing order */
  get lights() {
    const names = this.#storage.get(KEYS.lightNames, {});
    return [...this.#lights].map(([id, light]) => {
      const bluetoothName = clean(light.name);
      return {
        id,
        name: names['id:' + id] ?? names['name:' + bluetoothName] ?? bluetoothName,
        connected: light.isConnected,
      };
    });
  }

  /**
   * Gives a light a custom name. An empty name restores its Bluetooth name.
   * @param {string} id
   * @param {string} name
   */
  rename(id, name) {
    const light = this.#lights.get(id);
    if (!light) return;
    const names = { ...this.#storage.get(KEYS.lightNames, {}) };
    const keys = ['id:' + id, 'name:' + clean(light.name)];
    const custom = clean(name);
    keys.forEach((key) => (custom ? (names[key] = custom) : delete names[key]));
    this.#storage.set(KEYS.lightNames, names);
    this.dispatchEvent(new CustomEvent('lightschange'));
  }

  /**
   * Removes a light: disconnects it, revokes the browser permission and deletes its custom name.
   * Pairing it again with the picker brings it back.
   * @param {string} id
   */
  async remove(id) {
    const light = this.#lights.get(id);
    if (!light) return;
    const names = { ...this.#storage.get(KEYS.lightNames, {}) };
    delete names['id:' + id];
    delete names['name:' + clean(light.name)];
    this.#storage.set(KEYS.lightNames, names);
    this.#setRemoved(id, true);
    this.#lights.delete(id);
    if (this.#target === id) this.select(ALL);
    else this.#emitChange();
    await light.forget();
  }

  /** `ALL` or the id of the selected light. */
  get target() {
    return this.#lights.has(this.#target) ? this.#target : ALL;
  }

  /** True if at least one light of the current target is connected. */
  get isConnected() {
    return this.#targets().some((light) => light.isConnected);
  }

  /** Chooses which light the controls act on. @param {string} target `ALL` or a device id */
  select(target) {
    this.#target = this.#lights.has(target) ? target : ALL;
    this.#storage.set(KEYS.target, this.#target);
    this.#emitChange();
  }

  /** Sends to the selected target. Same arguments as `ChainConnection.send`. */
  send(bytes, key) {
    this.#targets().forEach((light) => light.send(bytes, key));
  }

  /** Sends to every light, regardless of the selection (clock, schedule). */
  sendAll(bytes, key) {
    this.#lights.forEach((light) => light.send(bytes, key));
  }

  /**
   * Opens the picker dialog, adds the chosen light and selects it. Must be called from a user tap.
   * @param {{ showAllDevices?: boolean }} [options]
   */
  async connectWithPicker(options) {
    let device;
    try {
      this.#emitStatus(t('ble.searching'));
      device = await this.#bluetooth.requestDevice(pickerOptions(options));
    } catch (error) {
      this.#emitStatus(friendlyError(error));
      return;
    }
    this.#setRemoved(device.id, false);
    const light = this.#add(device);
    this.select(device.id);
    await light.connectDevice(device);
  }

  /** The "auto-connect" switch changed. @param {boolean} enabled */
  setAutoConnect(enabled) {
    if (enabled) this.autoConnect();
    else this.#lights.forEach((light) => light.setAutoConnect(false));
  }

  /** Connects without a dialog to every paired light that is not connected yet. */
  async autoConnect() {
    if (!this.#isAutoConnectEnabled() || !this.#bluetooth) return;
    if (!this.#bluetooth.getDevices) {
      this.#emitStatus(t('ble.noAutoConnect'));
      return;
    }
    let devices;
    try {
      const removed = this.#storage.get(KEYS.removedLights, []);
      devices = (await this.#bluetooth.getDevices()).filter((device) => !removed.includes(device.id));
    } catch {
      this.#emitStatus(t('ble.tapConnect'));
      return;
    }
    if (!devices.length) {
      this.#emitStatus(t('ble.notPaired'));
      return;
    }
    await Promise.all(
      devices.map((device) => {
        const light = this.#add(device);
        return light.isConnected ? null : light.connectDevice(device);
      }),
    );
  }

  /** Returns the connection for `device`, creating it on first sight. */
  #add(device) {
    const known = this.#lights.get(device.id);
    if (known) return known;
    const light = this.#createConnection({ storage: this.#storage, isAutoConnectEnabled: this.#isAutoConnectEnabled });
    light.addEventListener('status', (event) => this.#emitStatus(event.detail));
    light.addEventListener('connectionchange', () => this.#emitChange());
    this.#lights.set(device.id, light);
    this.#emitChange();
    return light;
  }

  #setRemoved(id, removed) {
    const ids = this.#storage.get(KEYS.removedLights, []).filter((other) => other !== id);
    this.#storage.set(KEYS.removedLights, removed ? [...ids, id] : ids);
  }

  #targets() {
    const selected = this.#lights.get(this.target);
    return selected ? [selected] : [...this.#lights.values()];
  }

  #emitStatus(text) {
    this.dispatchEvent(new CustomEvent('status', { detail: text }));
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent('lightschange'));
    this.dispatchEvent(new CustomEvent('connectionchange', { detail: { connected: this.isConnected } }));
  }
}
