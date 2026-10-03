// TEMPORARY HARNESS (build-order step 4). Plain TS so the Electron alarm engine
// can be checked before the React app exists. Step 5 replaces this page with
// the React /alarm?occurrence=... route (shadcn Button, same look); delete
// this file, alarm.html and alarm.css then. The preload API stays.
import type { AlarmView } from '../alarm-ipc';

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`alarm.html is missing #${id}`);
  return element;
}

const titleEl = requireElement('title');
const timeEl = requireElement('time');
const notesEl = requireElement('notes');
const noticeEl = requireElement('notice');
const statusEl = requireElement('status');
const doneButton = requireElement('done') as HTMLButtonElement;
const snoozeButton = requireElement('snooze') as HTMLButtonElement;

const occurrenceId = new URLSearchParams(window.location.search).get('occurrence');

function render(view: AlarmView): void {
  titleEl.textContent = view.title;
  timeEl.textContent = new Date(view.occurrenceAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  notesEl.textContent = view.notes ?? '';
  noticeEl.textContent = view.snoozeNotice ?? '';
  snoozeButton.hidden = view.snoozeLabel === null;
  snoozeButton.textContent = view.snoozeLabel ?? '';
}

function startSound(): void {
  const audio = new Audio('alarm.wav');
  audio.loop = true;
  audio.volume = 1;
  audio.play().catch((error: unknown) => {
    statusEl.textContent = `Sound failed to start: ${String(error)}`;
  });
}

async function act(action: 'done' | 'snooze'): Promise<void> {
  if (occurrenceId === null) return;
  doneButton.disabled = true;
  snoozeButton.disabled = true;
  statusEl.textContent = '';
  try {
    const result = await window.alarmApi[action](occurrenceId);
    // On success main closes this window. On failure the state changed under
    // us (for example the last snooze was just used), so redraw from main.
    if (!result.ok) await load();
  } catch (error) {
    // Never leave the buttons dead: this window is the only way out of the alarm.
    doneButton.disabled = false;
    snoozeButton.disabled = false;
    statusEl.textContent = `That did not work, try again: ${String(error)}`;
  }
}

async function load(): Promise<void> {
  if (occurrenceId === null) {
    statusEl.textContent = 'Missing occurrence in the page URL';
    return;
  }
  const view = await window.alarmApi.getAlarm(occurrenceId);
  if (view === null) {
    // Main closes a window that has nothing to show.
    statusEl.textContent = 'This alarm is no longer active';
    return;
  }
  render(view);
  doneButton.disabled = false;
  snoozeButton.disabled = false;
}

doneButton.addEventListener('click', () => void act('done'));
snoozeButton.addEventListener('click', () => void act('snooze'));

startSound();
load().catch((error: unknown) => {
  statusEl.textContent = `Failed to load the alarm: ${String(error)}`;
});
