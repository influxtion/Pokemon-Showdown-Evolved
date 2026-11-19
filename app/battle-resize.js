'use strict';

// Resizable battle column: a handle between the field and the chat log sets how wide the left
// column is. The action picker stretches to that width; the field keeps its size and sits
// centred on a backdrop as wide as the column. The log takes the rest of the width.
// The layout lives in client-battle-room.css, driven by --sd-battle-width on <html>; this script
// adds the handle and backdrop to each battle room and sets that variable.
//
// The same script runs in the live client and in the practice battle view. When a drag ends it
// logs `sd-battle-width:<px>` to the console; main reads that, saves it and passes it to the
// other view, so both keep one width across restarts.

const MIN_WIDTH = 640; // the field's own width
const MAX_WIDTH = 2000;
const MESSAGE = 'sd-battle-width:';

function validWidth(value) {
  return Number.isInteger(value) && value >= MIN_WIDTH && value <= MAX_WIDTH;
}

// The width a console message asks to save, or null when it is something else.
function widthFromMessage(text) {
  if (typeof text !== 'string' || !/^sd-battle-width:\d{3,4}$/.test(text)) return null;
  const value = Number(text.slice(MESSAGE.length));
  return validWidth(value) ? value : null;
}

// Installs the handle, or updates the width when it is already installed.
function battleResizeScript(width) {
  const wanted = validWidth(width) ? width : MIN_WIDTH;
  return `(() => {
  if (window.__sdBattleResize) { window.__sdBattleResize.set(${wanted}); return; }
  const MIN = ${MIN_WIDTH}, MAX = ${MAX_WIDTH};
  // Matches client-battle-room.css: the column starts 24px in, a 20px gap holds the handle,
  // then the log, which keeps at least LOG_MIN, and a 24px margin.
  const EDGE = 24, GAP = 20, LOG_MIN = 300;
  const root = document.documentElement;
  let wanted = ${wanted};
  const clamp = (value) => Math.round(Math.min(MAX, Math.max(MIN, value)));
  const roomWidth = () => {
    const room = document.querySelector('.ps-room:has(> .battle)');
    return room && room.clientWidth ? room.clientWidth : innerWidth;
  };
  // A narrow window caps how wide the column grows; it is never narrower than the field.
  function apply() {
    const fits = roomWidth() - EDGE - GAP - LOG_MIN - EDGE;
    root.style.setProperty('--sd-battle-width', Math.max(MIN, Math.min(wanted, fits)) + 'px');
  }
  function save() { console.info('${MESSAGE}' + wanted); }

  function handle(room) {
    const node = document.createElement('div');
    node.className = 'sd-battle-resizer';
    node.title = 'Drag to resize. Double-click to reset.';
    node.setAttribute('role', 'separator');
    node.setAttribute('aria-orientation', 'vertical');
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      node.setPointerCapture(event.pointerId);
      root.classList.add('sd-battle-resizing');
      const left = room.getBoundingClientRect().left;
      const move = (e) => { wanted = clamp(e.clientX - left - EDGE - GAP / 2); apply(); };
      const end = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', end);
        node.removeEventListener('pointercancel', end);
        root.classList.remove('sd-battle-resizing');
        save();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    });
    node.addEventListener('dblclick', () => { wanted = MIN; apply(); save(); });
    const backdrop = document.createElement('div');
    backdrop.className = 'sd-battle-backdrop';
    room.prepend(backdrop);
    room.append(node);
  }

  // Battle rooms open and close as the client runs, so new ones are checked for now and then.
  function scan() {
    for (const room of document.querySelectorAll('.ps-room')) {
      if (room.querySelector(':scope > .battle') && !room.querySelector(':scope > .sd-battle-resizer')) handle(room);
    }
    apply();
  }
  window.__sdBattleResize = { set(value) { wanted = clamp(Number(value) || MIN); apply(); } };
  addEventListener('resize', apply);
  setInterval(scan, 1000);
  scan();
})();`;
}

module.exports = { battleResizeScript, widthFromMessage, validWidth, MIN_WIDTH, MAX_WIDTH };
