'use strict';

// Shared by the API server and its client so both sides validate the same shapes.

const API_VERSION = 1;
// The default format, for clients that do not name one.
const FORMAT = 'gen9randombattle';
const FORMATS = Object.freeze(['gen9randombattle', 'gen9ou']);
// Formats where the client brings the bot's team (a Showdown export, at most MAX_TEAM characters).
const TEAM_FORMATS = Object.freeze(['gen9ou']);
const MAX_TEAM = 8192;
// Search threads per computation preset. A server may cap these (MAX_THREADS).
const PRESETS = Object.freeze({ quiet: 1, balanced: 2, full: 8 });
// Every bot is Foul Play at a level (see worker/foulplay_worker.py). All play as the FoulPlay account.
const BOTS = Object.freeze({
  foulplay: Object.freeze({ id: 'foulplay', name: 'Foul Play', account: 'FoulPlay', level: 'hard', formats: FORMATS,
    description: 'Monte Carlo search over possible opposing teams.' }),
  'foulplay-medium': Object.freeze({ id: 'foulplay-medium', name: 'Foul Play Medium', account: 'FoulPlay', level: 'medium',
    formats: Object.freeze(['gen9randombattle']), description: 'Foul Play with a shorter search and a looser pick.' }),
  'foulplay-casual': Object.freeze({ id: 'foulplay-casual', name: 'Foul Play Casual', account: 'FoulPlay', level: 'casual',
    formats: Object.freeze(['gen9randombattle']), description: 'Foul Play with a short search on one guess, and the odd second-best move.' }),
});
const ROOM = /^battle-(?:gen9randombattle|gen9ou)-\d{1,16}(?:-[a-z0-9]{1,32}pw)?$/;
// The only commands a bot may send into a battle.
const CHOICE = /^(?:\/choose move [a-z0-9]{1,40}(?: terastallize)?|\/switch [1-6]|\/team [1-6]{1,6})$/;
const RQID = /^\d{1,9}$/;
const SESSION_ID = /^[a-f0-9]{64}$/;

// Server -> client socket messages.
//   ready    { bot, level, format, threads, searchMs }  the engine is loaded; frames may be sent
//   battle   { room }                          a battle started
//   thinking { room, turn }                    a decision is due
//   choice   { room, turn, choice, rqid, elapsedMs }
//   end      { room, result }                  result from the bot's side: win, loss or tie
//   error    { code, message }                 fatal; the socket closes next
// Client -> server socket messages.
//   frame    { data }                          one simulator frame for the bot's battle room
const SERVER_MESSAGES = Object.freeze(['ready', 'battle', 'thinking', 'choice', 'end', 'error']);

function roomFormat(room) {
  return ROOM.test(room) ? room.split('-')[1] : null;
}

function isBattleFrame(data, format = null) {
  if (typeof data !== 'string') return false;
  const newline = data.indexOf('\n');
  const head = newline === -1 ? data : data.slice(0, newline);
  return head.startsWith('>') && ROOM.test(head.slice(1)) && (!format || roomFormat(head.slice(1)) === format);
}

// A Showdown export the worker can read: printable text, no control characters but newlines.
function isTeamText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEAM &&
    !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.replace(/\r\n/g, '\n'));
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

module.exports = { API_VERSION, FORMAT, FORMATS, TEAM_FORMATS, MAX_TEAM, PRESETS, BOTS, ROOM, CHOICE, RQID, SESSION_ID,
  SERVER_MESSAGES, roomFormat, isBattleFrame, isTeamText, apiOrigin };
