'use strict';

// Keyboard shortcuts for the tab strip. Returns what a key press asks for, or null when it
// is something else:
//   Ctrl+Tab / Ctrl+Shift+Tab   { type: 'cycle', direction: 1 | -1 }   next / previous tab
//   Ctrl+W                      { type: 'close' }                      close the open tab
//   Ctrl+1 … Ctrl+9             { type: 'jump', index: 1…9 }           that tab; 9 is the last
function tabShortcut(input) {
  if (!input || input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const key = typeof input.key === 'string' ? input.key : '';
  if (key === 'Tab') return { type: 'cycle', direction: input.shift ? -1 : 1 };
  if (input.shift) return null;
  // Holding the keys down must not close one tab after another.
  if (key.toLowerCase() === 'w') return input.isAutoRepeat ? null : { type: 'close' };
  // The physical key, so layouts with digits on the shifted row still work.
  const digit = /^Digit([1-9])$/.exec(typeof input.code === 'string' ? input.code : '') || /^([1-9])$/.exec(key);
  return digit ? { type: 'jump', index: Number(digit[1]) } : null;
}

module.exports = { tabShortcut };
