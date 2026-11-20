'use strict';
const { app, BrowserWindow, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const output = path.join(root, 'out', 'home-themes');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-home-preview-')));
let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace('href="styles.css"', `href="${pathToFileURL(path.join(root, 'renderer', 'styles.css'))}"`)
  .replace('href="home-appearance.css"', `href="${pathToFileURL(path.join(root, 'renderer', 'home-appearance.css'))}"`)
  .replace('href="app-appearance.css"', `href="${pathToFileURL(path.join(root, 'renderer', 'app-appearance.css'))}"`)
  .replace('src="assets/logo.png"', `src="${pathToFileURL(path.join(root, 'renderer', 'assets', 'logo.png'))}"`)
  .replace("default-src 'self'", "default-src 'self'; script-src 'self'")
  .replace('</body>', `<script src="${pathToFileURL(path.join(root, 'renderer', 'home-appearance-options.js'))}"></script><script src="${pathToFileURL(path.join(root, 'renderer', 'home-appearance.js'))}"></script><script src="${pathToFileURL(path.join(__dirname, 'home-themes.js'))}"></script></body>`);
fs.writeFileSync(path.join(output, 'index.html'), html);
let win;
let selection = { palette: require('../renderer/home-appearance-options').defaults.homePalette, appearance: 'light', borders: 'inset', radius: 10, texture: true, layout: 'classic', spacing: 'relaxed', background: 'ocean', backgroundTone: 'soft', backgroundFit: 'fill' };
async function change(next) {
  Object.assign(selection, next);
  await win.webContents.executeJavaScript(`applyHomeStudy(${JSON.stringify(selection)})`);
  win.setTitle(`Home appearance preview · ${selection.palette} · ${selection.appearance} · ${selection.background}`);
  setMenu();
}
function setMenu() {
  const radios = (key, entries) => entries.map(([label, value]) => ({ label, type: 'radio', checked: selection[key] === value, click: () => change({[key]: value}) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Palette', submenu: radios('palette', [['Hearth · warm cream and petrol','hearth'],['Garden · sage and honey','garden'],['Seaside · sea glass and apricot','seaside'],['Rosewood · rose and parchment','rosewood'],['Amber · olive and butter','amber'],['Twilight · blue and copper','twilight']]) },
    { label: 'Background', submenu: [
      ...radios('background', [['Plain color','none'],['Ocean','ocean'],['Horizon','horizon'],['Shaymin','shaymin'],['Charizards','charizards'],['Showdown Day','psday']]),
      {type:'separator'},
      {label:'Artwork tint',submenu:radios('backgroundTone', [['Natural','natural'],['Soft','soft'],['Muted','muted']])},
      {label:'Image framing',submenu:radios('backgroundFit', [['Fill window','fill'],['Show whole image','fit']])},
    ] },
    { label: 'Borders', submenu: radios('borders', [['Fine outline','fine'],['Soft inset','inset'],['Double frame','double'],['Stitched edge','stitched']]) },
    { label: 'Appearance', submenu: [...radios('appearance', [['Light','light'],['Dark','dark']]), {type:'separator'}, {label:'Subtle surface texture',type:'checkbox',checked:selection.texture,click:()=>change({texture:!selection.texture})}] },
    { label: 'Corners', submenu: radios('radius', [['Slight · 6 px',6],['Soft · 10 px',10],['Round · 14 px',14]]) },
    { label: 'Spacing', submenu: radios('spacing', [['Current','current'],['Relaxed','relaxed'],['Airy','airy']]) },
    { label: 'Layout', submenu: radios('layout', [['Classic · current layout','classic'],['Revamped · existing alternative','modern']]) },
    { label: 'Preview', submenu: [{label:'1440 × 900',click:()=>win.setSize(1440,900)},{label:'1366 × 768',click:()=>win.setSize(1366,768)},{label:'1024 × 640',click:()=>win.setSize(1024,640)},{type:'separator'},{role:'close'}] },
  ]));
}
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  const capture = process.argv.includes('--capture');
  win = new BrowserWindow({ width:1440, height:900, minWidth:1024, minHeight:640, show:!capture, title:'Home appearance preview', icon:path.join(root,'renderer/assets/app.ico'), webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:capture} });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  setMenu();
  await win.loadFile(path.join(output, 'index.html'));
  await change(selection);
  if (!capture) return;
  console.log('background', await win.webContents.executeJavaScript('homeBackgroundReady.then(() => document.documentElement.dataset.backgroundState)'));
  await win.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))');
  // Give the offscreen compositor a fresh frame after the wallpaper is decoded.
  win.webContents.invalidate();
  await new Promise(resolve=>setTimeout(resolve,300));
  const variants = [['hearth','light','inset'],['garden','light','double'],['seaside','light','fine'],['rosewood','light','stitched'],['amber','light','double'],['twilight','dark','inset'],['hearth','dark','stitched']];
  for (const [palette,appearance,borders] of variants) {
    await change({palette,appearance,borders});
    await new Promise(resolve=>setTimeout(resolve,150));
    const dimensions = await win.webContents.executeJavaScript(`JSON.stringify({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,hubScroll:document.getElementById('hub').scrollWidth,hubWidth:document.getElementById('hub').clientWidth,hero:document.querySelector('.hero').getBoundingClientRect().toJSON()})`);
    console.log(palette, appearance, borders, dimensions);
    fs.writeFileSync(path.join(output, `${palette}-${appearance}.png`), (await win.webContents.capturePage()).toPNG());
  }
  for (const layout of ['classic','modern']) {
    win.setSize(1024,640);
    await change({palette:'hearth',appearance:'light',borders:'double',layout});
    await new Promise(resolve=>setTimeout(resolve,150));
    console.log('minimum',layout,await win.webContents.executeJavaScript("JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,hubScroll:document.getElementById('hub').scrollWidth,hubWidth:document.getElementById('hub').clientWidth})"));
    fs.writeFileSync(path.join(output, `minimum-${layout}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log('interactions',await win.webContents.executeJavaScript(`(() => {const b=document.getElementById('battle');b.click();if(!b.disabled)throw Error('Search');document.getElementById('cancel-search').click();if(b.disabled)throw Error('Cancel');const f=document.getElementById('format');f.value='ou';f.dispatchEvent(new Event('change'));if(!document.getElementById('hero-format').textContent.includes('OU'))throw Error('Format');return 'search/cancel/format passed';})()`));
  win.destroy(); app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
