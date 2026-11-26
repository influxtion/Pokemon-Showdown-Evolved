'use strict';

// Official client in a disposable guest profile. All social writes are intercepted.
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'home-social-'));
const output = path.join(__dirname, '../out/home-social');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'dark', homeLayout: 'classic', startPage: 'home', showdexPrompted: true,
}));
app.whenReady().then(() => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, done) => done({ cancel: details.resourceType === 'subFrame' }));
});
require('../app/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch {}
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function capture(contents, name) {
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(path.join(output, name), (await contents.capturePage()).toPNG()); return; }
    catch (error) { if (attempt >= 3 || !String(error).includes('UnknownVizError')) throw error; await pause(400); }
  }
}
let client;
const errors = [];
app.whenReady().then(async () => {
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
  win.setOpacity(1); win.showInactive();
  const renderer = win.webContents;
  const page = code => renderer.executeJavaScript(code);
  await until(() => !renderer.isLoading(), 'launcher');
  const view = await until(() => win.contentView.children[0], 'native client');
  client = view.webContents;
  const js = code => client.executeJavaScript(code);
  for (const contents of [renderer, client]) contents.on('console-message', details => {
    if (details.level === 'error' && details.message.startsWith('Uncaught')) errors.push(details.message);
  });
  await until(() => page('window.desktop.getSession().then(s=>s.ready && s.connected && s.shell)'), 'connected guest', 60000);
  await until(() => page('!document.getElementById("challenge-toggle").disabled'), 'search available');
  const guest = await js('app.user.get("name")');
  const real = await page(`window.desktop.showdown('find-user', {user:${JSON.stringify(guest)}})`);
  assert.equal(real.ok, true);
  assert.equal(real.online, true, 'real server userdetails response');
  assert.equal(await page("window.desktop.showdown('start-chat',{user:'hometestfriend'})"), 'needs-client');
  await js('app.closePopup(); 0');
  // No messages or challenges go to the real server. Replay responses through native handlers.
  await js(`window.socialSent=[];
    app.send=function(message){
      socialSent.push(message);
      if (message.startsWith('/cmd userdetails ')) {
        const id=message.slice('/cmd userdetails '.length);
        if (id==='slowfriend') return;
        setTimeout(()=>app.trigger('response:userdetails', {userid:id,name:id==='hometestfriend'?'HomeTestFriend':id,
          rooms:id==='offlinefriend'?false:{},status:id==='unsafeuser'?'<img src=x onerror=alert(1)>':'Ready to chat'}),30);
      }
    };
    app.user.set({name:'HomeTester',userid:'hometester',named:true}); 0`);
  await page('window.showdownNav.pollNow()');
  const search = async name => {
    await page(`document.getElementById('challenge-toggle').click();
      document.getElementById('challenge-user').value=${JSON.stringify(name)};
      document.getElementById('challenge-form').requestSubmit(); 0`);
    await until(() => page('!document.getElementById("contact-chat").hidden'), 'user found');
  };
  await search('offlinefriend');
  assert.equal(await page('document.getElementById("contact-challenge").disabled'), true);
  assert.match(await page('document.getElementById("contact-status").textContent'), /Offline or not found/);
  await search('unsafeuser');
  assert.equal(await page('document.getElementById("contact-status").querySelector("img")'), null);
  assert.match(await page('document.getElementById("contact-status").textContent'), /<img/);
  await page("document.getElementById('challenge-user').value='slowfriend';document.getElementById('challenge-form').requestSubmit();document.getElementById('contact-back').click();0");
  await js("app.trigger('response:userdetails',{userid:'slowfriend',name:'Slow Friend',rooms:{}});0");
  await pause(150);
  assert.equal(await page('document.getElementById("home-contact").hidden'), true, 'late lookup cannot reopen panel');
  await search('HomeTestFriend');
  await page('document.getElementById("contact-chat").click();0');
  await until(() => view.getVisible(), 'inline chat view');
  assert.ok(renderer.getURL().endsWith('/index.html'), 'chat remains on Home');
  await until(() => js('!!document.querySelector(".sd-pm-active textarea[name=message]")'), 'native message editor');
  await js(`app.receive('|pm| HomeTestFriend| HomeTester|Hello from the test fixture');
    const input=document.querySelector('.sd-pm-active textarea[name=message]');input.value='Hello back';
    app.rooms[''].submitPM({currentTarget:input,preventDefault(){},stopPropagation(){}});0`);
  assert.ok((await js('socialSent')).some(line => line.includes('/pm hometestfriend, Hello back')), 'native PM send command');
  assert.match(await js('document.querySelector(".sd-pm-active .inner").textContent'), /Hello from the test fixture/);
  await js("document.querySelector('.sd-pm-active textarea[name=message]').value='Unsent chat draft';0");
  await page('document.getElementById("contact-back").click();0');
  await until(() => !view.getVisible(), 'back hides native view');
  await page('window.showdownNav.pollNow()');
  await until(() => page('!!document.querySelector(".home-conversation")'), 'conversation retained');
  await page('document.querySelector(".home-conversation").click();0');
  await until(() => view.getVisible(), 'reopen conversation');
  assert.equal(await js('document.querySelector(".sd-pm-active textarea[name=message]").value'), 'Unsent chat draft');
  await js('app.isDisconnected=true;0');
  await page('window.showdownNav.pollNow()');
  await until(() => !view.getVisible(), 'disconnect hides client');
  await page('document.getElementById("hub").dispatchEvent(new Event("scroll"));0');
  await pause(100);
  assert.equal(view.getVisible(), false, 'scroll cannot expose a disconnected view');
  await js('app.isDisconnected=false;0');
  await page('window.showdownNav.pollNow()');
  await until(() => view.getVisible(), 'reconnect restores conversation');
  await page('document.getElementById("contact-full").click();0');
  await until(() => renderer.getURL().endsWith('/play.html') && !renderer.isLoading() && view.getBounds().width > 650, 'full chat');
  assert.equal(await js('document.querySelector(".sd-pm-active textarea[name=message]").value'), 'Unsent chat draft');
  // Both layouts show the swapped panels, and the native editor fits its box in each theme/size.
  for (const layout of ['classic', 'modern']) {
    await page(`window.desktop.setSetting('homeLayout',${JSON.stringify(layout)})`);
    // Settings apply on reload; return to the same native conversation via Conversations.
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    await until(() => page(`document.getElementById('hub').classList.contains('hub--${layout}')`), 'layout');
    await until(() => page('!!document.querySelector(".home-conversation")'), 'saved conversation');
    for (const theme of ['light', 'dark']) {
      await page(`window.desktop.setSetting('theme',${JSON.stringify(theme)})`);
      for (const [width, height] of [[1600,900],[1366,768],[1024,640]]) {
        win.setSize(width,height);
        await page('document.getElementById("contact-back").click();document.getElementById("hub").scrollTop=0;0');
        await pause(300);
        const positions = await page(`Object.fromEntries(['rooms','friends','news'].map(k=>{const r=document.querySelector('.hub-'+k).getBoundingClientRect();return [k,{left:r.left,top:r.top,right:r.right,bottom:r.bottom}]}))`);
        assert.ok(positions.rooms.bottom <= positions.friends.top + 1 && positions.rooms.bottom <= positions.news.top + 1, 'Chat rooms above');
        assert.ok(positions.friends.right <= positions.news.left + 1, 'Friends left of News');
        assert.equal(await page('document.documentElement.scrollWidth <= innerWidth && document.getElementById("hub").scrollWidth <= document.getElementById("hub").clientWidth'), true);
        assert.equal(await page(`(() => {const i=document.querySelector('.hero-info').getBoundingClientRect();return [...document.querySelectorAll('.hero-links a')].every(a=>{const r=a.getBoundingClientRect();return !r.width || r.right<=i.left || r.left>=i.right || r.bottom<=i.top || r.top>=i.bottom;});})()`), true, 'info link does not cover shortcuts');
        await capture(renderer, `${layout}-${theme}-${width}-home.png`);
        if (layout === 'modern') {
          await page('document.querySelector(".hub-side").scrollIntoView({block:"start"});0');
          await pause(100);
          await capture(renderer, `${layout}-${theme}-${width}-panels.png`);
        }
        await page('document.querySelector(".home-conversation").click();0');
        await until(() => view.getVisible(), 'chat visible at size');
        await pause(300);
        const bounds = view.getBounds();
        const box = await page('(()=>{const r=document.getElementById("home-chat-view").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})()');
        assert.ok(bounds.x >= box.left - 1 && bounds.y >= box.top - 1 && bounds.x + bounds.width <= box.right + 1 && bounds.y + bounds.height <= box.bottom + 1, 'native view contained');
        const editor = await js('(()=>{const r=document.querySelector(".sd-pm-active textarea[name=message]").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
        assert.ok(editor.left >= 0 && editor.right <= editor.width + 1 && editor.bottom <= editor.height + 1, 'message input reachable: ' + JSON.stringify({layout,theme,width,editor,bounds}));
        await capture(client, `${layout}-${theme}-${width}-chat.png`);
      }
    }
  }
  await js('for(let i=0;i<21;i++) app.rooms[""].openPM("testother"+i,true);0');
  await pause(1100);
  await page('window.showdownNav.pollNow()');
  assert.equal(view.getVisible(), true, 'active chat survives more than twenty open conversations');
  assert.equal(await page('document.getElementById("home-contact").hidden'), false);
  await page('window.desktop.showdown("close-pm",{user:"hometestfriend"});0');
  await page('window.showdownNav.pollNow()');
  await until(() => page('document.getElementById("home-contact").hidden'), 'closing conversation returns to Friends');
  assert.ok(renderer.getURL().endsWith('/index.html'));
  await search('HomeTestFriend');
  await page('document.getElementById("contact-challenge").click();0');
  await until(() => renderer.getURL().endsWith('/play.html') && !renderer.isLoading(), 'challenge full view');
  assert.ok(await js('!!document.querySelector(".sd-pm-active .challenge .battleform")'), 'native challenge form');
  assert.equal((await js('socialSent')).some(line=>line.startsWith('/challenge ')), false, 'opening challenge does not send one');
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  await until(() => page('!!document.querySelector(".hero-info")'), 'Home');
  await page('document.querySelector(".hero-info").click();0');
  await until(() => renderer.getURL().endsWith('/resources.html') && !renderer.isLoading(), 'information link');
  assert.equal(view.getVisible(), false);
  await page('window.desktop.showClient({x:100,y:100,width:300,height:300});0');
  await pause(100);
  assert.equal(view.getVisible(), false, 'late Home bounds cannot overlay the information page');
  assert.deepEqual(errors, []);
  console.log('PASS Home social: swapped panels, live read-only user lookup, offline/unsafe/stale results, native send/receive with intercepted writes, draft/back/reopen, challenge handoff, info link, both layouts/themes/three sizes.');
  win.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error); console.error(errors);
  if (client && !client.isDestroyed()) {
    try { console.error(await client.executeJavaScript('({room:app.curRoom.id,sent:window.socialSent})')); await capture(client,'failure-client.png'); } catch {}
  }
  app.exit(1);
});
