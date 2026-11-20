'use strict';
process.env.SHOWDOWN_DESKTOP_BACKGROUND = '1';

// Friends pages restyle (app/client-friends.css). The real pages need a signed-in,
// autoconfirmed account, which tests never use, so each page is rebuilt here from the
// server's friends plugin markup as the client's sanitizer delivers it (<username> as a
// coloured <strong>, links with data-target="replace", <time> already localised), inside
// the same room element the client creates. The stylesheets are injected exactly as
// main.js injects them into the live client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-friends-test-'));
app.setPath('userData', profile);
const captures = path.join(__dirname, '..', 'out', 'desktop-smoke');
const css = ['client-theme.css', 'client-shell.css', 'client-friends.css']
  .map((file) => fs.readFileSync(path.join(__dirname, '..', 'app', file), 'utf8'));
css.push(require('../app/appearance').appearanceCss({ homeBackground: 'none' }, true));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGES = ['all', 'spectate', 'sent', 'received', 'help', 'settings'];
const TITLES = { all: 'All Friends', spectate: 'Spectate', sent: 'Sent', received: 'Received', help: 'Help', settings: 'Settings' };
const ICONS = { all: 'users', spectate: 'binoculars', sent: 'paper-plane', received: 'get-pocket', help: 'question-circle', settings: 'cog' };

function header(type) {
  const items = PAGES.map((page) => (page === type
    ? `<i class="fa fa-${ICONS[page]}"></i> <strong>${TITLES[page]}</strong>`
    : `<i class="fa fa-${ICONS[page]}"></i> <a data-target="replace" href="/view-friends-${page}" rel="noopener">${TITLES[page]}</a>`));
  return `<div style="line-height:25px">${items.join(' / ')}<button class="button" name="send" value="/j view-friends-${type}" style="float: right"> <i class="fa fa-refresh"></i> Refresh</button></div><hr>`;
}

const online = (name, color, status, statusColor, message) => `<div class="pad"><div><div class="infobox"><span class="username"> <strong style="color:${color}">${name}</strong></span><span><small> (<strong style="color:${statusColor}">◉ ${status}</strong>)</small></span><br>${message ? `Status: <i>${message}</i><br>` : ''}</div></div></div>`;
const offline = (name, seen) => `<div class="pad"><div><div class="infobox"><i>${name}</i> <small>(◌ Offline)</small><br>${seen ? `Last seen: <time>${seen}</time> (2 days ago)` : ''}</div></div></div>`;
const setting = (label, a, b, firstCurrent) => `<strong>${label}</strong><br><button class="button${firstCurrent ? ' disabled' : ''}" name="send" value="/x">${a}</button> <button class="button${firstCurrent ? '' : ' disabled'}" name="send" value="/y">${b}</button> <br><br>`;

