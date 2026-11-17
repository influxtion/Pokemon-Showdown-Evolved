'use strict';

// Where Foul Play's moves are computed: the hosted practice inference API (api/server.js).
// The app ships only its client (api/client.js and api/protocol.js); Foul Play never runs here.

const { InferenceClient } = require('../api/client');
const { apiOrigin } = require('../api/protocol');

// The hosted practice API. Override with SHOWDOWN_PRACTICE_API_URL.
const CLOUD_API_URL = 'https://34-174-209-142.sslip.io';

class CloudEngine {
  constructor({ url = process.env.SHOWDOWN_PRACTICE_API_URL || CLOUD_API_URL, key = process.env.SHOWDOWN_PRACTICE_API_KEY || null,
    Client = InferenceClient, refreshMs = 30000, now = Date.now } = {}) {
    this.key = key;
    this.Client = Client;
    this.refreshMs = refreshMs;
    this.now = now;
    try { this.url = url ? apiOrigin(url) : null; } catch { this.url = null; this.invalid = true; }
    this.value = { configured: Boolean(this.url), checked: false, online: false, available: false, error: '' };
    this.checkedAt = 0;
  }

  status() {
    if (this.url && !this.checking && this.now() - this.checkedAt > this.refreshMs) this.refresh();
    return { ...this.value };
  }

  async refresh() {
    this.checking = true;
    try {
      const info = await new this.Client({ url: this.url, key: this.key, timeoutMs: 5000 }).info();
      const bot = info.bots?.find(value => value.id === 'foulplay');
      this.value = { configured: true, checked: true, online: true, available: Boolean(bot?.available),
        busy: Boolean(info.capacity && info.capacity.active >= info.capacity.max), presets: bot?.presets || null,
        error: bot?.available ? '' : 'Foul Play is not available on the cloud server right now.' };
    } catch (error) {
      this.value = { configured: true, checked: true, online: false, available: false, error: error.message };
    } finally {
      this.checking = false;
      this.checkedAt = this.now();
    }
  }

  async target() {
    if (!this.url) {
      throw new Error(this.invalid ? 'The cloud practice server address is invalid.'
        : 'No cloud practice server is set up in this build.');
    }
    return { url: this.url, key: this.key };
  }
}

module.exports = { CloudEngine, CLOUD_API_URL };
