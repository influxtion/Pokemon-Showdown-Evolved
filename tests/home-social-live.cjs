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
          avatar:'misty',rooms:id==='offlinefriend'?false:{},status:id==='unsafeuser'?'<img src=x onerror=alert(1)>':'Ready to chat'}),30);
      }
    };
    app.user.set({name:'HomeTester',userid:'hometester',named:true}); 0`);
  await page('window.showdownNav.pollNow()');
  const search = async name => {
    await page(`if(document.getElementById('challenge-form').hidden) document.getElementById('challenge-toggle').click();
      document.getElementById('challenge-user').value=${JSON.stringify(name)};
      document.getElementById('challenge-form').requestSubmit(); 0`);
    await until(() => page('!document.getElementById("user-profile-message").disabled'), 'user found');
  };
  await search('offlinefriend');
  assert.equal(await page('document.getElementById("user-profile-challenge").disabled'), true);
  assert.match(await page('document.getElementById("user-profile-status").textContent'), /Offline or not found/);
  await search('unsafeuser');
  assert.equal(await page('document.getElementById("user-profile-status").querySelector("img")'), null);
  assert.match(await page('document.getElementById("user-profile-status").textContent'), /<img/);
  await page("document.getElementById('challenge-user').value='slowfriend';document.getElementById('challenge-form').requestSubmit();document.getElementById('user-profile-close').click();0");
  await js("app.trigger('response:userdetails',{userid:'slowfriend',name:'Slow Friend',rooms:{}});0");
  await pause(150);
  assert.equal(await page('document.getElementById("user-profile").open'), false, 'late lookup cannot reopen popup');
  const geometry = () => page(`JSON.stringify({height:document.getElementById('hub').scrollHeight,scroll:document.getElementById('hub').scrollTop,friends:document.querySelector('.hub-friends').getBoundingClientRect().toJSON()})`);
  const input = id => `.pm-window-${id} textarea[name=message]`;
  const open = async name => {
    await page(`window.homeChat.open({userid:${JSON.stringify(name.toLowerCase())},name:${JSON.stringify(name)}})`);
    await until(() => view.getVisible(), 'dock visible');
    await until(() => page('window.desktop.getSession().then(s=>s.chatDock)'), 'dock mode');
    await pause(150);
  };
  const close = async id => {
    await page('window.showdownNav.pollNow()');
    const count = await js("[...document.querySelectorAll('.pm-window[data-userid]')].filter(el=>el.style.display!=='none').length");
    const before = await page('performance.timeOrigin');
    const clientBefore = await js('performance.timeOrigin');
    const width = view.getBounds().width;
    const point = await js(`(() => {const r=document.querySelector('.pm-window-${id} > h3 .closebutton').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    const started = Date.now();
    client.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    client.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await until(() => count === 1 ? !view.getVisible() : view.getBounds().width === Math.min(width, (count-1)*320), 'close resizes or hides dock without polling', 500);
    assert.equal(await page('performance.timeOrigin'), before, 'native X keeps launcher document');
    assert.equal(await js('performance.timeOrigin'), clientBefore, 'native X keeps client document');
    console.log(`Native close ${id}: ${Date.now()-started}ms`);
    await pause(100);
  };
  await search('HomeTestFriend');
  const beforeChat = await geometry();
  await page('document.getElementById("user-profile-message").click();0');
  await until(() => view.getVisible(), 'first docked chat');
  assert.equal(await geometry(), beforeChat, 'Message leaves Home and Friends dimensions unchanged');
  assert.ok(renderer.getURL().endsWith('/index.html'));
  await js(`app.receive('|pm| HomeTestFriend| HomeTester|Hello from the test fixture');
    const input=document.querySelector('.pm-window-hometestfriend textarea[name=message]');input.value='Hello back';
    app.rooms[''].submitPM({currentTarget:input,preventDefault(){},stopPropagation(){}});0`);
  assert.ok((await js('socialSent')).some(line => line.includes('/pm hometestfriend, Hello back')));
  assert.match(await js('document.querySelector(".pm-window-hometestfriend .inner").textContent'), /Hello from the test fixture/);
  await js(`document.querySelector(${JSON.stringify(input('hometestfriend'))}).value='First draft';0`);
  await open('SecondFriend');
  const positions = await js(`['secondfriend','hometestfriend'].map(id=>document.querySelector('.pm-window-'+id).getBoundingClientRect().left)`);
  assert.ok(positions[0] < positions[1], 'new box appears left of the first');
  await js(`document.querySelector(${JSON.stringify(input('secondfriend'))}).value='Second draft';0`);
  await close('secondfriend');
  assert.equal(await js(`document.querySelector(${JSON.stringify(input('hometestfriend'))}).value`), 'First draft');
  await open('SecondFriend');
  assert.equal(await js(`document.querySelector(${JSON.stringify(input('secondfriend'))}).value`), 'Second draft', 'X preserves native draft');
  // An incoming PM opens another box without sending anything to the server.
  await js("app.receive('|pm| ThirdFriend| HomeTester|An incoming conversation');0");
  await page('window.showdownNav.pollNow()');
  await until(() => page('window.desktop.getSession().then(s=>s.messages.length===3)'), 'incoming third box');
  await js('app.isDisconnected=true;0');
  await page('window.showdownNav.pollNow()');
  await until(() => !view.getVisible(), 'disconnect hides client');
  await page('document.getElementById("hub").dispatchEvent(new Event("scroll"));0');
  assert.equal(view.getVisible(), false);
  await js('app.isDisconnected=false;0');
  await page('window.showdownNav.pollNow()');
  await until(() => view.getVisible(), 'reconnect restores dock');
  await search('HomeTestFriend');
  await until(() => !view.getVisible(), 'profile overlays chats');
  await page('document.getElementById("user-profile-close").click();0');
  await until(() => view.getVisible(), 'dismissal restores chats');
  await open('TabFriend');
  const homeDocument = await page('performance.timeOrigin');
  const nativeDocument = await js('performance.timeOrigin');
  await page('[...document.querySelectorAll(".nav-close")].find(b=>b.getAttribute("aria-label")==="Close TabFriend").click();0');
  await until(() => page('![...document.querySelectorAll(".nav-close")].some(b=>b.getAttribute("aria-label")==="Close TabFriend")'), 'Home message tab closes');
  assert.equal(await page('performance.timeOrigin'), homeDocument, 'Home tab X does not reload Home');
  assert.equal(await js('performance.timeOrigin'), nativeDocument, 'Home tab X does not reload client');
  // Full-view navigation restores the original single-conversation presentation.
  await page('window.desktop.showdown("open-pm",{user:"hometestfriend"})');
  await until(() => renderer.getURL().endsWith('/play.html') && !renderer.isLoading(), 'full chat handoff');
  assert.equal(await js('document.documentElement.classList.contains("sd-home-chat")'), false);
  assert.equal(await js(`document.querySelector(${JSON.stringify(input('hometestfriend'))}).value`), 'First draft');
  const playDocument = await page('performance.timeOrigin');
  await page('[...document.querySelectorAll(".nav-close")].find(b=>b.getAttribute("aria-label")==="Close HomeTestFriend").click();0');
  await until(() => page('document.getElementById("room-title").textContent === "SecondFriend"'), 'full-size tab selects next conversation');
  assert.equal(await page('performance.timeOrigin'), playDocument, 'switching after close reuses Play document');
  assert.equal(await js('performance.timeOrigin'), nativeDocument, 'switching after close reuses client document');
  await page('window.desktop.showdown("start-chat",{user:"HomeTestFriend"})');
  await page('window.showdownNav.pollNow()');
  for (const layout of ['classic', 'modern']) {
    await page(`window.desktop.setSetting('homeLayout',${JSON.stringify(layout)})`);
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    await until(() => page(`document.getElementById('hub').classList.contains('hub--${layout}')`), 'layout');
    await until(() => view.getVisible(), 'returning Home restores dock');
    for (const theme of ['light', 'dark']) {
      await page(`window.desktop.setSetting('theme',${JSON.stringify(theme)})`);
      for (const [width,height] of [[1600,900],[1366,768],[1024,640]]) {
        win.setSize(width,height);
        await page('document.getElementById("hub").scrollTop=0;0');
        await pause(300);
        // Opening the form is a separate user action from submitting a search.
        await page('if(document.getElementById("challenge-form").hidden) document.getElementById("challenge-toggle").click();0');
        const beforePopup = await geometry();
        await search('HomeTestFriend');
        assert.equal(await geometry(), beforePopup, 'profile popup never resizes Home');
        await until(() => page('document.getElementById("user-profile-avatar").naturalWidth>0'), 'avatar loaded');
        assert.equal(await page('document.getElementById("user-profile-avatar").src'), await js('new URL(Dex.resolveAvatar("misty"),location.href).href'));
        await capture(renderer, `${layout}-${theme}-${width}-user-popup.png`);
        renderer.sendInputEvent({type:'keyDown',keyCode:'Escape'});
        renderer.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await until(() => view.getVisible(), 'Escape restores dock');
        assert.equal(await geometry(), beforePopup);
        const bounds = view.getBounds();
        const viewport = await page('({width:innerWidth,height:innerHeight,left:document.getElementById("hub").getBoundingClientRect().left})');
        assert.ok(Math.abs(bounds.y+bounds.height-viewport.height)<=1, 'dock anchored to bottom');
        assert.ok(Math.abs(bounds.x+bounds.width-(viewport.width-16))<=1, 'dock anchored to right');
        assert.ok(bounds.x>=viewport.left && bounds.width<=viewport.width-viewport.left, 'dock stays in content viewport');
        const dock = await js(`(() => { const box=document.querySelector('.pmbox');return {scroll:box.scrollWidth,client:box.clientWidth,windows:[...box.querySelectorAll('.pm-window[data-userid]')].filter(el=>el.style.display!=='none').map(el=>{const r=el.getBoundingClientRect();const input=el.querySelector('textarea[name=message]').getBoundingClientRect();return {width:r.width,bottom:r.bottom,inputBottom:input.bottom,height:innerHeight};})};})()`);
        assert.equal(dock.windows.length,3);
        for(const chat of dock.windows) { assert.equal(chat.width,320);assert.ok(chat.inputBottom<=chat.height+1,'each message input remains reachable'); }
        if(width===1024) assert.ok(dock.scroll>dock.client, 'extra boxes scroll inside dock');
        await capture(client, `${layout}-${theme}-${width}-chat-dock.png`);
        await page('document.getElementById("hub").scrollTop=100;0');
        await pause(100);
        assert.deepEqual(view.getBounds(),bounds,'page scrolling never moves dock');
      }
    }
  }
  await close('thirdfriend');
  await close('secondfriend');
  await close('hometestfriend');
  await until(() => !view.getVisible(), 'closing last box hides dock');
  assert.equal(await page('document.getElementById("friends").hidden'),false,'Friends remains a list');
  await open('HomeTestFriend');
  assert.equal(await js(`document.querySelector(${JSON.stringify(input('hometestfriend'))}).value`),'First draft');
  await close('hometestfriend');
  await search('HomeTestFriend');
  await page('document.getElementById("user-profile-challenge").click();0');
  await until(() => renderer.getURL().endsWith('/play.html') && !renderer.isLoading(), 'challenge full view');
  assert.ok(await js('!!document.querySelector(".sd-pm-active .challenge .battleform")'), 'native challenge form');
  assert.equal((await js('socialSent')).some(line=>line.startsWith('/challenge ')), false, 'opening challenge does not send one');
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  await until(() => page('!!document.querySelector(".hero-info")'), 'Home');
  await page('document.querySelector(".hero-info").click();0');
  await until(() => page('location.pathname.endsWith("/resources.html") && document.readyState === "complete" && !!window.desktop'), 'information link');
  assert.equal(view.getVisible(), false);
  await page('window.desktop.showClient({x:100,y:100,width:300,height:300});0');
  await pause(100);
  assert.equal(view.getVisible(), false, 'late Home bounds cannot overlay the information page');
  assert.deepEqual(errors, []);
  console.log('PASS Home social: profile popup, fixed multi-chat dock, new boxes to the left, native X/draft/reopen, incoming PM, overflow, intercepted send/receive, disconnect, challenge/full view, both layouts/themes/three sizes.');
  win.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error); console.error(errors);
  if (client && !client.isDestroyed()) {
    try { console.error(await client.executeJavaScript('({room:app.curRoom.id,sent:window.socialSent})')); await capture(client,'failure-client.png'); } catch {}
  }
  app.exit(1);
});
