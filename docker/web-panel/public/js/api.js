/**
 * API helper - handles token management and fetch calls
 */

const API = {
  token: localStorage.getItem('panel_token'),

  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const resp = await fetch(url, { ...options, headers });

      if (resp.status === 401) {
        // Token expired or invalid
        this.token = null;
        localStorage.removeItem('panel_token');
        window.location.href = '/login.html';
        return null;
      }

      return resp;
    } catch (err) {
      console.error('API fetch error:', err);
      throw err;
    }
  },

  async get(url) {
    const resp = await this.fetch(url);
    if (!resp) return null;
    return this.readJson(resp);
  },

  async post(url, body) {
    const resp = await this.fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!resp) return null;
    return this.readJson(resp);
  },

  async put(url, body) {
    const resp = await this.fetch(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (!resp) return null;
    return this.readJson(resp);
  },

  async del(url) {
    const resp = await this.fetch(url, {
      method: 'DELETE',
    });
    if (!resp) return null;
    return this.readJson(resp);
  },

  async readJson(resp) {
    const text = await resp.text();
    if (!text) {
      return resp.ok ? {} : { error: `HTTP ${resp.status}`, status: resp.status };
    }

    try {
      const data = JSON.parse(text);
      if (!resp.ok && !data.status) {
        data.status = resp.status;
      }
      return data;
    } catch (err) {
      return {
        error: text || `HTTP ${resp.status}`,
        status: resp.status,
        cause: resp.ok ? '' : 'The server returned a non-JSON response.',
      };
    }
  },

  getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws?token=${this.token}`;
  },
};
