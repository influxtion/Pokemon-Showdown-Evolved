'use strict';

// Ordered tokens: background, paper, subtle, ink, muted, line, rail, hero,
// hero end, accent, yellow, daily, news, rooms, friends, coral.
const HOME_PALETTES = {
  hearth: { name: 'Hearth', light: ['#f2e9dc','#fffaf1','#f5eddf','#36464a','#65716b','#cabdab','#344e57','#42676b','#34525b','#376c74','#f1ca70','#f5dfbd','#dbe7df','#e2ead1','#f1dcd5','#b76d51'], dark: ['#263b43','#344c53','#2e444b','#f5eee1','#c3ccbe','#66796f','#253b46','#3c626a','#304f5c','#acd9cc','#edc777','#5b4b3e','#415b5b','#485d4b','#5e4b4c','#c88965'] },
  garden: { name: 'Garden', light: ['#e9eddd','#fcfbef','#f0f1df','#374c3d','#667461','#b9c7ac','#3d5a48','#557459','#3f6251','#477653','#e7c96f','#f2e3b8','#dce6c9','#d3e3d3','#f0dfcc','#ad7553'], dark: ['#293d35','#354d40','#304639','#eff1dc','#c1ccb6','#627d61','#263d33','#496650','#345441','#b6d99f','#dfc678','#58533a','#4a5f43','#3d5e4d','#5c5144','#c08b63'] },
  seaside: { name: 'Seaside', light: ['#e7efea','#f9fcf5','#edf4e9','#294c53','#57777b','#acc9c7','#2a5863','#397b80','#316574','#23788a','#f2d27d','#f7e1c3','#d7e8ec','#dcebd9','#f3ddd6','#c37d62'], dark: ['#203c49','#2c4e59','#264752','#eaf4e8','#b2d0ce','#56818a','#1c3546','#326d78','#285568','#8fdae0','#efcd7c','#63513d','#3b6274','#3f6559','#684f4d','#d1946e'] },
  rosewood: { name: 'Rosewood', light: ['#f1e4dc','#fff9f1','#f6eae3','#513f3b','#7b635a','#cdb1a4','#694b47','#8d6256','#754e4d','#8a5347','#efcd86','#f4dfbd','#e8d4c8','#dfe6d1','#f0d3ca','#a9634d'], dark: ['#422f33','#553e40','#4c3638','#f8eadd','#d6bbaf','#8d6c63','#352b33','#7b5150','#603e45','#edb89e','#e8c487','#66523c','#68504c','#505c47','#704c4b','#cb8a65'] },
  amber: { name: 'Amber', light: ['#f3ead6','#fffbee','#f7efd9','#4c4834','#777057','#cbbd93','#565a43','#71764e','#535e43','#627747','#efc264','#f2dda4','#e9e4c5','#dde7c8','#f0dec4','#b97543'], dark: ['#353d35','#465044','#3b463c','#f5efda','#c8cdb4','#7b8565','#2e3b34','#616d4c','#485b44','#c4d79a','#edc66c','#62583b','#555e44','#485f48','#635842','#cb9257'] },
  twilight: { name: 'Twilight', light: ['#e6eaf3','#f8f9ff','#eef1f8','#35445b','#63718a','#b8c5d9','#334965','#47658a','#3b5376','#436e9f','#eac97d','#f1dfc4','#dce6f3','#dce8e2','#eadce2','#b67966'], dark: ['#25334e','#30415c','#2a3b54','#edf1f7','#becbe0','#596e8e','#202f49','#3e5b7d','#304865','#a8cbef','#eaca7e','#5a4d45','#3d5675','#3e5a5b','#584a5e','#c48e75'] },
};

