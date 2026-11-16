'use strict';

// Shared by the API server and its client so both sides validate the same shapes.

const API_VERSION = 1;
const FORMAT = 'gen9randombattle';
// Search threads per computation preset. A server may cap these (MAX_THREADS).
const PRESETS = Object.freeze({ quiet: 1, balanced: 2, full: 8 });
const BOTS = Object.freeze({
  foulplay: Object.freeze({ id: 'foulplay', name: 'Foul Play', account: 'FoulPlay',
    description: 'Monte Carlo search over possible opposing teams.' }),
});
const ROOM = /^battle-gen9randombattle-\d{1,16}(?:-[a-z0-9]{1,32}pw)?$/;
// The only commands a bot may send into a battle.
const CHOICE = /^(?:\/choose move [a-z0-9]{1,40}(?: terastallize)?|\/switch [1-6])$/;
const RQID = /^\d{1,9}$/;
const SESSION_ID = /^[a-f0-9]{64}$/;

// Server -> client socket messages.
//   ready    { bot, threads, searchMs }       the engine is loaded; frames may be sent
//   battle   { room }                          a battle started
//   thinking { room, turn }                    a decision is due
//   choice   { room, turn, choice, rqid, elapsedMs }
//   end      { room, result }                  result from the bot's side: win, loss or tie
//   error    { code, message }                 fatal; the socket closes next
// Client -> server socket messages.
//   frame    { data }                          one simulator frame for the bot's battle room
const SERVER_MESSAGES = Object.freeze(['ready', 'battle', 'thinking', 'choice', 'end', 'error']);

function isBattleFrame(data) {
  if (typeof data !== 'string') return false;
  const newline = data.indexOf('\n');
  const head = newline === -1 ? data : data.slice(0, newline);
  return head.startsWith('>') && ROOM.test(head.slice(1));
}

function apiOrigin(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname) ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('The practice API needs an HTTPS address (HTTP is allowed only on this computer).');
  }
  return url.origin;
}

module.exports = { API_VERSION, FORMAT, PRESETS, BOTS, ROOM, CHOICE, RQID, SESSION_ID, SERVER_MESSAGES,
  isBattleFrame, apiOrigin };
