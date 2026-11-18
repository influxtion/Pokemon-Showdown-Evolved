'use strict';

// Teams for practice formats where the player brings both sides (OU), checked with the practice
// simulator's own team code, so a passing team is one the battle accepts. Nothing is kept or logged.

const path = require('node:path');
const { MAX_TEAM } = require('../api/protocol');

const FORMATS = Object.freeze({ gen9ou: 'OU' });
const MAX_PASTE = MAX_TEAM;

class PracticeTeams {
  // `load` returns the simulator's sim module; tests pass a stand-in.
  constructor({ root, load = dir => require(path.join(dir, 'server', 'dist', 'sim')) }) {
    this.root = root;
    this.load = load;
    this.sim = null;
  }

  simulator() {
    if (!this.sim) this.sim = this.load(this.root);
    return this.sim;
  }

  // Checks a team for a format. `source` is 'packed' (Teambuilder) or 'export' (pasted). Returns
  // { ok, packed, exported, species } or { ok: false, error, problems }.
  check(format, source, text) {
    if (!Object.hasOwn(FORMATS, format)) return { ok: false, error: 'This format has no teams to choose.', problems: [] };
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: source === 'export' ? 'Paste a team exported from Showdown.' : 'Choose a team.', problems: [] };
    }
    if (text.length > MAX_PASTE) return { ok: false, error: 'This team is too long to read.', problems: [] };
    let sim;
    try { sim = this.simulator(); } catch { return { ok: false, error: "Teams can't be checked: the practice battle server is missing.", problems: [] }; }
    const { Teams, TeamValidator } = sim;
    let sets;
    try {
      sets = source === 'export' ? Teams.import(text.replace(/\r\n?/g, '\n')) : Teams.unpack(text);
    } catch { sets = null; }
    if (!Array.isArray(sets) || !sets.length) {
      return { ok: false, error: source === 'export' ? "This isn't a team Showdown can read. Paste the team's export text."
        : "This team can't be read. Open it in the Teambuilder to fix it.", problems: [] };
    }
    if (sets.length > 6) return { ok: false, error: 'A team has at most six Pokémon.', problems: [] };
    let problems;
    try { problems = TeamValidator.get(format).validateTeam(sets); } catch { problems = ['The team could not be checked.']; }
    if (problems && problems.length) {
      const list = problems.slice(0, 6).map(line => String(line).slice(0, 200));
      return { ok: false, error: `Not legal in ${FORMATS[format]}: ${list[0]}`, problems: list };
    }
    const packed = Teams.pack(sets);
    if (!packed || /[\r\n]/.test(packed) || packed.length > MAX_TEAM) return { ok: false, error: 'This team is too long to read.', problems: [] };
    const exported = Teams.export(sets);
    if (exported.length > MAX_TEAM) return { ok: false, error: 'This team is too long to read.', problems: [] };
    return { ok: true, packed, exported, species: sets.map(set => String(set.species || set.name || '').slice(0, 40)) };
  }
}

module.exports = { PracticeTeams, FORMATS };
