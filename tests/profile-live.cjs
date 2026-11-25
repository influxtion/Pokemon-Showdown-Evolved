'use strict';

// Real Showdown controls in a disposable guest profile; never uses the owner's account.
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, shell } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-profile-'));
const output = path.join(__dirname, '../out/profile-preferences');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  theme: 'dark', homeLayout: 'classic', startPage: 'home', showdexPrompted: true,
}));
app.whenReady().then(() => {
  session.fromPartition('persist:showdown').webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: details.resourceType === 'subFrame' });
  });
});
require('../app/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture(contents) {
  for (let attempt = 0; ; attempt++) {
    try { return (await contents.capturePage()).toPNG(); }
    catch (error) {
      if (!String(error).includes('UnknownVizError') || attempt >= 3) throw error;
      await pause(500);
    }
  }
}
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
let client;
const errors = [];
app.whenReady().then(async () => {
  shell.openExternal = async () => { throw new Error('Unexpected external navigation'); };
  const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
  // Windows needs a painted test window for theme changes and reliable captures.
  win.setOpacity(1);
  win.showInactive();
  const page = code => win.webContents.executeJavaScript(code);
  await until(() => !win.webContents.isLoading(), 'launcher');
  client = (await until(() => win.contentView.children[0], 'client')).webContents;
  const js = code => client.executeJavaScript(code);
  client.on('console-message', details => {
    if (details.level === 'error' && details.message.startsWith('Uncaught')) errors.push(details.message);
  });
  await until(() => page('window.desktop.getSession().then(s => s.ready && s.shell && s.connected)'), 'connected shell', 60000);
  assert.equal(await js('app.user.get("named")'), false);
  await until(() => page('!document.querySelector("[data-nav=account]").hidden'), 'account');
  await page('document.querySelector("[data-nav=profile]").click(); 0');
  await until(() => page('document.body.dataset.page === "play"'), 'profile navigation');
  await until(() => js('app.curRoom.id === "evolved-profile" && !!document.querySelector(".sd-profile-chat")'), 'profile room');
  await until(() => page('document.getElementById("room-title").textContent === "Profile"'), 'profile title');
  assert.equal(await js('app.popups.length'), 0, 'profile is a room, not a popup');
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click(); 0`);
  const change = (name, value) => js(`(() => {
    const input = document.querySelector('.sd-profile-options [name="' + ${JSON.stringify(name)} + '"]');
    if (input.type === 'checkbox') input.checked = ${JSON.stringify(value)};
    else input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  for (const [name, value, pref] of [
    ['inchatpm', true, 'inchatpm'], ['selfhighlight', false, 'noselfhighlight'],
    ['leavePopupRoom', true, 'leavePopupRoom'], ['noanim', true, 'noanim'],
    ['bwgfx', true, 'bwgfx'], ['nopastgens', true, 'nopastgens'],
    ['tournaments', 'nonotify', 'tournaments'],
  ]) {
    await change(name, value);
    assert.equal(await js(`Storage.prefs(${JSON.stringify(pref)})`), pref === 'noselfhighlight' ? true : value, name);
  }
  await change('timestamps-lobby', 'seconds');
  await change('timestamps-pms', 'minutes');
  assert.deepEqual(await js('Storage.prefs("timestamps")'), { lobby: 'seconds', pms: 'minutes' });
  await click('.sd-profile-options [name=formatting]');
  await until(() => js('!!document.querySelector(".ps-popup [name=spoiler]")'), 'formatting popup');
  await click('.ps-popup [name=spoiler]');
  assert.equal(await js('Storage.prefs("chatformatting").hidespoiler'), true);
  await click('.ps-popup [name=close]');
  await click('.sd-profile-options [name=sounds]');
  assert.equal(await js('app.popups.length'), 1);
  await js('app.closePopup(); 0');
  await click('.sd-profile-options [name=avatars]');
  await until(() => js('document.querySelectorAll(".avatarlist [name=setAvatar]").length > 200'), 'avatar choices');
  await click('.avatarlist [name=setAvatar][value="2"]');
  const avatar = await js('Storage.prefs("avatar")');
  assert.ok(avatar);
  await until(() => js('app.popups.length === 0'), 'avatar picker closed');
  await until(() => js(`Dex.resolveAvatar(String(app.user.get('avatar'))) === Dex.resolveAvatar(${JSON.stringify(String(avatar))})`), 'server avatar acknowledgment');
  const avatarURL = await js(`new URL(Dex.resolveAvatar(${JSON.stringify(String(avatar))}), location.href).href`);
  assert.equal(await js('document.querySelector(".sd-profile-account img").src'), avatarURL);
  await until(() => page(`document.querySelector('[data-nav=avatar] img')?.src === ${JSON.stringify(avatarURL)}`), 'rail avatar updated');
  // A userdetails reply must not discard a status draft being typed.
  await click('.sd-profile-options [name=editstatus]');
  await js('document.querySelector("[name=statustext]").focus(); document.querySelector("[name=statustext]").value="Unsent draft"; app.user.trigger("change"); 0');
  assert.equal(await js('document.querySelector("[name=statustext]").value'), 'Unsent draft');
  await js('document.querySelector("[name=inchatpm]").focus(); app.user.trigger("change"); 0');
  assert.equal(await js('document.querySelector("[name=statustext]").value'), 'Unsent draft');
  await js('app.focusRoom(""); Storage.prefs("inchatpm", false); app.focusRoom("evolved-profile"); 0');
  assert.equal(await js('document.querySelector("[name=inchatpm]").checked'), false, 'returning refreshes preferences changed elsewhere');
  assert.equal(await js('document.querySelector("[name=statustext]").value'), 'Unsent draft');
  await change('inchatpm', true);
  // Native account settings still use updateSetting; intercept only this guest test's writes.
  await js('window.profileSettingsWrites=[]; window.profileUpdateSetting=app.user.updateSetting; app.user.updateSetting=function(k,v){window.profileSettingsWrites.push([k,v]);}; 0');
  await change('language', 'english');
  for (const name of ['blockpms', 'blockchallenges']) {
    if (await js(`!!document.querySelector('[name=${name}]')`)) await change(name, true);
  }
  assert.ok((await js('window.profileSettingsWrites')).some(([key]) => key === 'language'));
  await js('app.user.updateSetting=window.profileUpdateSetting; 0');
  const geometry = [];
  for (const theme of ['light', 'dark']) {
    await page(`window.desktop.setSetting('theme', ${JSON.stringify(theme)})`);
    for (const [width, height] of [[1600, 900], [1366, 768], [1024, 640]]) {
      win.setSize(width, height);
      await pause(500);
      const bounds = await js(`(() => {
        const room = document.querySelector('.sd-profile-room');
        const cards = [...room.querySelectorAll('.sd-profile-section')].map(n => {
          const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};
        });
        return {width:innerWidth, scroll:room.scrollWidth, client:room.clientWidth, cards};
      })()`);
      assert.ok(bounds.scroll <= bounds.client + 1, 'no horizontal scrolling');
      assert.ok(bounds.cards.every(r => r.left >= 0 && r.right <= bounds.width), 'cards fit');
      const rail = await page(`(() => {
        const button = document.querySelector('[data-nav=profile]').getBoundingClientRect();
        const area = document.querySelector('.rail').getBoundingClientRect();
        return {left:button.left,right:button.right,railLeft:area.left,railRight:area.right};
      })()`);
      assert.ok(rail.left >= rail.railLeft && rail.right <= rail.railRight, 'profile button fits rail');
      geometry.push({ theme, windowWidth: width, windowHeight: height, ...bounds, rail });
      fs.writeFileSync(path.join(output, `${theme}-${width}.png`), await capture(client));
    }
  }
  fs.writeFileSync(path.join(output, 'geometry.json'), JSON.stringify(geometry, null, 2));
  await win.loadFile(path.join(__dirname, '../renderer/settings.html'));
  await until(() => page('!!document.getElementById("open-profile")'), 'settings');
  await page('document.getElementById("open-profile").click(); 0');
  await until(() => page('document.body.dataset.page === "play"'), 'Settings opens Profile');
  assert.equal(await js('Object.keys(app.rooms).filter(id=>id==="evolved-profile").length'), 1);
  // Destroy and reopen repeatedly: user listeners must not accumulate.
  const listeners = () => js('(app.user._events.change || []).length');
  await page('window.desktop.showdown("leave-room", {room:"evolved-profile"})');
  const baseListeners = await listeners();
  for (let i = 0; i < 3; i++) {
    await page('window.desktop.showdown("profile", {})');
    assert.equal(await listeners(), baseListeners + 1);
    await page('window.desktop.showdown("leave-room", {room:"evolved-profile"})');
    assert.equal(await listeners(), baseListeners);
  }
  client.reload();
  await until(() => js('!!window.app?.user && !app.isDisconnected && !!window.Storage?.prefs'), 'reload');
  await until(() => page('window.desktop.showdown("profile", {})'), 'reopen after reload');
  assert.equal(await js('Storage.prefs("inchatpm")'), true);
  assert.deepEqual(await js('Storage.prefs("timestamps")'), { lobby: 'seconds', pms: 'minutes' });
  assert.equal(await js('Storage.prefs("chatformatting").hidespoiler'), true);
  assert.equal(await js('Storage.prefs("avatar")'), avatar);
  assert.equal(await js('app.user.get("named")'), false);
  assert.deepEqual(errors, []);
  console.log('PASS Profile: account/Settings entry points, native avatar acknowledgment, preferences and reload persistence, formatting/sound popups, status draft, native server-setting handlers, room cleanup, both themes at three sizes.');
  win.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  console.error(errors);
  if (client && !client.isDestroyed()) {
    try {
      console.error(await client.executeJavaScript('({avatar:app.user.get("avatar"), savedAvatar:Storage.prefs("avatar"), avatarNumber:window.BattleAvatarNumbers?.[2], connected:!app.isDisconnected, current:app.curRoom.id})'));
      fs.writeFileSync(path.join(output, 'failure.html'), await client.executeJavaScript('document.body.outerHTML'));
      fs.writeFileSync(path.join(output, 'failure.png'), await capture(client));
    } catch {}
  }
  app.exit(1);
});
