'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-app-appearance-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic', theme: 'light', showdexPrompted: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch {} await pause(80); }
  throw new Error('Timed out: ' + label);
}
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', request => {
    if (!request.url.startsWith('https://play.pokemonshowdown.com/fx/client-bg-')) return new Response('', {status:404});
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000"><defs><linearGradient id="g"><stop stop-color="#c8d6e9"/><stop offset="1" stop-color="#faf0ca"/></linearGradient></defs><rect width="1500" height="1000" fill="url(#g)"/></svg>', { headers: {'content-type':'image/svg+xml'} });
  });
  session.fromPartition('persist:showdown').protocol.handle('https', request => {
    if (request.url !== 'https://play.pokemonshowdown.com/') return new Response('', {status:404});
    return new Response('<!doctype html><html class="sd-launcher-shell"><body><div id="header"></div><div class="ps-room ps-room-light" id="room-teambuilder"><div class="sd-tb-head"><div class="sd-tb-titles"><h1>Teambuilder</h1><p>Your saved teams</p></div></div><div class="teampane"><div class="sd-tb-group"><h3>Gen 9 OU</h3><ul class="teamlist sd-tb-grid"><li><button class="team"><strong>Sample team</strong><small>OU</small></button></li></ul></div></div></div><script>window.app={updateLayout(){},focusRoom(){},leaveRoom(){},joinRoom(){},addPopup(){},rooms:{"":{searching:false,$:()=>({length:0})}},user:{get:k=>k==="name"?"Tester":""},curRoom:{id:""},popups:[],isDisconnected:false};</script></body></html>', {headers:{'content-type':'text/html'}});
  });
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'window');
  const win = BrowserWindow.getAllWindows()[0], renderer = win.webContents;
  const run = code => renderer.executeJavaScript(code);
  await until(() => !renderer.isLoading(), 'renderer');
  const client = win.contentView.children[0].webContents, clientId = client.id;
  await until(() => !client.isLoading(), 'client');
  const errors = [];
  renderer.on('console-message', event => { if(event.level === 'error' && !/ERR_|Failed to load resource/.test(event.message)) errors.push(event.message); });
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => ({ready:true,connected:true,me:'Tester',named:true,rooms:[],search:{pending:false,formats:[]},popups:0}));
  ipcMain.removeHandler('showdown:snapshot');
  ipcMain.handle('showdown:snapshot', () => ({
    ready:true,connected:true,user:{name:'Tester',userid:'tester',registered:true},formats:[{id:'gen9ou',name:'[Gen 9] OU',section:'Singles',presetTeam:false}],
    counts:{users:100,battles:20},teams:[],news:[],rooms:[],ratings:{},friends:{available:true,items:[]},
    stats:{gen9ou:{elo:1540,gxe:68,wins:30,losses:15}},statsAvailable:true,
  }));
  const output = path.join(__dirname, '../out/app-appearance'); fs.mkdirSync(output,{recursive:true});
  const load = async file => {
    await win.loadFile(path.join(__dirname, '../renderer', file));
    await run('window.HomeAppearance.loaded');
    await run('window.HomeAppearance.ready.then(()=>true)');
  };
  await load('settings.html');
  await until(() => run("!document.getElementById('homePalette').disabled"), 'Settings ready');
  const change = async (key, value) => {
    await run('(()=>{const c=document.getElementById('+JSON.stringify(key)+');c.value='+JSON.stringify(String(value))+';c.dispatchEvent(new Event("change"));})()');
    await until(() => run('!document.getElementById('+JSON.stringify(key)+').disabled'), 'choice saved');
  };
  for (const palette of ['garden', 'twilight']) {
    await change('homePalette', palette);
    assert.equal(await run('document.documentElement.dataset.homeTheme'), palette, 'Settings updates immediately');
    await until(() => client.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--sd-app").trim() === '+JSON.stringify(palette === 'garden' ? '#e9eddd' : '#e6eaf3')), 'client palette applied without reload');
  }
  await change('homeRadius', 14);
  await until(() => client.executeJavaScript('getComputedStyle(document.querySelector(".team")).borderRadius === "14px"'), 'client corners live');
  await change('homeRadius', 10);
  assert.equal(await client.executeJavaScript('getComputedStyle(document.getElementById("room-teambuilder")).backgroundImage'), 'none', 'Teambuilder ignores the saved wallpaper');
  assert.equal(win.contentView.children[0].webContents.id, clientId);
  await run('window.desktop.saveReplayNote({title:"A close game",url:"https://replay.pokemonshowdown.com/gen9ou-123456789",format:"gen9ou",notes:"Keep the late-game plan in mind."})');
  win.showInactive();
  for(const theme of ['light','dark']) {
    await run('window.desktop.setTheme('+JSON.stringify(theme)+')');
    for(const [width,height] of [[1366,768],[1024,640]]) {
      win.setSize(width,height);
      for(const page of ['settings','practice','stats','replays','resources','play','practice-battle']) {
        await load(page+'.html');
        if(page==='practice') await until(()=>run('document.querySelectorAll(".bot-card").length > 0'), 'bot cards');
        if(page==='stats') await until(()=>run('document.querySelectorAll("#stats-body tbody tr").length > 0'), 'stats rows');
        await pause(100);
        const geometry=await run(`(() => {
          const areas=[document.documentElement,...document.querySelectorAll('.content,.split,.bots-page,.stats-page,.res')];
          return {palette:document.documentElement.dataset.homeTheme,scheme:document.documentElement.style.colorScheme,
            overflow:areas.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.className || n.tagName),
            controls:[...document.querySelectorAll('.input,.select,.textarea')].every(n=>getComputedStyle(n).opacity==='1')};
        })()`);
        assert.equal(geometry.palette,'twilight',page);
        assert.equal(geometry.scheme,theme,page);
        assert.deepEqual(geometry.overflow,[],page+' fits '+width);
        assert.equal(geometry.controls,true,page+' controls remain solid');
        if(page==='practice') {
          assert.equal(await run('document.documentElement.dataset.backgroundState'),'plain','Bots always plain');
          assert.equal(await run('getComputedStyle(document.querySelector(".content")).backgroundImage'),'none','Bots has no artwork or texture');
          assert.equal(await run('document.getElementById("background-credit").hidden'),true,'no artwork credit on Bots');
        }
        fs.writeFileSync(path.join(output,page+'-'+width+'-'+theme+'.png'),(await renderer.capturePage()).toPNG());
      }
    }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS app appearance: seven launcher pages, light/dark at both desktop sizes, saved choices, immediate Settings/client updates, opaque controls, no overflow, persistent client.');
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