const BODY = {
  all: `${header('all')}<h3>Your friends: <small> Total (5) | Online (2) | Idle (1) | Busy (1) | Offline (1)</small></h3> `
    + `<form data-submitsend="/friend add {username}">Add friend: <input class="textbox" name="username"><br><button class="button" type="submit">Add <i class="fa fa-paper-plane"></i></button></form>`
    + `<h4>Online (2)</h4>${online('Marlowe', '#3a7bd5', 'Online', '#009900', 'laddering OU')}${online('quietstorm', '#9a4ec2', 'Online', '#009900')}`
    + `<h4>Idle (1)</h4>${online('Okafor', '#2f9e8f', 'Idle', '#ff7000')}`
    + `<h4>Busy (1)</h4>${online('Venn', '#c2571a', 'Busy', '#cc3838', 'in a tournament')}`
    + `<h4>Offline (1)</h4>${offline('tidepool', 'November 14, 3:12 PM')}`,
  spectate: `${header('spectate')}<h3>Spectate your friends:</h3><i><small>Use the <a data-target="replace" href="/view-friends-settings" rel="noopener">settings page</a> to allow your friends to see your hidden battles on this page.</small></i><br><br>`
    + `<a class="blocklink" href="/battle-gen9ou-1" target="_blank" rel="noopener"><small>[Gen 9] OU</small><small style="float:right">(Rated: 1612)</small><br> <strong>Marlowe</strong> vs. Rival</a><br>`
    + `<a class="blocklink" href="/battle-gen9randombattle-2" target="_blank" rel="noopener"><small>[Gen 9] Random Battle</small><br> Someone vs. <strong>Venn</strong></a>`,
  sent: `${header('sent')}<h3>You have 1 friend request pending.</h3><br><div class="infobox"><strong>hale</strong> <button class="button" name="send" value="/friends undorequest hale"><i class="fa fa-undo"></i> Undo</button></div>`,
  received: `${header('received')}<h3>You have 2 pending friend requests.</h3>`
    + `<br><div class="infobox"><strong>okafor</strong> <button class="button" name="send" value="/friends accept okafor">Accept</button> | <button class="button" name="send" value="/friends reject okafor">Deny</button></div>`
    + `<br><div class="infobox"><strong>brightside</strong> <button class="button" name="send" value="/friends accept brightside">Accept</button> | <button class="button" name="send" value="/friends reject brightside">Deny</button></div>`,
  help: `${header('help')}<h3>Help</h3><strong>/friend OR /friends OR /friendslist:</strong><br><ul><li><code>/friend list</code> - View current friends.</li><li><code>/friend add [name]</code> OR <code>/friend [name]</code> - Send a friend request to [name], if you don't have them added.</li><li><code>/friend remove [username]</code> OR <code>/unfriend [username]</code>  - Unfriend the user.</li></ul>`,
  settings: `${header('settings')}<h3>Friends Settings:</h3>`
    + setting('Notify me when my friends come online:', 'Disable', 'Enable', false)
    + setting('Receive friend requests:', 'Disable', 'Enable', true)
    + setting('Allow others to see your list:', 'Allow', 'Hide', false)
    + setting('Allow others to see my login times', 'Disable', 'Enable', true)
    + setting('Block PMs except from friends (and staff):', 'Disable', 'Enable', true),
  empty: `${header('all')}<h3>Your friends: </h3><em>You currently have no friends added on Showdown.</em><br><br><br><strong>To add a friend, use </strong><code>/friend add [username]</code>.<br><br>`,
};

function page(id, body) {
  return `<!doctype html><html class="sd-launcher-shell"><head><meta charset="utf-8"><style>
    body { margin: 0; }
    .ps-room { position: absolute; inset: 0; overflow: auto; }
  </style></head><body><div class="ps-room ps-room-light scrollable" id="room-view-friends-${id}"><div class="pad">${body}</div></div></body></html>`;
}

