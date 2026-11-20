'use strict';
// Optional live guest visual check. No login, search, challenge or chat messages.
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { app, BrowserWindow } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-appearance-live-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme:'light', homeLayout:'classic', showdexPrompted:true }));
require('../app/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout=60000) {
  const end = Date.now()+timeout;
  while(Date.now()<end) { try { const value=await check(); if(value) return value; } catch {} await pause(200); }
  throw new Error('Timed out: '+label);
}
app.whenReady().then(async()=>{
  const win=await until(()=>BrowserWindow.getAllWindows()[0],'window');
  const page=code=>win.webContents.executeJavaScript(code);
  await until(()=>!win.webContents.isLoading(),'Home');
  const view=await until(()=>win.contentView.children[0],'client');
  const client=view.webContents, id=client.id;
  const js=code=>client.executeJavaScript(code);
  const state=await until(async()=>{const s=await page('window.desktop.getSession()');return s.ready&&s.shell&&s.connected?s:null;},'connected shell');
  assert.equal(state.named,false,'disposable guest');
  // These teams exist only in this temporary local profile.
  await js(`(()=>{const text='Pikachu\\nAbility: Static\\n- Thunderbolt\\n- Quick Attack\\n';
    for(const [name,format] of [['Weekend favorites','gen9ou'],['A fresh start','gen9ou'],['Battle buddies','gen9uu']])
      Storage.teams.push({name,format,team:Storage.packTeam(Storage.importTeam(text)),folder:''});
    Storage.saveTeams();return true;})()`);
  const output=path.join(__dirname,'../out/app-appearance-live');fs.mkdirSync(output,{recursive:true});
  win.showInactive();
  async function native(screen) {
    await win.loadFile(path.join(__dirname,'../renderer',screen+'.html'));
    await page('window.HomeAppearance.loaded');await page('window.HomeAppearance.ready.then(()=>true)');
    if(screen!=='play') assert.equal(await page('document.documentElement.dataset.backgroundState'),screen==='practice'?'plain':'ready','page background policy');
  }
  async function open(room) {
    if(room==='community') assert.equal(await page("window.desktop.showdown('show-menu',{tab:'community'})"),true);
    else assert.equal(await page('window.desktop.showdown("join",{room:'+JSON.stringify(room)+'})'),true,room);
    if(!win.webContents.getURL().endsWith('/play.html')) await native('play');
    await until(()=>js('app.curRoom.id === '+JSON.stringify(room==='community'?'':room)),room+' focus');
    await until(()=>view.getVisible(),'client visible');
    await pause(450);
  }
  for(const theme of ['light','dark']) {
    await page('window.desktop.setTheme('+JSON.stringify(theme)+')');
    for(const [width,height] of [[1366,768],[1024,640]]) {
      win.setSize(width,height);
      for(const screen of ['practice','replays','settings','resources']) {
        await native(screen);await pause(250);
        fs.writeFileSync(path.join(output,screen+'-'+width+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      for(const room of ['teambuilder','community','ladder','rooms','battles','lobby']) {
        await open(room);
        const chrome=await js(`(()=>{const root=app.curRoom.el;return {width:innerWidth,overflow:root.scrollWidth>root.clientWidth+2,
          palette:getComputedStyle(document.documentElement).getPropertyValue('--sd-app').trim(),
          background:getComputedStyle(root).backgroundImage};})()`);
        assert.equal(chrome.palette,theme==='dark'?'#25334e':'#e6eaf3',room+' palette');
        assert.equal(chrome.overflow,false,room+' fits '+width);
        if(['teambuilder','community','rooms'].includes(room)) {
          assert.equal(chrome.background,'none',room+' always plain');
          await until(()=>page('document.documentElement.dataset.backgroundPolicy === "plain"'),'plain launcher shell');
          assert.equal(await page('document.getElementById("background-credit").hidden'),true,'no artwork credit for '+room);
          if(room==='community') assert.equal(await js('getComputedStyle(document.querySelector(".mainmenuwrapper")).backgroundImage'),'none','Community has no gradient');
        } else if(room!=='lobby') assert.match(chrome.background,/client-bg-ocean/,room+' artwork');
        fs.writeFileSync(path.join(output,room+'-'+width+'-'+theme+'.png'),(await client.capturePage()).toPNG());
      }
    }
  }
  assert.equal(client.id,id,'appearance and navigation keep the client alive');
  const end=await page('window.desktop.getSession()');assert.equal(end.named,false);assert.equal(end.search.pending,false);
  console.log('PASS live app appearance: real artwork, four launcher pages, Teambuilder/Community/Ladder/rooms/spectate/chat, both themes and desktop sizes; isolated guest only.');
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