const homeStudy = { palette: 'hearth', appearance: 'light', borders: 'inset', radius: 10, texture: true, layout: 'classic', spacing: 'relaxed' };
function applyHomeStudy(next = {}) {
  Object.assign(homeStudy, next);
  const p = HOME_PALETTES[homeStudy.palette] || HOME_PALETTES.hearth;
  const dark = homeStudy.appearance === 'dark';
  const [bg,paper,subtle,ink,muted,line,rail,hero,heroEnd,accent,yellow,daily,news,rooms,friends,coral] = p[dark ? 'dark' : 'light'];
  const tokens = {
    'bg-app':bg, 'bg-panel':paper, 'bg-raised':paper, 'bg-hover':subtle, 'bg-input':paper, 'bg-selected':news, 'bg-subtle':subtle, 'client-bg':bg,
    'text':ink, 'text-2':muted, 'text-3':muted, 'border':line, 'border-strong':line, 'border-hover':accent, 'accent':accent, 'on-accent':paper,
    'primary':yellow, 'primary-hover':`color-mix(in srgb, ${yellow} 82%, white)`, 'primary-active':yellow, 'on-primary':'#3c3c2d',
    'rail-bg':rail, 'rail-border':rail, 'rail-selected':`color-mix(in srgb, ${rail} 85%, #172937)`, 'rail-hover':hero,
    'rail-text':'#dfebe0', 'rail-text-strong':'#fff9ec', 'rail-muted':'#b6c8c4', 'rail-indicator':yellow,
    'strip-bg':rail, 'tab-hover':hero, 'tab-border':hero, 'topbar-bg':paper, 'topbar-border':line,
    'hero-bg':hero, 'hero-border':`color-mix(in srgb, ${hero} 65%, ${yellow})`, 'hero-text':'#fff8e9', 'hero-muted':'#fff8e9',
    'hero-input':`color-mix(in srgb, ${heroEnd} 90%, #243641)`, 'hero-input-border':`color-mix(in srgb, ${hero} 60%, #f5edcf)`, 'hero-team-bg':`color-mix(in srgb, ${hero} 82%, #e6d9ac)`,
    'study-hero-end':heroEnd, 'study-daily':daily, 'study-news':news, 'study-rooms':rooms, 'study-friends':friends, 'study-coral':coral,
    'study-highlight':dark ? '#fff6dc1c' : '#ffffff9c', 'study-shadow':dark ? '#081e2928' : '#6b573a18',
    'ok':dark ? '#a9d6ab' : '#3e7956', 'ok-bg':rooms,
  };
  for (const [key,value] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${key}`, value);
  document.documentElement.style.colorScheme = homeStudy.appearance;
  document.documentElement.style.setProperty('--study-radius', `${homeStudy.radius}px`);
  document.documentElement.style.setProperty('--radius', `${Math.max(3, homeStudy.radius - 4)}px`);
  document.documentElement.dataset.homeTheme = homeStudy.palette;
  document.documentElement.dataset.borders = homeStudy.borders;
  document.documentElement.dataset.texture = String(homeStudy.texture);
  document.documentElement.dataset.spacing = homeStudy.spacing;
  document.querySelector('#hub').className = `hub hub--${homeStudy.layout}`;
  return { ...homeStudy };
}

function setupHomePreview() {
  const $ = id => document.getElementById(id);
  $('account').className = 'preview-status';
  $('account').textContent = 'Appearance preview · sample data';
  $('hero-format').textContent = '[Gen 9] Random Battle';
  $('hero-sub').textContent = 'Playing as a guest. Sign in on Showdown to keep a ladder rating.';
  $('format').innerHTML = '<option value="random">[Gen 9] Random Battle</option><option value="ou">[Gen 9] OU</option>';
  $('format').disabled = false;
  $('team').innerHTML = '<option>Team is provided</option>';
  $('team-name').textContent = 'Team is provided';
  $('team-grid').innerHTML = Array.from({length:6}, () => '<span class="hero-team-slot">?</span>').join('');
  for (const id of ['battle','daily-start','challenge-toggle']) $(id).disabled = false;
  $('daily-status').textContent = '3 of 3 attempts remaining';
  $('daily-streak-text').textContent = 'Start a streak';
  $('hero-stats').textContent = '';
  document.querySelector('.rail-user').hidden = false;
  document.querySelector('[data-nav="avatar"]').textContent = 'G';
  document.querySelector('[data-nav="me"]').textContent = 'Guest';
  document.querySelector('[data-nav="sign-in"]').hidden = false;
  document.querySelector('[data-nav="rooms"]').innerHTML = '<div class="nav-item nav-page" aria-current="page"><button class="nav-room-main" type="button">Home</button></div><div class="nav-item nav-tab"><button class="nav-room-main" type="button">Main menu</button></div><div class="nav-item nav-tab"><button class="nav-room-main" type="button">Lobby</button></div>';
  // Sample content is clearly identified in the chrome, with existing component markup.
  const posts = [
    ['Daily Foul Play','Medium · Gen 9 Random','Three attempts per UTC day against Foul Play. Win once to clear the daily challenge.'],
    ['Showdex in practice','Showdex','Damage calculations and matchup information alongside your practice battles.'],
    ['Replay notes','Pokemon Showdown Evolved','Save useful notes from your battles and open the replay to review them.'],
  ];
  $('news').innerHTML = posts.map(([title,meta,text], i) => `<article class="post"><button class="post-toggle" type="button" aria-expanded="false" aria-controls="sample-post-${i}"><span class="post-title">${title}</span><span class="post-meta">${meta}</span><span class="post-text">${text}</span></button><div class="post-body" id="sample-post-${i}" hidden><p>${text}</p></div></article>`).join('');
  $('rooms').innerHTML = ['Lobby','OverUsed','Random Battles','Tournaments','Help'].map(title => `<a class="room-row" href="#"><span class="room-row-head"><span class="room-row-title">${title}</span></span></a>`).join('');
  $('friends').innerHTML = '<div class="friends-note"><p>Sign in to Showdown to see your friends and who is online.</p><button class="btn btn-primary" type="button">Sign in</button></div>';
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove();
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); }
    const post = event.target.closest('.post-toggle');
    if (post) { const expanded = post.getAttribute('aria-expanded') === 'true'; post.setAttribute('aria-expanded', String(!expanded)); $(post.getAttribute('aria-controls')).hidden = expanded; }
  });
  $('format').addEventListener('change', () => {
    const random = $('format').value === 'random';
    $('hero-format').textContent = random ? '[Gen 9] Random Battle' : '[Gen 9] OU';
    $('team').innerHTML = `<option>${random ? 'Team is provided' : 'Choose a team'}</option>`;
    $('team-name').textContent = random ? 'Team is provided' : 'Choose a team';
    $('team').disabled = random;
  });
  $('battle').addEventListener('click', () => { document.querySelector('.hero').classList.add('is-searching'); document.querySelector('.battle-label').textContent = 'Searching'; $('hero-kicker').textContent = 'Searching for an opponent'; $('cancel-search').hidden = false; $('challenge-toggle').hidden = true; $('battle').disabled = true; });
  $('cancel-search').addEventListener('click', () => { document.querySelector('.hero').classList.remove('is-searching'); document.querySelector('.battle-label').textContent = 'Battle!'; $('hero-kicker').textContent = 'Ready to battle'; $('cancel-search').hidden = true; $('challenge-toggle').hidden = false; $('battle').disabled = false; });
  $('challenge-toggle').addEventListener('click', () => { $('challenge-form').hidden = !$('challenge-form').hidden; });
  $('challenge-cancel').addEventListener('click', () => { $('challenge-form').hidden = true; });
  $('challenge-form').addEventListener('submit', event => event.preventDefault());
  applyHomeStudy();
}
setupHomePreview();
