const assert = require('assert');

let store = { pairingCode: 'a'.repeat(64) };
let ingestBody = null;
let calls = [];

global.__TOKEN_DESK_TEST__ = true;
global.chrome = {
  storage: {
    local: {
      async get(defaults){ return {...defaults, ...store}; },
      async set(changes){ Object.assign(store, changes); }
    }
  },
  runtime: {
    onMessage: { addListener(){} },
    onInstalled: { addListener(){} },
    onStartup: { addListener(){} }
  },
  alarms: {
    create(){},
    onAlarm: { addListener(){} }
  },
  tabs: {
    async query(){ return []; },
    sendMessage(){ return Promise.resolve(); }
  }
};

global.fetch = async (url, options={}) => {
  url = String(url); calls.push({url, options});
  if (url.endsWith('/backend-api/wham/usage')) {
    const auth = options.headers && (options.headers.Authorization || options.headers.authorization);
    if (!auth) return new Response('{"detail":"Unauthorized"}', {status:401, headers:{'content-type':'application/json'}});
    assert.strictEqual(auth, 'Bearer TEST_TOKEN');
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1900000000 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1900500000 }
      },
      rate_limit_reset_credits: { available_count: 3 }
    }), {status:200, headers:{'content-type':'application/json'}});
  }
  if (url.endsWith('/api/auth/session')) {
    return new Response(JSON.stringify({accessToken:'TEST_TOKEN'}), {status:200, headers:{'content-type':'application/json'}});
  }
  if (url === 'http://127.0.0.1:18743/ingest') {
    ingestBody = JSON.parse(options.body);
    return new Response('{"ok":true}', {status:200, headers:{'content-type':'application/json'}});
  }
  if (url.endsWith('/api/codex/usage')) return new Response('{}', {status:404});
  if (url === 'http://127.0.0.1:18743/health') return new Response('{"ok":true,"app":"TokenDesk"}', {status:200});
  throw new Error('unexpected fetch '+url);
};

require('../Chrome_Extension/background.js');

setTimeout(() => {
  try {
    assert.ok(ingestBody, 'background refresh should POST to Mac without any ChatGPT tab');
    assert.strictEqual(ingestBody.fiveHourRemaining, 75);
    assert.strictEqual(ingestBody.weeklyRemaining, 90);
    assert.strictEqual(ingestBody.availableResets, 3);
    assert.strictEqual(ingestBody.backgroundDirect, true);
    const serialized = JSON.stringify(ingestBody);
    assert.ok(!serialized.includes('TEST_TOKEN'), 'access token must never leave Chrome background worker');
    assert.ok(store.lastSnapshot, 'last snapshot should be stored');
    assert.strictEqual(store.lastSnapshot.mode, 'background-direct');
    console.log('background-direct test: PASS');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  }
}, 100);
