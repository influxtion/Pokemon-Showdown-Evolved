'use strict';

// Decides when a session read deserves a Windows notification: a new incoming challenge,
// or a private message that arrived since the last read. Pure, so it can be unit tested;
// main.js shows the notifications and only while the window is in the background.

class MessageAlerts {
  constructor() {
    this.me = null;
    this.challenges = new Set();
    this.unread = new Map();
  }

  // Returns the alerts this session read adds. The first read for an account is a baseline,
  // so nothing already waiting is announced again after a reload or sign-in.
  observe(session) {
    if (!session || !session.ready || !Array.isArray(session.messages)) return [];
    const baseline = this.me !== session.me;
    this.me = session.me;
    const alerts = [];
    const challenges = new Set();
    const unread = new Map();
    for (const m of session.messages) {
      const c = m.challenge;
      if (c && c.dir === 'in') {
        const key = `${m.userid}|${c.format}`;
        challenges.add(key);
        if (!baseline && !this.challenges.has(key)) {
          alerts.push({ kind: 'challenge', user: m.userid, title: `Challenge from ${m.name}`,
            body: c.formatName ? `${c.formatName} · Accept or decline in Showdown Desktop` : 'Accept or decline in Showdown Desktop' });
        }
      }
      if (m.unread) {
        unread.set(m.userid, m.last);
        // A challenge already announces itself; its window is also marked unread.
        if (!baseline && this.unread.get(m.userid) !== m.last && !(c && c.dir === 'in' && !this.challenges.has(`${m.userid}|${c.format}`))) {
          alerts.push({ kind: 'pm', user: m.userid, title: `Message from ${m.name}`, body: m.last || 'New private message' });
        }
      }
    }
    this.challenges = challenges;
    this.unread = unread;
    return alerts;
  }
}

module.exports = { MessageAlerts };