async function until(check, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const run = (code) => win.webContents.executeJavaScript(code);
  const fixture = path.join(profile, 'friends.html');
  fs.mkdirSync(captures, { recursive: true });
  async function show(id, body = BODY[id]) {
    fs.writeFileSync(fixture, page(id === 'empty' ? 'all' : id, body));
    await win.loadFile(fixture);
    for (const sheet of css) await win.webContents.insertCSS(sheet, { cssOrigin: 'user' });
    await until(() => run("getComputedStyle(document.querySelector('.ps-room > .pad')).maxWidth === '880px'"), `${id} styled`);
  }
  const rect = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`);
  const style = (selector, prop) => run(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`);
  const accent = { light: 'rgb(67, 110, 159)', dark: 'rgb(168, 203, 239)' };

  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    for (const [width, height] of [[1280, 800], [940, 640]]) {
      win.setContentSize(width, height);
      for (const id of [...PAGES, 'empty']) {
        await show(id);
        assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, `${id} ${width} horizontal overflow`);

        // Tab bar: one row of labels, separators and icons gone, the open page underlined.
        const bar = '.ps-room > .pad > div[style*="line-height"]';
        const labels = await run(`[...document.querySelectorAll('${bar} > a, ${bar} > strong')].map((n) => { const r = n.getBoundingClientRect(); return [n.textContent, Math.round(r.top)]; })`);
        assert.deepEqual(labels.map(([text]) => text), Object.values(TITLES), `${id} tab labels`);
        assert.equal(new Set(labels.map(([, top]) => top)).size, 1, `${id} tabs on one row`);
        assert.equal(await style(`${bar} > .fa`, 'display'), 'none');
        assert.equal(await style(bar, 'fontSize'), '0px', `${id} separators hidden`);
        assert.equal(await style(`${bar} > strong`, 'borderBottomColor'), accent[theme], `${id} open tab marked`);
        assert.equal(await style('.ps-room > .pad > hr', 'display'), 'none');
        const refresh = await rect(`${bar} > .button`);
        const barBox = await rect(bar);
        assert.ok(barBox.right - refresh.right < 2, `${id} Refresh at the right`);

        if (id === 'all') {
          // Cards share rows of a grid; the add form and headings span it.
          const cards = await run("[...document.querySelectorAll('.ps-room > .pad > .pad')].map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.width)]; })");
          assert.equal(cards[0][0], cards[1][0], 'two online friends share a row');
          const form = await rect('form[data-submitsend]');
          const input = await rect('form[data-submitsend] .textbox');
          const add = await rect('form[data-submitsend] .button');
          assert.ok(Math.abs(input.top - add.top) < 4, 'Add sits beside the field');
          assert.ok(form.width > cards[0][1], 'the add form spans the grid');
          assert.equal(await style('form[data-submitsend] .button', 'backgroundColor'), accent[theme]);
          // Server pages give the field no type; native painting would hide the themed box.
          assert.equal(await style('form[data-submitsend] .textbox', 'appearance'), 'none', 'add field drawn by the theme');
          // Status chips in the app's colours; brackets and offline labels gone.
          assert.equal(await style('.infobox small', 'fontSize'), '0px');
          assert.notEqual(await style('.infobox strong[style*="#009900"]', 'color'), 'rgb(0, 153, 0)');
          assert.equal(await style('.infobox > small', 'display'), 'none');
        }
        if (id === 'received') {
          const name = await rect('.ps-room > .pad > .infobox > strong');
          const accept = await rect('.ps-room > .pad > .infobox > .button[value^="/friends accept"]');
          const deny = await rect('.ps-room > .pad > .infobox > .button[value^="/friends reject"]');
          assert.ok(Math.abs(name.top - accept.top) < 8 && Math.abs(accept.top - deny.top) < 1, 'name, Accept and Deny on one row');
          assert.equal(await style('.ps-room > .pad > .infobox', 'fontSize'), '0px', 'the | separator is hidden');
          assert.equal(await style('.ps-room > .pad > .infobox > .button[value^="/friends accept"]', 'backgroundColor'), accent[theme]);
        }
        if (id === 'settings') {
          // Each label shares a row with its two choices; the current one is filled.
          const rows = await run(`[...document.querySelectorAll('.ps-room > .pad > strong')].map((label) => {
            const a = label.nextElementSibling.nextElementSibling;
            const b = a.nextElementSibling;
            const mid = (n) => { const r = n.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
            return [mid(label), mid(a), mid(b), a.classList.contains('disabled'), getComputedStyle(a).backgroundColor, getComputedStyle(b).backgroundColor];
          })`);
          assert.equal(rows.length, 5);
          for (const [label, a, b, firstCurrent, aBg, bBg] of rows) {
            assert.ok(Math.abs(label - a) <= 2 && Math.abs(a - b) <= 1, 'label and choices on one row');
            assert.equal(firstCurrent ? aBg : bBg, accent[theme], 'current choice filled');
            assert.notEqual(firstCurrent ? bBg : aBg, accent[theme], 'other choice not filled');
          }
        }
        fs.writeFileSync(path.join(captures, `friends-${id}-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('PASS friends desktop: all six friends pages and the empty list restyled in both themes and two widths; tab bar, cards, add form, request rows, settings segmented choices');
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
