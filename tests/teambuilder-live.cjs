'use strict';

// The official client, local teams in a disposable guest profile. No account or battle actions.
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-teambuilder-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'dark', homeLayout: 'classic', startPage: 'showdown', showdexPrompted: true,
}));
// Third-party advertisement frames can take focus from the automated guest window.
// This test-only filter keeps the real client/data/server and suppresses those frames.
app.whenReady().then(() => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: details.resourceType === 'subFrame' });
  });
});
require('../app/main');
const output = path.join(__dirname, '../out/teambuilder-workspace');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
let client;
const clientErrors = [];
app.whenReady().then(async () => {
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
  const page = code => win.webContents.executeJavaScript(code);
  await until(() => !win.webContents.isLoading(), 'launcher');
  const view = await until(() => win.contentView.children[0], 'client');
  client = view.webContents;
  win.show();
  win.focus();
  client.focus();
  client.on('console-message', details => { if (details.level === 'error' && details.message.startsWith('Uncaught')) clientErrors.push({message:details.message, line:details.lineNumber, source:details.sourceId}); });
  const js = async code => {
    try { return await client.executeJavaScript(code); }
    catch (error) { throw new Error(`Client script failed: ${code.slice(0,300)}`, { cause: error }); }
  };
  await until(() => page('window.desktop.getSession().then(s => s.ready && s.shell && s.connected)'), 'connected shell', 60000);
  assert.equal(await js('app.user.get("named")'), false);
  await page('window.desktop.showdown("join", {room:"teambuilder"})');
  await until(() => js('!!app.rooms.teambuilder'), 'teambuilder');
  await js(`window.__tbErrors=[];addEventListener('error',event=>window.__tbErrors.push({message:event.message,stack:event.error?.stack})); 0`);
  await js('window.tb = app.rooms.teambuilder; tb.newTop("team"); 0');
  await until(() => js('!!document.querySelector(".sd-te-picker input")'), 'new empty workspace');
  await js('tb.changeFormat("gen9ou"); 0');
  await until(() => js('!!document.querySelector(".sd-te-picker input")'), 'OU workspace');
  assert.equal(await js('document.querySelectorAll(".sd-te-slot").length'), 6);
  // Exercise the field click as well as focus, which may be suppressed on an
  // occluded native window while the test is running in the background.
  async function focusField(field) {
    await until(() => js(`!!document.querySelector('.teamchart input[name=${field}]')`), field + ' field');
    await js(`(() => {const input=document.querySelector('.teamchart input[name=${field}]');input.focus();input.click();})()`);
  }
  async function choose(field, query, entry) {
    await focusField(field);
    await until(() => js(`document.querySelector('.sd-te-picker input')?.dataset.for === ${JSON.stringify(field)}`), field + ' picker', 5000);
    await js(`(() => {const input=document.querySelector('.sd-te-picker input');input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    if (field === 'pokemon' && query === 'Garchomp') {
      await js('tb.update(); 0');
      await until(() => js('document.querySelector(".sd-te-picker input")?.value === "Garchomp"'), 'query survives native rebuild');
    }
    await until(() => js(`!!document.querySelector('.sd-te-picker a[data-entry=${JSON.stringify(entry)}]')`), entry);
    await js(`document.querySelector('.sd-te-picker a[data-entry=${JSON.stringify(entry)}]').click(); 0`);
    await pause(100);
  }
  await choose('pokemon', 'Garchomp', 'pokemon|Garchomp');
  console.log('Selected first Pokémon');
  await until(() => js('document.querySelectorAll(".sd-te-form").length === 2'), 'inline forms');
  await choose('item', 'Leftovers', 'item|Leftovers');
  await choose('ability', 'Rough Skin', 'ability|Rough Skin');
  await changeName();
  async function changeName() {
    await js(`(() => {const input=document.querySelector('.teamnameedit');input.value='Sandstorm core';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await js('tb.curTeam.name'), 'Sandstorm core');
  }
  for (const [i, move] of ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Swords Dance'].entries()) await choose('move' + (i + 1), move, 'move|' + move);
  assert.deepEqual(await js('({species:tb.curSet.species,item:tb.curSet.item,ability:tb.curSet.ability,moves:tb.curSet.moves})'), {
    species: 'Garchomp', item: 'Leftovers', ability: 'Rough Skin', moves: ['Earthquake', 'Dragon Claw', 'Stealth Rock', 'Swords Dance'],
  });
  async function change(selector, value, event = 'change') {
    await js(`(() => {const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    await pause(100);
  }
  await change('.sd-te-form [name=level]', '50');
  await change('.sd-te-form [name=happiness]', '123');
  await change('.sd-te-form [name=teratype]', 'Fire');
  await change('.sd-te-form [name=nature]', 'Jolly');
  await change('.sd-te-form [name=stat-atk]', '252', 'input');
  await change('.sd-te-form [name=stat-spe]', '252+', 'input');
  await change('.sd-te-form [name=iv-spa]', '0', 'input');
  await change('.sd-te-form [name=stat-atk]', '999', 'input');
  assert.equal(await js('tb.curSet.evs.atk'), 252, 'native EV cap');
  await change('.sd-te-form [name=stat-atk]', '252', 'input');
  console.log('Edited inline fields');
  assert.deepEqual(await js('({level:tb.curSet.level,happiness:tb.curSet.happiness,tera:tb.curSet.teraType,nature:tb.curSet.nature,atk:tb.curSet.evs.atk,spe:tb.curSet.evs.spe,spa:tb.curSet.ivs.spa})'), {
    level: 50, happiness: 123, tera: 'Fire', nature: 'Jolly', atk: 252, spe: 252, spa: 0,
  });
  await js('document.querySelector(".sd-te-slot:nth-of-type(2)").click(); 0');
  await choose('pokemon', 'Corviknight', 'pokemon|Corviknight');
  console.log('Selected second Pokémon');
  await js('document.querySelector(".sd-te-slot:nth-of-type(1)").click(); 0');
  await until(() => js('tb.curSet.species === "Garchomp" && document.querySelector(".sd-te-form [name=level]")?.value === "50"'), 'switch preserves edits');
  console.log('Switched back');
  // Keyboard choice and Escape clear use the native search keyboard handler.
  await focusField('item');
  await until(() => js('document.querySelector(".sd-te-picker input")?.dataset.for === "item"'), 'keyboard item search');
  await js(`(() => {const input=document.querySelector('.sd-te-picker input');input.value='Rocky Helmet';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await js("document.querySelector('.sd-te-picker input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true})); 0");
  await until(() => js('tb.curSet.item === "Rocky Helmet"'), 'keyboard item choice');
  await choose('item', 'Leftovers', 'item|Leftovers');
  await focusField('pokemon');
  await until(() => js('document.querySelector(".sd-te-picker input")?.dataset.for === "pokemon"'), 'Pokémon roster');
  await js("document.querySelector('.sd-te-picker input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true,cancelable:true})); 0");
  await until(() => js('document.querySelector(".sd-te-picker input").value === ""'), 'Escape clears search');
  // Reach the end using the real pane's scroll listener, including incremental rows.
  for (let i = 0; i < 30; i++) {
    if (await js('tb.search.renderingDone')) break;
    await js(`(() => {const results=document.querySelector('.teambuilder-results');results.scrollTop=results.scrollHeight;results.dispatchEvent(new Event('scroll'));})()`);
    await pause(30);
  }
  assert.equal(await js('tb.search.renderingDone'), true, 'full Pokémon roster reachable');
  assert.equal(await js('tb.search.renderedIndex'), await js('tb.search.resultSet.length'), 'no results omitted');
  await js('document.querySelector(".teamchart input[name=pokemon]").value="Garchomp"; 0');
  await choose('pokemon', 'Garchomp', 'pokemon|Garchomp');
  // Delete and undo keep the existing native data operations.
  await js('document.querySelector(".sd-te-slot:nth-of-type(2)").click(); 0');
  await js('document.querySelector(".setmenu button[name=deleteSet]").click(); 0');
  await until(() => js('!!document.querySelector(".sd-te-undo")'), 'undo available');
  await js('document.querySelector(".sd-te-undo").click(); 0');
  await until(() => js('tb.curSet.species === "Corviknight"'), 'undo restored Pokémon');
  await js('document.querySelector(".sd-te-slot:nth-of-type(1)").click(); 0');
  await focusField('move1');
  await until(() => js('document.querySelector(".sd-te-picker input")?.dataset.for === "move1"'), 'move roster');
  // Disclosures expose native controls without interrupting the selection pane.
  const detailsExtra = '.sd-te-form[data-form=details] .sd-te-extra';
  const statsExtra = '.sd-te-form[data-form=stats] .sd-te-extra';
  assert.equal(await js(`document.querySelector('${detailsExtra}').open`), false);
  await js(`document.querySelector('${detailsExtra} > summary').click(); document.querySelector('.sd-te-form [name=gender][value=M]').click(); document.querySelector('.sd-te-form [name=shiny][value=yes]').click(); 0`);
  await until(() => js('tb.curSet.gender === "M" && tb.curSet.shiny === true'), 'expanded detail edits');
  await choose('item', 'Leftovers', 'item|Leftovers');
  assert.equal(await js(`document.querySelector('${detailsExtra}').open`), true, 'details stay expanded after native refresh');
  await js(`document.querySelector('.sd-te-form [name=gender][value=N]').click(); document.querySelector('.sd-te-form [name=shiny][value=no]').click(); document.querySelector('${detailsExtra} > summary').click(); 0`);
  await js(`document.querySelector('${statsExtra} > summary').click(); 0`);
  await change('.sd-te-form [name=ivspread]', '31/0/31/31/31/0');
  assert.equal(await js('tb.curSet.ivs.spe'), 0, 'expanded IV presets use native handler');
  assert.equal(await js(`document.querySelector('${statsExtra}').open`), true, 'spread tools stay expanded after native refresh');
  await change('.sd-te-form [name=iv-atk]', '31', 'input');
  await change('.sd-te-form [name=iv-spe]', '31', 'input');
  await change('.sd-te-form [name=iv-spa]', '0', 'input');
  await change('.sd-te-form [name=evslider-hp]', '4', 'input');
  await change('.sd-te-form [name=evslider-hp]', '4', 'change');
  assert.equal(await js('tb.curSet.evs.hp'), 4, 'compact slider still edits EVs');
  await change('.sd-te-form [name=evslider-hp]', '0', 'input');
  await change('.sd-te-form [name=evslider-hp]', '0', 'change');
  await js(`document.querySelector('${statsExtra} > summary').click(); document.querySelector('.teamchartbox.individual').scrollTop=0; 0`);
  await focusField('move1');
  for (const theme of ['light', 'dark']) {
    await page(`window.desktop.setTheme(${JSON.stringify(theme)})`);
    for (const [width, height] of [[1600,900], [1366,768], [1024,640]]) {
      win.setSize(width, height);
      await pause(350);
      await client.capturePage();
      await pause(250);
      const layout = await js(`(() => {
        const rect = selector => {const n=document.querySelector(selector),r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scroll:n.scrollWidth,client:n.clientWidth,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight};};
        return {viewport:innerWidth, roster:rect('.sd-te-roster'),editor:rect('.teamchartbox.individual'),picker:rect('.sd-te-picker'),results:rect('.teambuilder-results'),root:rect('#room-teambuilder'),stats:rect('.sd-te-stat-table'),nature:rect('.sd-te-form [name=nature]'),dialogs:document.querySelectorAll('[aria-modal=true]').length};
      })()`);
      fs.writeFileSync(path.join(output, `layout-${width}-${theme}.json`), JSON.stringify(layout, null, 2));
      assert.equal(layout.dialogs, 0, 'no picker modal');
      assert.ok(layout.roster.right <= layout.editor.x + 1 && layout.editor.right <= layout.picker.x + 1, 'three non-overlapping columns');
      assert.ok(layout.picker.right <= layout.viewport + 1, 'picker fits');
      assert.ok(layout.root.scroll <= layout.root.client + 1, 'no page overflow');
      assert.ok(layout.results.scroll <= layout.results.client + 1, 'results fit');
      assert.ok(layout.editor.scroll <= layout.editor.client + 1, 'editor fits');
      assert.ok(layout.nature.y >= layout.stats.bottom - 1, 'nature sits below the full-width stat table');
      if (width >= 1366) {
        assert.ok(layout.nature.bottom <= layout.editor.bottom + 1, 'all main controls visible without scrolling');
        assert.ok(layout.editor.scrollHeight <= layout.editor.clientHeight + 1, 'default editor fits without vertical scrolling');
      } else assert.ok(layout.editor.scrollHeight - layout.editor.clientHeight < 160, 'compact editor needs only a short scroll at minimum size');
      fs.writeFileSync(path.join(output, `workspace-${width}-${theme}.png`), (await client.capturePage()).toPNG());
      await js('document.querySelector(".teamchartbox.individual").scrollTop=9999; 0');
      await pause(100);
      fs.writeFileSync(path.join(output, `stats-${width}-${theme}.png`), (await client.capturePage()).toPNG());
      await js('document.querySelector(".teamchartbox.individual").scrollTop=0; 0');
      if (width === 1024) {
        await js(`document.querySelector('${detailsExtra} > summary').click(); document.querySelector('${statsExtra} > summary').click(); 0`);
        await pause(100);
        const expanded = await js(`(() => {const editor=document.querySelector('.teamchartbox.individual');return {scroll:editor.scrollWidth,client:editor.clientWidth};})()`);
        assert.ok(expanded.scroll <= expanded.client + 1, 'expanded controls fit the narrow editor');
        fs.writeFileSync(path.join(output, `details-expanded-${theme}.png`), (await client.capturePage()).toPNG());
        await js('document.querySelector(".teamchartbox.individual").scrollTop=9999; 0');
        fs.writeFileSync(path.join(output, `tools-expanded-${theme}.png`), (await client.capturePage()).toPNG());
        await js(`document.querySelector('${detailsExtra} > summary').click(); document.querySelector('${statsExtra} > summary').click(); document.querySelector('.teamchartbox.individual').scrollTop=0; 0`);
      }
    }
  }
  for (const field of ['pokemon', 'item', 'ability']) {
    await focusField(field);
    await until(() => js(`document.querySelector('.sd-te-picker input')?.dataset.for === ${JSON.stringify(field)}`), field + ' browse');
    await pause(100);
    fs.writeFileSync(path.join(output, `roster-${field}-1024-dark.png`), (await client.capturePage()).toPNG());
  }
  // Native per-Pokémon text import remains inline and changes the intended slot.
  await js('document.querySelector(".setmenu button[name=importSet]").click(); 0');
  await until(() => js('document.querySelector(".pokemonedit")?.getClientRects().length'), 'set import');
  await js(`(() => {const input=document.querySelector('.pokemonedit');input.value=input.value.replace('Garchomp', 'Chomper (Garchomp)');document.querySelector('[name=savePokemonImport]').click();})()`);
  await until(() => js('tb.curSet?.name === "Chomper"'), 'set import saved');
  assert.equal(await js('tb.curSetList[1].species'), 'Corviknight');
  await js('document.querySelector(".sd-te-full").click(); 0');
  await until(() => js('!!document.querySelector(".sd-te-paste")'), 'overview');
  fs.writeFileSync(path.join(output, 'overview.png'), (await client.capturePage()).toPNG());
  await js('document.querySelector(".sd-te-actions [name=import]").click(); 0');
  await until(() => js('!!document.querySelector(".teamedit textarea")'), 'whole team export');
  assert.match(await js('document.querySelector(".teamedit textarea").value'), /Chomper \(Garchomp\)/);
  await js('document.querySelector(".sd-te-actions .savebutton").click(); 0');
  await until(() => js('!!document.querySelector(".sd-te-paste")'), 'whole team import');
  await js('tb.back(); 0');
  // Generation-specific native forms, including DVs and formats without items/abilities.
  for (const format of ['gen1ou', 'gen7ou', 'gen8ou', 'gen7letsgoou']) {
    await js(`tb.newTop('team'); tb.changeFormat(${JSON.stringify(format)}); 0`);
    await choose('pokemon', 'Pikachu', 'pokemon|Pikachu');
    await until(() => js('!!document.querySelector(".sd-te-form .statform")'), format + ' stats');
    if (format === 'gen1ou') {
      assert.equal(await js('document.querySelector(".sd-te-form [name=iv-atk]").max'), '15');
      assert.equal(await js('document.querySelectorAll(".teamchart [name=item], .teamchart [name=ability], .sd-te-form [name=teratype]").length'), 0);
      await change('.sd-te-form [name=iv-atk]', '7', 'input');
      assert.equal(await js('tb.curSet.ivs.atk'), 14);
    } else if (format === 'gen7ou') {
      await change('.sd-te-form [name=happiness]', '0');
      assert.equal(await js('tb.curSet.happiness'), 0);
    } else if (format === 'gen8ou') {
      assert.equal(await js('!!document.querySelector(".sd-te-form [name=dynamaxlevel]")'), true);
      assert.equal(await js('!!document.querySelector(".sd-te-form [name=teratype]")'), false);
    } else {
      assert.equal(await js('document.querySelectorAll(".teamchart [name=item], .teamchart [name=ability]").length'), 0);
      assert.equal(await js('document.querySelector(".sd-te-form [name=happiness]").disabled'), true);
    }
    await js('document.querySelector(".sd-te-full").click(); 0');
    await until(() => js('!!document.querySelector(".sd-te-paste")'), 'generation overview');
    await js('tb.back(); 0');
  }
  const teamIndex = await js('Storage.teams.findIndex(t => t.name === "Sandstorm core")');
  await js('tb.importSetButtons(); 0'); // a late native sample-set response after leaving
  const packed = await js(`Storage.teams[${teamIndex}].team`);
  const errors = await js('window.__tbErrors');
  if (errors.length) console.error(errors);
  await client.reload();
  await until(() => js('!!window.Storage?.teams?.length'), 'persisted team');
  assert.equal(await js(`Storage.teams[${teamIndex}].team`), packed);
  assert.match(await js(`Storage.exportTeam(Storage.unpackTeam(Storage.teams[${teamIndex}].team))`), /Happiness: 123/);
  assert.equal(await js('app.user.get("named")'), false);
  assert.deepEqual(clientErrors, [], 'no uncaught client errors');
  console.log('PASS teambuilder workspace: six slots, selections/keyboard/full roster scroll, inline details/EVs/IVs/nature, expandable details/spread tools, EV sliders, compact geometry, native caps, delete/undo, set/team text import, Gen 1/7/8/9 and Lets Go, reload persistence, both themes at three sizes.');
  win.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error);
  console.error(clientErrors);
  if (client && !client.isDestroyed()) {
    try {
      console.error(await client.executeJavaScript('({chart:tb.curChartName,type:tb.curChartType,active:document.activeElement?.outerHTML.slice(0,400),proxy:document.querySelector(".sd-te-picker input")?.outerHTML,set:tb.curSet})'));
      fs.writeFileSync(path.join(output, 'failure.html'), await client.executeJavaScript('document.querySelector("#room-teambuilder")?.outerHTML || document.body.outerHTML'));
      fs.writeFileSync(path.join(output, 'failure.png'), (await client.capturePage()).toPNG());
    } catch {}
  }
  app.exit(1);
});
