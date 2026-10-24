/**
 * List of paired lights: one tap selects which light the controls act on.
 * The selected light has a pencil button to rename it (Enter saves, Escape cancels, empty restores the
 * Bluetooth name) and a remove button that asks for a second tap.
 */
import { t } from '../i18n.js';
import { ALL } from '../light-group.js';
import { $, haptic } from './dom.js';

/** How long the remove button waits for the confirming second tap. */
const REMOVE_CONFIRM_MS = 3000;

/** @param {{ group: import('../light-group.js').LightGroup }} options */
export function initLights({ group }) {
  const list = $('lights');
  /** Light being renamed and the text typed so far (kept when the list re-renders meanwhile). */
  let editing = null;
  /** Some browsers fire `blur` when the list replaces a focused input; that is not the user leaving the field. */
  let rendering = false;
  /** Light whose remove button waits for the confirming second tap. */
  let removing = null;
  let removeTimer;

  const finishEditing = (save) => {
    if (!editing) return;
    const { id, draft } = editing;
    editing = null;
    if (save) group.rename(id, draft);
    render();
  };

  const nameInput = (name) => {
    const input = document.createElement('input');
    input.className = 'light-name';
    input.value = editing.draft ?? name;
    input.setAttribute('aria-label', t('lights.nameAria'));
    input.addEventListener('input', () => (editing.draft = input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finishEditing(true);
      if (event.key === 'Escape') finishEditing(false);
    });
    input.addEventListener('blur', () => rendering || finishEditing(true));
    return input;
  };

  const item = (id, name, connected) => {
    const selected = group.target === id;
    const row = document.createElement('div');
    row.className = 'light';
    row.classList.toggle('sel', selected);

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'light-pick';
    pick.setAttribute('aria-pressed', String(selected));
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.classList.toggle('on', connected);
    pick.append(dot);
    pick.addEventListener('click', () => {
      haptic();
      group.select(id);
    });
    row.append(pick);

    if (editing?.id === id) {
      row.append(nameInput(name));
      return row;
    }
    const label = document.createElement('span');
    label.textContent = name;
    pick.append(label);

    if (selected && id !== ALL) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'light-edit';
      edit.textContent = '✎';
      edit.setAttribute('aria-label', t('lights.renameAria'));
      edit.addEventListener('click', () => {
        editing = { id, draft: null };
        render();
        list.querySelector('.light-name')?.select();
      });

      // Two taps: the first one only asks, so a light is never removed by accident
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'light-remove';
      const confirming = removing === id;
      remove.classList.toggle('confirm', confirming);
      remove.textContent = confirming ? t('lights.removeConfirm') : '✕';
      remove.setAttribute('aria-label', t(confirming ? 'lights.removeConfirm' : 'lights.removeAria'));
      remove.addEventListener('click', () => {
        haptic();
        clearTimeout(removeTimer);
        if (removing === id) {
          removing = null;
          group.remove(id);
          return;
        }
        removing = id;
        removeTimer = setTimeout(() => {
          removing = null;
          render();
        }, REMOVE_CONFIRM_MS);
        render();
      });
      row.append(edit, remove);
    }
    return row;
  };

  function render() {
    const lights = group.lights;
    list.hidden = lights.length === 0;
    rendering = true;
    list.replaceChildren(
      // "All" only makes sense with more than one light
      ...(lights.length > 1
        ? [
            item(
              ALL,
              t('lights.all'),
              lights.some((light) => light.connected),
            ),
          ]
        : []),
      ...lights.map((light) => item(light.id, light.name, light.connected)),
    );
    rendering = false;
    // Keep typing after a re-render caused by a connection change
    if (editing) list.querySelector('.light-name')?.focus();
  }

  group.addEventListener('lightschange', render);
  render();
}
