'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const options = require('../renderer/home-appearance-options');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-home-appearance-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeLayout: 'classic', showdexPrompted: true, theme: 'light' }));
const liveArt = process.argv.includes('--live-art');
const output = path.join(__dirname, '..', 'out', 'home-appearance');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await pause(50); }
  throw new Error('Timed out: ' + label);
}

app.whenReady().then(async () => {
  const requests = [];
  let offline = false;
  session.defaultSession.protocol.handle('https', request => {
    requests.push(request.url);
    if (!/^https:\/\/play\.pokemonshowdown\.com\/fx\/client-bg-(ocean|horizon|shaymin|charizards|psday)\.jpg$/.test(request.url) || offline) {
      return new Response('', { status: 404 });
    }
    if (liveArt) return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000"><rect width="1500" height="1000" fill="#9cbccf"/></svg>',
      { headers: { 'content-type': 'image/svg+xml' } });
  });
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  require('../app/main');
  await until(() => BrowserWindow.getAllWindows().length, 'app');
  const win = BrowserWindow.getAllWindows()[0], renderer = win.webContents;
  await until(() => !renderer.isLoading() && renderer.getURL().endsWith('index.html'), 'Home');
  const clientId = win.contentView.children[0].webContents.id;
  const errors = [];
  renderer.on('console-message', details => { if (details.level === 'error' && !details.message.includes('ERR_')) errors.push(details.message); });
  const current = { ready: true, connected: true, me: 'Guest123', named: false, rooms: [], search: { pending: false, formats: [] }, popups: 0 };
  ipcMain.removeHandler('showdown:session');
  ipcMain.handle('showdown:session', () => current);
  ipcMain.removeHandler('showdown:snapshot');
  let snapshotReady = true;
  const snapshot = {
    ready: true, connected: true, user: { name: 'Guest123', userid: 'guest123', registered: false },
    counts: { users: 100, battles: 20 }, currentFormat: 'gen9randombattle',
    formats: [{ id: 'gen9randombattle', name: '[Gen 9] Random Battle', section: 'Singles', presetTeam: true },
      { id: 'gen9ou', name: '[Gen 9] OU', section: 'Singles', presetTeam: false }],
    teams: [], ratings: {}, friends: { available: false, items: [] },
    news: [
      { id: '123', title: 'Community tournament', text: 'Join this week’s tournament.', author: 'Staff', body: [[{ text: 'Join this week’s tournament.' }], [{ text: 'Registration is open through Friday.' }]] },
      { id: '124', title: 'Metagame update', text: 'Read the latest discussion from the community.', author: 'Staff' },
    ],
    rooms: ['Lobby', 'OverUsed', 'Random Battles', 'Tournaments', 'Help'].map(title => ({ title, desc: '', users: 50 })),
  };
  ipcMain.handle('showdown:snapshot', () => snapshotReady ? snapshot : { ready: false });
  const run = code => renderer.executeJavaScript(code);
  const load = async file => {
    await win.loadFile(path.join(__dirname, '..', 'renderer', file));
    await until(() => !renderer.isLoading(), file);
  };
  const home = async () => {
    await load('index.html');
    await until(() => run("!!document.documentElement.dataset.homeTheme && !document.getElementById('battle').disabled"), 'working Home');
    await run('window.HomeAppearance.ready.then(() => true)');
  };
  const save = async (key, value) => assert.equal((await run('window.desktop.setSetting(' + JSON.stringify(key) + ',' + JSON.stringify(value) + ')')).ok, true);
  await home();
  assert.equal(await run('document.documentElement.dataset.backgroundState'), 'ready');
  assert.equal(await run('document.documentElement.dataset.homeTheme'), 'twilight', 'new profiles default to Twilight');
  assert.match(await run("document.getElementById('background-credit').textContent"), /Quanyails/);

  // Exercise the actual Settings controls and persistence, then return to the real Home page.
  await run("document.querySelector('a[href=\"settings.html#home-appearance\"]').click(); 0");
  await until(() => run("!!document.getElementById('homePalette') && !document.getElementById('homePalette').disabled"), 'customization settings');
  assert.equal(await run('document.documentElement.dataset.homeTheme'), 'twilight', 'Settings shares the selected palette');
  assert.deepEqual(await run("[...document.getElementById('homePalette').options].map(o=>o.text)"), Object.values(options.palettes).map(p => p.name));
  const chosen = { homePalette: 'seaside', homeBackground: 'shaymin', homeBackgroundTone: 'natural', homeBackgroundFit: 'fit', homeBorders: 'stitched', homeRadius: 14, homeSpacing: 'airy', homeTexture: false };
  for (const [key, value] of Object.entries(chosen)) {
    await run('(() => { const c=document.getElementById(' + JSON.stringify(key) + ');c.value=' + JSON.stringify(String(value)) + ";c.dispatchEvent(new Event('change')); })()");
    await until(() => run('!document.getElementById(' + JSON.stringify(key) + ').disabled'), 'saved ' + key);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'))[key], value);
  }
  await load('settings.html');
  await until(() => run("document.getElementById('homePalette').value === 'seaside'"), 'settings restored');
  win.setSize(1024, 640);
  win.showInactive();
  await run("document.getElementById('home-appearance').scrollIntoView(); 0");
  await pause(150);
  fs.writeFileSync(path.join(output, 'settings.png'), (await renderer.capturePage()).toPNG());
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'Settings fits minimum width');
  await home();
  assert.equal(await run('document.documentElement.dataset.homeTheme'), 'seaside');
  assert.equal(await run('document.documentElement.dataset.borders'), 'stitched');
  assert.equal(await run("getComputedStyle(document.querySelector('.hero')).borderRadius"), '14px');
  assert.match(await run("getComputedStyle(document.getElementById('hub')).backgroundSize"), /contain/);
  assert.equal(win.contentView.children[0].webContents.id, clientId, 'appearance never reloads the client');

  // Restore approved defaults and check every palette with live native light/dark changes.
  for (const [key, value] of Object.entries(options.defaults)) await save(key, value);
  await home();
  const contrast = await run(`(() => {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
    const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>{let x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    let minimum=100,worst='';
    function check(label,text,fill){
      const fg=rgba(text),bg=rgba(fill),alpha=bg[3]/255;
      if(alpha<.79||alpha>.81)throw Error('Panel fill alpha '+label);
      for(const extreme of [0,255]){
        const combined=bg.slice(0,3).map(v=>v*alpha+extreme*(1-alpha));const contrast=ratio(fg,combined);
        if(contrast<minimum){minimum=contrast;worst=label;}
        if(contrast<4.5)throw Error(label+' contrast '+contrast);
      }
    }
    for(const palette of Object.keys(window.HomeAppearanceOptions.palettes))for(const appearance of ['light','dark']){
      window.HomeAppearance.apply({ homePalette: palette }, appearance);const label=palette+' '+appearance;
      const windowStyle=getComputedStyle(document.querySelector('.hub-news'));
      for(const selector of ['.post-title','.post-text','.post-meta','.friends-note','.room-row-title']){
        const node=document.querySelector(selector);const style=getComputedStyle(node);
        if(style.opacity!=='1'||windowStyle.opacity!=='1')throw Error('Faded text');
        check(label+' '+selector,style.color,windowStyle.backgroundColor);
      }
      for(const selector of ['.daily-compact','.hub-tile:nth-child(1)','.hub-tile:nth-child(2)','.hub-tile:nth-child(3)']){
        const style=getComputedStyle(document.querySelector(selector));check(label+' '+selector,style.color,style.backgroundColor);
      }
      const hero=getComputedStyle(document.querySelector('.hero'));
      const stops=hero.backgroundImage.match(/color\\(srgb[^)]*\\)/g);if(stops?.length!==2)throw Error('Gradient stops');
      for(const stop of stops)check(label+' hero',getComputedStyle(document.getElementById('hero-sub')).color,stop);
      for(const selector of ['.hero .select','.window-head'])if(rgba(getComputedStyle(document.querySelector(selector)).backgroundColor)[3]!==255)throw Error('Control/header transparency');
      for(const button of document.querySelectorAll('.btn-primary'))if(button.getClientRects().length && getComputedStyle(button).opacity!=='1')throw Error('Faded button');
    }

return { minimum, worst }; })()`);
  console.log('Checked text contrast:', contrast);
  for (const palette of Object.keys(options.palettes)) {
    await save('homePalette', palette);
    await home();
    for (const theme of ['light', 'dark']) {
      await run('window.desktop.setTheme(' + JSON.stringify(theme) + ')');
      await until(() => run('document.documentElement.style.colorScheme === ' + JSON.stringify(theme)), 'native theme follows');
      assert.equal(await run("document.documentElement.style.getPropertyValue('--bg-app')"), options.palettes[palette][theme][0]);
    }
  }
  await save('homePalette', 'hearth');
  for (const layout of ['classic', 'modern']) {
    await save('homeLayout', layout);
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      win.setSize(width, height);
      for (const theme of ['light', 'dark']) {
        await run('window.desktop.setTheme(' + JSON.stringify(theme) + ')');
        await home();
        const geometry = await run(`(() => {
          const hub=document.getElementById('hub'), daily=document.querySelector('.daily-compact').getBoundingClientRect(), hero=document.querySelector('.hero').getBoundingClientRect();
          return { overflow: hub.scrollWidth > hub.clientWidth || document.documentElement.scrollWidth > innerWidth,
            top: daily.top-hub.getBoundingClientRect().top, below: hero.top-daily.bottom,
            fits: document.querySelector('.topbar-actions').getBoundingClientRect().right <= innerWidth };
        })()`);
        assert.equal(geometry.overflow, false, layout + ' no overflow');
        assert.equal(geometry.fits, true, 'top bar fits');
        assert.ok(Math.abs(geometry.top - 20) < 1 && Math.abs(geometry.below - 20) < 1, 'daily gaps stay compact');
        await run("document.querySelector('#news .post-toggle').click(); 0");
        assert.equal(await run("getComputedStyle(document.querySelector('#news .post-text')).display"), 'none', 'expanded news hides repeated summary');
        assert.equal(await run("document.querySelector('#news .post-body').hidden"), false);
        await run("document.querySelector('#news .post-toggle').click(); 0");
        await pause(150);
        fs.writeFileSync(path.join(output, layout + '-' + width + '-' + theme + '.png'), (await renderer.capturePage()).toPNG());
      }
    }
  }
  await save('homeLayout', 'classic');
  await run("window.desktop.setTheme('light')");
  win.setSize(1440, 900);
  for (const [background, info] of Object.entries(options.backgrounds)) {
    await save('homeBackground', background);
    await home();
    assert.equal(await run('document.documentElement.dataset.backgroundState'), 'ready', background + ' decoded');
    assert.match(await run("getComputedStyle(document.getElementById('hub')).backgroundImage"), new RegExp('client-bg-' + background));
    assert.match(await run("document.getElementById('background-credit').textContent"), new RegExp(info.artist));
    assert.match(await run("getComputedStyle(document.getElementById('hub')).backgroundSize"), /cover/);
    if (liveArt) {
      await pause(250);
      fs.writeFileSync(path.join(output, 'background-' + background + '.png'), (await renderer.capturePage()).toPNG());
    }
  }
  offline = true;
  await save('homeBackground', 'ocean');
  await home();
  assert.equal(await run('document.documentElement.dataset.backgroundState'), 'unavailable');
  assert.equal(await run("getComputedStyle(document.querySelector('.hub-news')).backgroundColor"), 'rgb(247, 250, 247)', 'offline panels are solid');
  assert.equal(await run("document.getElementById('battle').disabled"), false, 'failed artwork never blocks Home');
  await save('homeBackground', 'none');
  const before = requests.length;
  await home();
  assert.equal(requests.length, before, 'plain color makes no artwork requests');
  assert.equal(await run('document.documentElement.dataset.backgroundState'), 'plain');

  // Cold Home keeps its controls in place while the session, formats and ratings arrive separately.
  await save('homePalette', 'twilight');
  const geometry = () => run(`Object.fromEntries(['.hero','#hero-format','#format','#team','#team-grid','.hero-actions','#hero-stats','.hub-tiles','.hero-links','.hub-news','.hub-rooms','.hub-friends'].map(s => {
    const r=document.querySelector(s).getBoundingClientRect();return [s,[r.x,r.y,r.width,r.height]];
  }))`);
  const sameLayout = (before, after, label) => {
    for (const selector of Object.keys(before)) for (let i=0;i<4;i++) {
      assert.ok(Math.abs(before[selector][i]-after[selector][i]) < 1, `${label}: ${selector} moved (${before[selector]} -> ${after[selector]})`);
    }
  };
  for (const layout of ['classic', 'modern']) for (const [width,height] of [[1366,768],[1024,640]]) for (const theme of ['light','dark']) {
    await save('homeLayout', layout);
    await run(`window.desktop.setTheme('${theme}');localStorage.removeItem('hub.format'); 0`);
    win.setSize(width,height);
    snapshotReady = false;
    current.ready = current.connected = false;
    snapshot.user.registered = false;
    snapshot.stats = {};
    snapshot.currentFormat = 'gen9ou';
    await load('index.html');
    await run('window.HomeAppearance.loaded.then(() => true)');
    await until(() => run(`document.getElementById('hub').classList.contains('hub--${layout}')`), 'initial layout');
    assert.equal(await run('document.getElementById("format").value'), 'gen9randombattle');
    assert.equal(await run('document.getElementById("hero-format").textContent'), '[Gen 9] Random Battle');
    assert.equal(await run('document.querySelectorAll("#team-grid .hero-team-slot").length'), 6);
    assert.equal(await run('document.getElementById("team").selectedOptions[0].textContent'), 'Team is provided');
    const before = await geometry();
    if (width === 1366) fs.writeFileSync(path.join(output, `startup-${layout}-${theme}-connecting.png`), (await renderer.capturePage()).toPNG());
    await run('refresh()');
    sameLayout(before, await geometry(), 'still connecting');
    // A connected session alone must not enable the placeholder format.
    current.ready = current.connected = true;
    await run('window.showdownNav.pollNow()');
    assert.equal(await run('document.getElementById("battle").disabled'), true);
    assert.equal(await run('document.getElementById("format").disabled'), true);
    snapshotReady = true;
    await run('refresh()');
    assert.equal(await run('document.getElementById("format").value'), 'gen9randombattle', 'default does not follow the client OU menu');
    assert.equal(await run('document.getElementById("battle").disabled'), false);
    sameLayout(before, await geometry(), `${layout} ${width} ${theme} guest connected`);
    snapshot.user.registered = true;
    await run('refresh()');
    sameLayout(before, await geometry(), 'signed in without ratings');
    snapshot.stats = { gen9randombattle: { elo: 1500, wins: 12, losses: 8, gxe: 65 } };
    await run('refresh()');
    assert.equal(await run('document.getElementById("hero-record").hidden'), false);
    sameLayout(before, await geometry(), 'ratings arrived');
    if (width === 1366) fs.writeFileSync(path.join(output, `startup-${layout}-${theme}-connected.png`), (await renderer.capturePage()).toPNG());
  }
  // Real selections and team choices survive a disconnect and a later return to Home.
  snapshot.teams = [{ index: 2, name: 'My OU team', format: 'gen9ou', sprites: [] }];
  await run('refresh()');
  await run("document.getElementById('format').value='gen9ou';document.getElementById('format').dispatchEvent(new Event('change')); 0");
  assert.equal(await run('document.getElementById("team").disabled'), false);
  current.connected = false;
  await run('window.showdownNav.pollNow()');
  assert.equal(await run('document.getElementById("team").disabled'), true);
  assert.equal(await run('document.getElementById("format").disabled'), true);
  current.connected = true;
  await run('window.showdownNav.pollNow()');
  assert.equal(await run('document.getElementById("team").disabled'), false);
  assert.equal(await run('document.getElementById("team").value'), '2');
  await home();
  assert.equal(await run('document.getElementById("format").value'), 'gen9ou', 'saved choice still restored');
  assert.deepEqual(errors, []);
  console.log('PASS Home appearance: real settings persistence, six palettes, five backgrounds, both themes/layouts/sizes, news, client preservation, offline fallback, stable connecting/guest/rated layout and reconnect selections.' + (liveArt ? ' Live artwork decoded.' : ' All network isolated.'));
  win.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
