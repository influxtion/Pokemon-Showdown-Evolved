'use strict';

(() => {
  const query = new URLSearchParams(location.search);
  const hosted = /^\/s\/([a-f0-9]{64})\/practice-client\.html$/.exec(location.pathname);
  const port = hosted ? (location.port || (location.protocol === 'https:' ? '443' : '80')) : query.get('port') || '';
  const token = hosted ? hosted[1] : query.get('token') || '';
  const human = hosted ? 'Player' : query.get('human') || '';
  const bot = hosted ? document.documentElement.dataset.practiceBot : query.get('bot') || '';
  // OU brings the player's packed team; Random Battle has none.
  const format = hosted ? 'gen9randombattle' : query.get('format') || 'gen9randombattle';
  const team = hosted ? '' : query.get('team') || '';
  const guest = /^[a-z][a-z0-9]{2,17}$/i;
  const state = document.documentElement.dataset;
  state.practiceState = 'connecting';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^[a-f0-9]{32,128}$/.test(token) || !guest.test(human) || !guest.test(bot) ||
      human.toLowerCase() === bot.toLowerCase() || !['gen9randombattle', 'gen9ou', 'gen9anythinggoes'].includes(format) ||
      (format === 'gen9randombattle' ? team !== '' : !team || team.length > 8192 || /[\r\n]/.test(team))) {
    state.practiceState = 'failed';
    return;
  }

  const localServer = { id: 'desktop-practice', host: hosted ? location.hostname : '127.0.0.1', port: Number(port) };
  window.Config = {
    defaultserver: localServer,
    server: localServer,
    practiceSocketUrl: hosted ? `${location.origin.replace(/^http/, 'ws')}/s/${token}/websocket` : `ws://127.0.0.1:${Number(port)}/showdown/websocket?token=${token}`,
    testclient: true,
    roomsFirstOpenScript() {},
    bannedHosts: [],
    whitelist: [],
    customcolors: {},
    routes: {
      client: 'play.pokemonshowdown.com',
      root: 'pokemonshowdown.com',
      dex: 'dex.pokemonshowdown.com',
      replays: 'replay.pokemonshowdown.com',
      users: 'pokemonshowdown.com/users',
      teams: 'teams.pokemonshowdown.com',
    },
  };
  window.exports = window;

  document.addEventListener('DOMContentLoaded', () => {
    try {
      // The HTTP development service still fetches artwork over HTTPS.
      Dex.resourcePrefix = 'https://play.pokemonshowdown.com/';
      Dex.fxPrefix = 'https://play.pokemonshowdown.com/fx/';
      // Load in the same isolated local storage partition as the practice view.
      Storage.prefs('theme', 'system');
      Storage.prefs('mute', true);
      const client = new App();
      // Socket events are delivered in a later task. Install before the first
      // login/challenge can reach the server, including on a fast loopback.
      if (!hosted && location.protocol === 'file:' && format === 'gen9randombattle') {
        try { window.battleReviewCapture().install(window, human); } catch { /* Practice stays playable. */ }
      }
      const login = client.user;
      const usedRooms = new Set();
      let battle;
      let challengeDeadline = 0;
      let initialChallenge = false;
      const connectionDeadline = Date.now() + 15000;

      login.receiveChallstr = function () {
        this.loaded = true;
        client.send(`/trn ${human},0,`);
      };
      window.desktopPracticeStart = () => {
        if (client.isDisconnected || challengeDeadline || state.practiceState === 'failed' ||
            (battle && !(battle.battleEnded || battle.battle.ended)) ||
            login.get('userid') !== human.toLowerCase()) return false;
        if (battle) client.removeRoom(battle.id);
        battle = null;
        challengeDeadline = Date.now() + 15000;
        state.practiceState = 'ready';
        // A rematch sends the same team again.
        client.send(`/utm ${team || 'null'}`);
        client.send(`/challenge ${bot}, ${format}`);
        return true;
      };
      client.on('init:choosename', () => {
        if (!initialChallenge) initialChallenge = window.desktopPracticeStart();
      });

      const monitor = window.setInterval(() => {
        if (state.practiceState === 'failed') {
          clearInterval(monitor);
          return;
        }
        if (!initialChallenge) {
          if (Date.now() > connectionDeadline) state.practiceState = 'failed';
          return;
        }
        if (client.isDisconnected) {
          state.practiceState = 'failed';
          return;
        }
        if (!battle && challengeDeadline) {
          const room = Object.values(client.rooms).find(room => room.id.startsWith(`battle-${format}-`) &&
            !usedRooms.has(room.id) && room.side && room.battle);
          if (room) {
            battle = room;
            usedRooms.add(room.id);
            challengeDeadline = 0;
            client.focusRoom(room.id);
            state.practiceState = 'battle';
          } else if (Date.now() > challengeDeadline) state.practiceState = 'failed';
        }
        if (battle && (battle.battleEnded || battle.battle.ended)) state.practiceState = 'finished';
      }, 100);
    } catch (error) {
      console.error('Practice client initialization failed.', error);
      state.practiceState = 'failed';
    }
  });
})();
