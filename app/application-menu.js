'use strict';

function applicationMenu(platform, { name, shortcut, closeWindow }) {
  if (platform !== 'darwin') return null;
  return [
    { label: name, submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'Close Tab', accelerator: 'Command+W', click: () => shortcut({ type: 'close' }) },
      { label: 'Close Window', accelerator: 'Command+Shift+W', click: closeWindow },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { label: 'Tabs', submenu: [
      { label: 'Next Tab', accelerator: 'Control+Tab', click: () => shortcut({ type: 'cycle', direction: 1 }) },
      { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: () => shortcut({ type: 'cycle', direction: -1 }) },
      ...Array.from({ length: 9 }, (_, i) => ({ label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
        accelerator: `Command+${i + 1}`, click: () => shortcut({ type: 'jump', index: i + 1 }) })),
    ] },
    { role: 'windowMenu' },
  ];
}

module.exports = { applicationMenu };
