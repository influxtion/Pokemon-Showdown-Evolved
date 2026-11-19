'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
// Real guest client and pinned Showdex; synthetic received battle logs, no battle or chat sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdex-dock-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic', showdexPrompted: true }));
require('../app/main');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, name) {
  for (let i = 0; i < 240; i++) {
    const result = await check();
    if (result) return result;
    await pause(250);
  }
  throw new Error('Timed out: ' + name);
}
app.whenReady().then(async () => {
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
  await until(() => !win.webContents.isLoading(), 'launcher');
  const page = code => win.webContents.executeJavaScript(code);
  const view = await until(() => win.contentView.children[0], 'client');
  const js = code => view.webContents.executeJavaScript(code).catch(error => {
    throw new Error(`${error.message}: ${code.slice(0, 200)}`);
  });
  assert.equal((await page('window.desktop.installShowdex()')).ok, true);
  await until(async () => (await page('window.desktop.getShowdex()')).loaded, 'Showdex');
  await page("window.desktop.showdown('focus-room', {room:'view-hellodex'})");
  await win.loadFile(path.join(__dirname, '../renderer/play.html'));
  await until(() => view.getVisible(), 'visible client');
  win.setSize(1600, 900);
  win.setOpacity(1);
  win.setFocusable(true);
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  await pause(1000);
  // From here on even an accidental UI action cannot send a battle choice or chat message.
  await js('window.__dockSent = []; app.send = (...args) => window.__dockSent.push(args); 0');
  const id = 'battle-gen9ou-999999999';
  const log = `>${id}\n|init|battle\n|title|Dock Test A vs. Dock Test B\n|j|☆Dock Test A\n|j|☆Dock Test B\n|player|p1|Dock Test A|1\n|player|p2|Dock Test B|2\n|teamsize|p1|1\n|teamsize|p2|1\n|gametype|singles\n|gen|9\n|tier|[Gen 9] OU\n|rated|\n|rule|Species Clause: Limit one of each Pokémon\n|start\n|switch|p1a: Pikachu|Pikachu, M|100/100\n|switch|p2a: Charizard|Charizard, M|100/100\n|turn|1\n`;
  await js(`app.receive(${JSON.stringify(log)}); app.focusRoom(${JSON.stringify(id)}); 0`);
  await until(() => js(`!!app.rooms[${JSON.stringify(id)}]?.battle?.calcdexInit`), 'battle calculator');
  await pause(2500);
  const captures = path.join(__dirname, '../out/showdex-dock');
  fs.mkdirSync(captures, {recursive:true});
  for (const theme of ['light', 'dark']) {
    await page(`window.desktop.setTheme(${JSON.stringify(theme)})`);
    for (const [width,height] of [[1600,900],[1366,768],[1024,640]]) {
      win.setSize(width,height);
      win.focus();
      await pause(1200);
      const layout = await js(`(() => {
        const r = app.rooms[${JSON.stringify(id)}];
        const rect = n => { if(!n) return null; const b=n.getBoundingClientRect(); const s=getComputedStyle(n); return {x:b.x,y:b.y,w:b.width,h:b.height,display:s.display}; };
        return {current:app.curRoom.id, width:innerWidth, height:innerHeight, compact:r.el.classList.contains('sd-calcdex-compact'), field:rect(r.el.querySelector('.battle')), controls:rect(r.el.querySelector('.battle-controls')), chat:rect(r.el.querySelector('.battle-log')),calc:rect(document.querySelector('.sd-calcdex-docked'))};
      })()`);
      assert.equal(layout.current, id);
      assert.ok(layout.calc && layout.calc.display !== 'none');
      assert.ok(layout.calc.x >= layout.field.x + layout.field.w, 'calculator never covers the field');
      assert.ok(layout.calc.x + layout.calc.w <= layout.width, 'calculator fits client');
      assert.ok(layout.calc.y + layout.calc.h <= layout.height, 'calculator scroll area fits client');
      assert.ok(layout.controls.y >= layout.field.y + layout.field.h, 'controls below field');
      if (layout.compact) {
        assert.ok(layout.chat.y >= layout.controls.y + layout.controls.h, 'compact chat below controls');
      } else {
        assert.ok(layout.chat.x >= layout.field.x + layout.field.w, 'chat beside the battlefield');
        assert.ok(layout.chat.x + layout.chat.w <= layout.calc.x, 'chat to the left of calculator');
        assert.ok(layout.chat.w >= 220, 'chat remains readable');
      }
      fs.writeFileSync(path.join(captures, `dock-${theme}-${width}.png`), (await view.webContents.capturePage()).toPNG());
    }
  }
  const toggle = `app.rooms[${JSON.stringify(id)}].el.querySelector('.sd-showdex-dock-toggle').click(); 0`;
  await js(toggle);
  await until(() => js('!document.querySelector(".sd-calcdex-docked")'), 'hide dock');
  assert.equal(await js(`app.rooms[${JSON.stringify(id)}].el.classList.contains('sd-calcdex-battle')`), false);
  await js(toggle);
  await until(() => js('!!document.querySelector(".sd-calcdex-docked")'), 'reopen dock');
  await page("window.desktop.showdown('focus-room', {room:'view-hellodex'})");
  await until(() => js('!document.querySelector(".sd-calcdex-docked")'), 'dock hidden on another tab');
  await page(`window.desktop.showdown('focus-room', {room:${JSON.stringify('view-calcdex-' + id.replaceAll('-', ''))}})`);
  await until(() => js(`app.curRoom.id === ${JSON.stringify(id)} && !!document.querySelector('.sd-calcdex-docked')`), 'calculator tab opens beside matching battle');
  // A battle opened at narrow width uses Showdex's native overlay mode.
  const second = 'battle-gen9ou-999999998';
  await js(`Dex.prefs('onepanel', true); app.receive(${JSON.stringify(log.replaceAll(id, second))}); app.focusRoom(${JSON.stringify(second)}); 0`);
  await until(() => js(`!!app.rooms[${JSON.stringify(second)}]?.battle?.calcdexInit`), 'second calculator');
  await until(() => js(`!!app.rooms[${JSON.stringify(second)}].el.querySelector('.sd-showdex-dock-toggle')`), 'overlay dock button');
  assert.equal(await js(`!!app.rooms[${JSON.stringify(second)}].el.querySelector('[class*="Calcdex-module-overlayContainer--"]')`), true);
  await js(`app.rooms[${JSON.stringify(second)}].el.querySelector('.sd-showdex-dock-toggle').click(); 0`);
  await until(() => js(`app.rooms[${JSON.stringify(second)}].el.classList.contains('sd-calcdex-battle')`), 'overlay dock visible');
  assert.equal(await js(`!!app.rooms[${JSON.stringify(second)}].el.querySelector('.battle-log-add button:disabled')`), false, 'chat stays available beside overlay');
  // Receiving a move must still update Showdex's battle state while docked.
  await js(`app.receive(${JSON.stringify('>' + second + '\n|move|p1a: Pikachu|Thunderbolt|p2a: Charizard\n|-damage|p2a: Charizard|50/100\n|turn|2\n')}); 0`);
  await until(() => js(`app.rooms[${JSON.stringify(second)}].el.querySelector('[data-showdex-module=calcdex]')?.textContent.includes('50%')`), 'calculator follows battle HP');
  const request = {
    rqid: 1,
    active: [{ moves: [{ move: 'Thunderbolt', id: 'thunderbolt', pp: 15, maxpp: 15, target: 'normal', disabled: false }], canTerastallize: 'Electric' }],
    side: { id: 'p1', name: 'Dock Test A', pokemon: [{ ident: 'p1: Pikachu', details: 'Pikachu, M', condition: '211/211', active: true,
      stats: { atk: 131, def: 116, spa: 136, spd: 136, spe: 237 }, moves: ['thunderbolt'], baseAbility: 'static', ability: 'static', item: 'lightball', pokeball: 'pokeball' }] },
  };
  await js(`app.receive(${JSON.stringify('>' + second + '\n|request|' + JSON.stringify(request))}); 0`);
  await until(() => js(`!!app.rooms[${JSON.stringify(second)}].el.querySelector('button[name=chooseMove]')`), 'player controls');
  await js(`app.rooms[${JSON.stringify(second)}].el.querySelector('button[name=selectMove]').click(); 0`);
  await pause(500);
  fs.writeFileSync(path.join(captures, 'dock-player-minimum.png'), (await view.webContents.capturePage()).toPNG());
  assert.equal(await js(`(() => {
    const room = app.rooms[${JSON.stringify(second)}].el;
    const move = room.querySelector('button[name=chooseMove]').getBoundingClientRect();
    const calc = room.querySelector('.sd-calcdex-docked').getBoundingClientRect();
    return move.top >= 0 && move.right < calc.left && move.height > 20;
  })()`), true, 'move selection remains separate and usable');
  fs.writeFileSync(path.join(captures, 'dock-overlay-minimum.png'), (await view.webContents.capturePage()).toPNG());
  // Removing a battle locally must not leave a floating calculator on the next room.
  await js(`app.removeRoom(${JSON.stringify(second)}); app.focusRoom('view-hellodex'); 0`);
  await until(() => js('!document.querySelector(".sd-calcdex-docked")'), 'closed battle cleaned up');
  assert.ok((await js('window.__dockSent')).every(args => String(args[0]).includes('/leave')), 'only local fixture cleanup attempted a send');
  console.log('PASS Showdex dock: themes, widths, non-overlapping layout, hide/show and tab navigation');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
