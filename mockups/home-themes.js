'use strict';
const HOME_PALETTES = window.HomeAppearanceOptions.palettes;
const homeStudy = { palette: window.HomeAppearanceOptions.defaults.homePalette, appearance: 'light', borders: 'inset', radius: 10, texture: true, layout: 'classic', spacing: 'relaxed', background: 'ocean', backgroundTone: 'soft', backgroundFit: 'fill' };
let homeBackgroundReady = Promise.resolve();
function applyHomeStudy(next = {}) {
  Object.assign(homeStudy, next);
  const settings = {};
  for (const key of Object.keys(window.HomeAppearanceOptions.defaults)) {
    settings[key] = homeStudy[key.slice(4, 5).toLowerCase() + key.slice(5)];
  }
  homeBackgroundReady = window.HomeAppearance.apply(settings, homeStudy.appearance);
  document.getElementById('hub').className = `hub hub--${homeStudy.layout}`;
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
    ['Showdex in practice','Showdex','Damage calculations and matchup information alongside your practice battles.','Install and enable Showdex in Settings before starting your next bot session. The calculator opens beside the battle and log.'],
    ['Replay notes','Pokemon Showdown Evolved','Save useful notes from your battles and open the replay to review them.','Paste a replay link to save it with a title and your notes. Open Review replay to watch it alongside your notes.'],
  ];
  $('news').innerHTML = posts.map(([title,meta,text,detail], i) => `<article class="post"><button class="post-toggle" type="button" aria-expanded="false" aria-controls="sample-post-${i}"><span class="post-title">${title}</span><span class="post-meta">${meta}</span><span class="post-text">${text}</span></button><div class="post-body" id="sample-post-${i}" hidden><p>${text}</p><p>${detail}</p></div></article>`).join('');
  $('rooms').innerHTML = ['Lobby','OverUsed','Random Battles','Tournaments','Help'].map(title => `<a class="room-row" href="#"><span class="room-row-head"><span class="room-row-title">${title}</span></span></a>`).join('');
  $('friends').innerHTML = '<div class="friends-note"><p>Sign in to Showdown to see your friends and who is online.</p><button class="btn btn-primary" type="button">Sign in</button></div>';
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove();
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); }
    const post = event.target.closest('.post-toggle');
    if (post) {
      const opening = post.getAttribute('aria-expanded') !== 'true';
      post.closest('.post').classList.toggle('is-open', opening);
      post.setAttribute('aria-expanded', String(opening));
      $(post.getAttribute('aria-controls')).hidden = !opening;
    }
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
