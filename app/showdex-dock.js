'use strict';

// Runs in the client, alongside the pinned Showdex build. Keep its React roots and battle
// subscriptions intact; only arrange the existing calculator and battle chrome.
function installShowdexDock() {
  if (window.__sdShowdexDock) return true;
  const root = document.documentElement;
  root.classList.add('sd-showdex-dock');
  const entries = new Map();
  const practice = root.hasAttribute('data-practice-state');
  const seeded = new WeakSet();
  const enabled = () => practice || root.classList.contains('sd-launcher-shell');
  const panelId = (id) => 'view-calcdex-' + id.replace(/[^a-z0-9]/g, '');
  function clear(entry) {
    entry.room.el.classList.remove('sd-calcdex-battle', 'sd-calcdex-compact');
    entry.calc.classList.remove('sd-calcdex-docked', 'sd-calcdex-parked');
    entry.button.remove();
  }
  function openPanel(id) {
    if (!enabled() || !window.app) return false;
    const room = Object.values(app.rooms).find((r) => r.battle && panelId(r.id) === id);
    if (!room || !app.rooms[id]) return false;
    const entry = entries.get(room.id);
    if (entry) entry.open = true;
    app.focusRoom(room.id);
    scan();
    return true;
  }
  function scan() {
    if (!window.app?.rooms) return;
    if (practice) {
      if (!app.singlePanelMode) { app.singlePanelMode = true; app.updateLayout(); }
      if (!app.focusRoomRight.sdPracticeDock) {
        const original = app.focusRoomRight;
        const focusRight = function (id, ...args) {
          if (openPanel(id)) return true;
          // Hellodex/Honkdex must not replace the only visible practice battle.
          if (app.curRoom?.battle) return false;
          return original.call(this, id, ...args);
        };
        focusRight.sdPracticeDock = true;
        app.focusRoomRight = focusRight;
      }
      // The battle may arrive before optional Showdex finishes booting. An empty receive
      // lets its normal hook initialize from the existing battle, without replaying turns.
      if (window.__SHOWDOWN_DESKTOP_SHOWDEX?.state === 'loaded') {
        for (const room of Object.values(app.rooms)) {
          if (!room.battle || seeded.has(room)) continue;
          seeded.add(room);
          if (!room.battle.calcdexInit) app.receive('>' + room.id + '\n');
        }
      }
    }
    for (const [id, entry] of entries) {
      if (!app.rooms[id] || !entry.room.el.isConnected || !entry.calc.isConnected) {
        clear(entry);
        entries.delete(id);
      }
    }
    for (const room of Object.values(app.rooms)) {
      if (!room.battle || !room.el) continue;
      const panel = app.rooms[panelId(room.id)];
      const overlay = room.el.querySelector('[class*="Calcdex-module-overlayContainer--"]');
      const calc = panel?.el || overlay;
      if (!calc) continue;
      let entry = entries.get(room.id);
      if (!entry) {
        const button = document.createElement('button');
        button.className = 'button sd-showdex-dock-toggle';
        button.type = 'button';
        button.textContent = 'Showdex';
        button.title = 'Show or hide the battle calculator';
        entry = { room, calc, open: true, button };
        entries.set(room.id, entry);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (overlay && typeof room.toggleCalcdexOverlay === 'function') room.toggleCalcdexOverlay();
          else entry.open = !entry.open;
          scan();
        });
        room.el.append(button);
      }
      const active = enabled() && app.curRoom === room;
      const open = overlay ? overlay.style.display !== 'none' : entry.open;
      const docked = active && open;
      entry.button.hidden = !active;
      entry.button.setAttribute('aria-pressed', String(open));
      if (!docked && room.el.classList.contains('sd-calcdex-battle')) room.el.scrollTop = 0;
      room.el.classList.toggle('sd-calcdex-battle', docked);
      calc.classList.toggle('sd-calcdex-docked', docked);
      // Panel rooms are otherwise hidden by Showdown's single-room mode. Do not leave an
      // invisible side room focused when switching back to the battle.
      if (panel) calc.classList.toggle('sd-calcdex-parked', enabled() && !docked && app.curRoom !== panel);
      if (!docked) continue;
      // The native overlay disables chat because it covers it. Our dock gives chat its own
      // column, so keep both the input and spectator Join chat button usable.
      if (overlay) {
        for (const node of room.el.querySelectorAll('.battle-log, .battle-log-add')) node.style.opacity = '';
        for (const node of room.el.querySelectorAll('.battle-log-add textarea, .battle-log-add button')) node.disabled = false;
      }
      const width = room.el.clientWidth;
      const compact = width < 1250;
      const fieldWidth = compact ? Math.min(640, width - 380) : 640;
      const calcWidth = compact ? 348 : Math.min(400, width - 916);
      const controls = room.el.querySelector('.battle-controls');
      const controlsTop = 48 + 360 * Math.min(1, fieldWidth / 640);
      const values = {
        '--sd-dock-field': fieldWidth + 'px',
        '--sd-dock-scale': String(Math.min(1, fieldWidth / 640)),
        '--sd-dock-left': (compact ? fieldWidth + 24 : width - calcWidth - 12) + 'px',
        '--sd-dock-width': calcWidth + 'px',
        '--sd-dock-chat': (fieldWidth + 24) + 'px',
        '--sd-dock-chat-right': (calcWidth + 24) + 'px',
        '--sd-dock-controls': controlsTop + 'px',
        '--sd-dock-chat-top': (controlsTop + (controls?.offsetHeight || 160) + 16) + 'px',
      };
      for (const [key, value] of Object.entries(values)) {
        room.el.style.setProperty(key, value);
        calc.style.setProperty(key, value);
      }
      room.el.classList.toggle('sd-calcdex-compact', compact);
    }
  }
  window.__sdShowdexDock = { openPanel, scan };
  addEventListener('resize', scan);
  setInterval(scan, 200);
  scan();
  return true;
}

module.exports = { installShowdexDock };
