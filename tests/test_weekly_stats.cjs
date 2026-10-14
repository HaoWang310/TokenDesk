const assert = require('node:assert/strict');
const event = { addListener() {} };
const store = { pairingCode: 'a'.repeat(64) };
global.__TOKEN_DESK_TEST__ = true;
global.chrome = {
  runtime: { onMessage: event, onInstalled: event, onStartup: event },
  storage: { local: {
    async get(defaults) { return { ...defaults, ...store }; },
    async set(value) { Object.assign(store, value); }
  } },
  tabs: { async query() { return []; }, async sendMessage() { return {}; } },
  scripting: { async executeScript() {} },
  alarms: { create() {}, onAlarm: event }
};
// Background startup probing is unrelated to local calendar-week logic.
global.fetch = async () => new Response('{}', { status: 401 });
require('../Chrome_Extension/background.js');

const { currentWeekDayKeys, weekStartKey, pruneDayMap } = global.__TOKEN_DESK_TEST_WEEK__;
assert.equal(typeof currentWeekDayKeys, 'function');
assert.equal(typeof pruneDayMap, 'function');

// Wednesday: fixed Monday-Sunday chart, never a rolling seven-day window.
assert.deepEqual(currentWeekDayKeys(new Date(2026, 9, 14, 12)), [
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15',
  '2026-10-16', '2026-10-17', '2026-10-18'
]);

// Sunday data belongs to the preceding week. Monday visibly starts from zero.
const sunday = new Date(2026, 9, 11, 12);
const monday = new Date(2026, 9, 12, 12);
assert.equal(weekStartKey(sunday), '2026-10-05');
assert.equal(weekStartKey(monday), '2026-10-12');
assert.deepEqual(pruneDayMap({
  '2026-10-11': 600, '2026-10-12': 20,
  '2026-10-13': 99, '2026-10-03': 15
}, monday), { '2026-10-12': 20 });

// Preserve existing days in the current week, but discard the prior Sunday.
assert.deepEqual(pruneDayMap({
  '2026-10-11': 320, '2026-10-12': 30, '2026-10-13': 45
}, new Date(2026, 9, 13, 12)), {
  '2026-10-12': 30, '2026-10-13': 45
});

// New-year boundary and weekends remain correctly aligned.
assert.deepEqual(currentWeekDayKeys(new Date(2027, 0, 1, 12)), [
  '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31',
  '2027-01-01', '2027-01-02', '2027-01-03'
]);
// Session coverage must be idempotent across tabs and resets on Monday.
const {mergeUsageRange,pruneSessionIntervals} = global.__TOKEN_DESK_TEST_SESSION__;
assert.deepEqual(mergeUsageRange([[1000,11000]],[1000][0],11000),[[1000,11000]]);
assert.deepEqual(mergeUsageRange([[1000,11000]],6000,16000),[[1000,16000]]);
assert.deepEqual(mergeUsageRange([[1000,11000]],11000,21000),[[1000,21000]]);
const saturday = new Date(2026,9,17,12).getTime();
const older = new Date(2026,9,11,12).getTime();
assert.deepEqual(pruneSessionIntervals({
  '2026-10-11':[[older,older+10000]],
  '2026-10-17':[[saturday,saturday+10000]]
},new Date(2026,9,17,13)),{'2026-10-17':[[saturday,saturday+10000]]});

console.log('PASS Monday-Sunday local usage reset');
