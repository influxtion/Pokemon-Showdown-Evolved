'use strict';

// Ctrl+Tab moves to the next tab in the strip and Ctrl+Shift+Tab to the previous one.
// Returns 1, -1, or 0 when the key press is something else.
function tabCycle(input) {
  if (!input || input.type !== 'keyDown' || input.key !== 'Tab') return 0;
  if (!input.control || input.alt || input.meta) return 0;
  return input.shift ? -1 : 1;
}

module.exports = { tabCycle };
