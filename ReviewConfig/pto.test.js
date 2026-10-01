// Run with: node --test ReviewConfig/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { awaySoon, outDates, nextBusinessDay, pacificDate } = require('./pto.js');

const PEOPLE = {
  alovelace: { name: 'Ada Lovelace' },
  ghopper: { name: 'Grace Hopper' },
  'kjohnson': { name: 'Katherine Johnson' },
};
const HOLIDAYS = { 2026: [{ date: '2026-11-26' }, { date: '2026-11-27' }] };

const calendar = (...events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

const sorted = (dates) => Object.fromEntries(Object.entries(dates).map(([login, set]) => [login, [...set].sort()]));

test('reads all-day entries, with DTEND the day after the last day', () => {
  const ics = calendar(
    ['DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'SUMMARY:Grace Hopper is Out of Office'],
    ['DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261008', 'SUMMARY:Ada Lovelace on Vacation'],
  );
  assert.deepStrictEqual(sorted(outDates(ics, PEOPLE)), {
    ghopper: ['2026-10-02'],
    alovelace: ['2026-10-05', '2026-10-06', '2026-10-07'],
  });
});

test('Work From Home is not out; other companies people and other events are ignored', () => {
  const ics = calendar(
    ['DTSTART;VALUE=DATE:20261001', 'SUMMARY:Ada Lovelace on Work From Home'],
    ['DTSTART;VALUE=DATE:20261002', 'SUMMARY:Katherine Johnson on work from home'],
    ['DTSTART;VALUE=DATE:20261001', "SUMMARY:Alex R's 5-year anniversary"],
    ['DTSTART;VALUE=DATE:20261001', 'SUMMARY:Someone Else is Out of Office'],
  );
  assert.deepStrictEqual(outDates(ics, PEOPLE), {});
});

test('matches aliases as well as the name', () => {
  const people = { kjohnson: { name: 'Katie Johnson', aliases: ['Katherine Johnson', 'K. Johnson'] } };
  const ics = calendar(
    ['DTSTART;VALUE=DATE:20261002', 'SUMMARY:Katie Johnson is Out of Office'],
    ['DTSTART;VALUE=DATE:20261005', 'SUMMARY:Katherine Johnson on Vacation'],
    ['DTSTART;VALUE=DATE:20261006', 'SUMMARY:k. johnson on Sick Leave'],
  );
  assert.deepStrictEqual(sorted(outDates(ics, people)), { kjohnson: ['2026-10-02', '2026-10-05', '2026-10-06'] });
});

test('someone with only aliases still matches, and isn\'t warned about', async () => {
  const people = { kjohnson: { name: '', aliases: ['Katherine Johnson'] } };
  const ics = calendar(['DTSTART;VALUE=DATE:20261001', 'SUMMARY:Katherine Johnson is Out of Office']);
  const { core, logs } = logger();
  const now = new Date('2026-10-01T18:00:00Z');
  const away = await awaySoon({ url: 'u', core, now, fetch: feed(ics), people, holidays: HOLIDAYS });
  assert.deepStrictEqual([...away], ['kjohnson']);
  assert.ok(logs.every((l) => !l.startsWith('WARN')));
});

test('timed entries count on each Pacific date they touch', () => {
  const ics = calendar(
    // 09:00 to 13:00 Pacific on Oct 2, given in UTC.
    ['DTSTART:20261002T160000Z', 'DTEND:20261002T200000Z', 'SUMMARY:Grace Hopper on Sick Leave'],
    // 17:00 Pacific Oct 4 is already Oct 5 in UTC.
    ['DTSTART:20261005T000000Z', 'DTEND:20261005T010000Z', 'SUMMARY:Ada Lovelace is Out of Office'],
  );
  assert.deepStrictEqual(sorted(outDates(ics, PEOPLE)), { ghopper: ['2026-10-02'], alovelace: ['2026-10-04'] });
});

test('unfolds long lines, unescapes text, and matches names regardless of case and spacing', () => {
  const ics = calendar(['DTSTART;VALUE=DATE:20261002', 'SUMMARY:katherine  johnson on Jury Duty\\, Superior', '  Court']);
  assert.deepStrictEqual(sorted(outDates(ics, PEOPLE)), { 'kjohnson': ['2026-10-02'] });
});

test('next business day skips weekends and listed holidays', () => {
  assert.strictEqual(nextBusinessDay('2026-10-01', HOLIDAYS), '2026-10-02');
  assert.strictEqual(nextBusinessDay('2026-10-02', HOLIDAYS), '2026-10-05');
  assert.strictEqual(nextBusinessDay('2026-11-25', HOLIDAYS), '2026-11-30');
});

test('dates are Pacific', () => {
  assert.strictEqual(pacificDate(new Date('2026-10-02T06:00:00Z')), '2026-10-01');
});

function logger() {
  const logs = [];
  return { logs, core: { info: (m) => logs.push(m), warning: (m) => logs.push(`WARN ${m}`) } };
}

const feed = (ics) => async () => ({ ok: true, status: 200, text: async () => ics });

test('away soon = out today or on the next business day', async () => {
  const ics = calendar(
    ['DTSTART;VALUE=DATE:20261127', 'SUMMARY:Ada Lovelace is Out of Office'],
    ['DTSTART;VALUE=DATE:20261130', 'SUMMARY:Grace Hopper is Out of Office'],
    ['DTSTART;VALUE=DATE:20261201', 'SUMMARY:Katherine Johnson is Out of Office'],
  );
  const { core } = logger();
  // Wednesday before Thanksgiving: the next business day is the Monday after.
  const now = new Date('2026-11-25T18:00:00Z');
  const away = await awaySoon({ url: 'u', core, now, fetch: feed(ics), people: PEOPLE, holidays: HOLIDAYS });
  assert.deepStrictEqual([...away], ['ghopper']);
});

test('warns about people with no Rippling name and years with no holidays', async () => {
  const { core, logs } = logger();
  const people = { ...PEOPLE, newhire: { name: '' } };
  await awaySoon({ url: 'u', core, now: new Date('2027-01-04T18:00:00Z'), fetch: feed(calendar()), people, holidays: HOLIDAYS });
  assert.ok(logs.includes("WARN No Rippling name in REVIEW_PEOPLE for newhire, so their PTO isn't checked."));
  assert.ok(logs.includes('WARN ReviewConfig/holidays.json has no holidays for 2027; every weekday counts as a business day.'));
});

test('a failed fetch is a warning that never shows the URL', async () => {
  const { core, logs } = logger();
  const url = 'https://app.rippling.com/secret-token/calendar.ics';
  const fetch = async () => {
    throw new TypeError(`fetch failed for ${url}`);
  };
  const away = await awaySoon({ url, core, fetch, people: PEOPLE, holidays: HOLIDAYS });
  assert.strictEqual(away.size, 0);
  assert.ok(logs.includes("WARN Couldn't read the PTO calendar (TypeError); not checking who is out."));
  assert.ok(logs.every((l) => !l.includes('secret-token')));
});

test('no URL configured: nothing is fetched and nobody is out', async () => {
  const { core } = logger();
  const away = await awaySoon({ url: '', core, fetch: () => assert.fail('fetched'), people: PEOPLE, holidays: HOLIDAYS });
  assert.strictEqual(away.size, 0);
});

test('takes the people map as the JSON text of the REVIEW_PEOPLE variable', async () => {
  const ics = calendar(['DTSTART;VALUE=DATE:20261001', 'SUMMARY:Ada Lovelace is Out of Office']);
  const { core } = logger();
  const now = new Date('2026-10-01T18:00:00Z');
  const away = await awaySoon({ url: 'u', core, now, fetch: feed(ics), people: JSON.stringify(PEOPLE), holidays: HOLIDAYS });
  assert.deepStrictEqual([...away], ['alovelace']);
});

test('a missing or broken people map is a warning, and nobody is treated as out', async () => {
  for (const [people, warning] of [
    ['', 'WARN The REVIEW_PEOPLE org variable is empty or not passed in; not checking who is out.'],
    [undefined, 'WARN The REVIEW_PEOPLE org variable is empty or not passed in; not checking who is out.'],
    ['{not json', "WARN The REVIEW_PEOPLE org variable isn't valid JSON; not checking who is out."],
  ]) {
    const { core, logs } = logger();
    const away = await awaySoon({ url: 'u', core, people, fetch: () => assert.fail('fetched'), holidays: HOLIDAYS });
    assert.strictEqual(away.size, 0);
    assert.deepStrictEqual(logs, [warning]);
  }
});

test('the checked-in holidays are weekdays in their own year', () => {
  const holidays = JSON.parse(fs.readFileSync(path.join(__dirname, 'holidays.json'), 'utf8'));
  for (const [year, list] of Object.entries(holidays)) {
    for (const { date } of list) {
      assert.ok(date.startsWith(`${year}-`), date);
      assert.ok(![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()), `${date} is a weekend`);
    }
  }
});
