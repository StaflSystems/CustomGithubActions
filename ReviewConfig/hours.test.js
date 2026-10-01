// Run with: node --test ReviewConfig/
const test = require('node:test');
const assert = require('node:assert');
const { addBusinessHours, businessHoursBetween } = require('./hours.js');

const HOLIDAYS = { 2026: [{ date: '2026-11-26' }, { date: '2026-11-27' }] };
const at = (iso) => new Date(iso);

test('a small PR marked ready at 16:30 Friday is due at 13:30 Monday', () => {
  // 2026-10-02 is a Friday; Pacific is UTC-7 in October.
  assert.deepStrictEqual(addBusinessHours(at('2026-10-02T23:30:00Z'), 4, HOLIDAYS), at('2026-10-05T20:30:00Z'));
});

test('a standard PR is due one business day later', () => {
  // 11:00 Thursday + 7 h = 11:00 Friday.
  assert.deepStrictEqual(addBusinessHours(at('2026-10-01T18:00:00Z'), 7, HOLIDAYS), at('2026-10-02T18:00:00Z'));
});

test('holidays and weekends don\'t count', () => {
  // 15:00 Wednesday before Thanksgiving + 4 h: 2 h Wednesday, then Monday 10:00 + 2 h. PST from Nov 1.
  assert.deepStrictEqual(addBusinessHours(at('2026-11-25T23:00:00Z'), 4, HOLIDAYS), at('2026-11-30T20:00:00Z'));
  assert.strictEqual(businessHoursBetween(at('2026-11-25T23:00:00Z'), at('2026-11-30T20:00:00Z'), HOLIDAYS), 4);
});

test('time before opening and after closing doesn\'t count', () => {
  // 08:00 to 18:00 Pacific on a Thursday.
  assert.strictEqual(businessHoursBetween(at('2026-10-01T15:00:00Z'), at('2026-10-02T01:00:00Z'), HOLIDAYS), 7);
  // Ready at 07:00, due at 14:00 for a small PR.
  assert.deepStrictEqual(addBusinessHours(at('2026-10-01T14:00:00Z'), 4, HOLIDAYS), at('2026-10-01T21:00:00Z'));
});

test('a review after closing on the day it was due is no later than one first thing next morning', () => {
  const start = at('2026-10-01T23:00:00Z'); // 16:00 Thursday
  assert.strictEqual(businessHoursBetween(start, at('2026-10-02T04:00:00Z'), HOLIDAYS), 1); // 21:00
  assert.strictEqual(businessHoursBetween(start, at('2026-10-02T17:00:00Z'), HOLIDAYS), 1); // 10:00 Friday
});

test('the switch to standard time doesn\'t shift the window', () => {
  // Nov 1, 2026 is the Sunday clocks go back. Friday Oct 30 10:00 PDT to Monday Nov 2 10:00 PST.
  assert.strictEqual(businessHoursBetween(at('2026-10-30T17:00:00Z'), at('2026-11-02T18:00:00Z'), HOLIDAYS), 7);
});

test('no time, or time running backwards, is 0', () => {
  assert.strictEqual(businessHoursBetween(at('2026-10-01T20:00:00Z'), at('2026-10-01T20:00:00Z'), HOLIDAYS), 0);
  assert.strictEqual(businessHoursBetween(at('2026-10-01T20:00:00Z'), at('2026-10-01T19:00:00Z'), HOLIDAYS), 0);
});
