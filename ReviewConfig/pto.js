// Who is out of office, from the Rippling PTO calendar feed (an iCalendar file). Shared by
// AssignReviewers and the review SLA job.
//
// Entries are named "<name> is Out of Office" or "<name> on <leave type>". Every entry counts as
// out except Work From Home. Names are matched to GitHub logins through the people map, the
// REVIEW_PEOPLE org variable (kept out of this public repo); entries for anyone not in it (the feed
// covers the whole company) are ignored.

const fs = require('node:fs');
const path = require('node:path');

const TIME_ZONE = 'America/Los_Angeles';
const NOT_OUT = new Set(['work from home']);

// The checked-in company paid holidays: { "<year>": [{ "date": "YYYY-MM-DD", "name": "..." }] }.
function readHolidays(file = path.join(__dirname, 'holidays.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 'YYYY-MM-DD' of an instant, in Pacific time.
function pacificDate(instant) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(instant);
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

// The company paid holidays for a year, or null when holidays.json has no list for it.
function holidaysFor(holidays, year) {
  const list = holidays[String(year)];
  return list ? new Set(list.map((h) => h.date)) : null;
}

// The first business day after `date`: not a weekend and not a listed holiday.
function nextBusinessDay(date, holidays) {
  let next = addDays(date, 1);
  while (isWeekend(next) || holidaysFor(holidays, next.slice(0, 4))?.has(next)) next = addDays(next, 1);
  return next;
}

// Unfolds continuation lines and returns each VEVENT as { NAME: { value, params } }.
function parseIcs(text) {
  const events = [];
  let event = null;
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') event = {};
    else if (line === 'END:VEVENT') {
      if (event) events.push(event);
      event = null;
    } else if (event) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const [name, ...params] = line.slice(0, colon).split(';');
      event[name.toUpperCase()] = { value: line.slice(colon + 1), params: params.map((p) => p.toUpperCase()) };
    }
  }
  return events;
}

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? ' ' : c));
}

// The Pacific date a DTSTART/DTEND falls on. UTC times are converted; times with a TZID, or none,
// are taken at their own date, which is Pacific for this feed.
function propertyDate(property) {
  const v = property.value;
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (!v.endsWith('Z')) return date;
  return pacificDate(new Date(`${date}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`));
}

// Every Pacific date an event covers. All-day events end the day before DTEND; a timed entry
// (a half day, say) covers each date it touches.
function eventDates(event) {
  if (!event.DTSTART) return [];
  const allDay = event.DTSTART.params.includes('VALUE=DATE') || event.DTSTART.value.length === 8;
  const start = propertyDate(event.DTSTART);
  let last = start;
  if (event.DTEND) {
    const end = propertyDate(event.DTEND);
    last = allDay ? addDays(end, -1) : end;
  }
  const dates = [];
  for (let d = start; d <= last && dates.length < 366; d = addDays(d, 1)) dates.push(d);
  return dates.length > 0 ? dates : [start];
}

// "Ada Lovelace is Out of Office" → { name: 'Ada Lovelace', kind: 'Out of Office' }.
function parseSummary(summary) {
  const match = /^(.+?) (?:is|on) (.+)$/.exec(summary.trim());
  return match ? { name: match[1].trim(), kind: match[2].trim() } : null;
}

const normalize = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();

// Every name a person may appear under: their name as Rippling shows it, plus any aliases (a legal
// name that other systems use, say).
const namesOf = (person) => [person?.name, ...(Array.isArray(person?.aliases) ? person.aliases : [])].filter(
  (name) => typeof name === 'string' && name.trim(),
);

// For each GitHub login in the people map, the set of Pacific dates the calendar has them out.
function outDates(icsText, people) {
  const loginByName = new Map(
    Object.entries(people).flatMap(([login, person]) => namesOf(person).map((name) => [normalize(name), login])),
  );
  const out = {};
  for (const event of parseIcs(icsText)) {
    const entry = event.SUMMARY && parseSummary(unescapeText(event.SUMMARY.value));
    if (!entry || NOT_OUT.has(entry.kind.toLowerCase())) continue;
    const login = loginByName.get(normalize(entry.name));
    if (!login) continue;
    out[login] ??= new Set();
    for (const date of eventDates(event)) out[login].add(date);
  }
  return out;
}

// For each login in the people map, the Pacific dates the PTO calendar has them out, or null with a
// warning when the feed or the map can't be read. With no URL configured, it's null with a note.
//
// `people` is the people map, as an object or as the JSON text of the REVIEW_PEOPLE org variable:
// { "<github login>": { "name": "<name as Rippling shows it>", "aliases": ["<other name>"],
//                        "slack": "<Slack member ID>" } }, with aliases optional.
async function readOutDates({ url, core, people, now = new Date(), fetch = globalThis.fetch, holidays = readHolidays() }) {
  if (!url) {
    core.info('No PTO calendar configured; not checking who is out.');
    return null;
  }
  try {
    people = typeof people === 'string' ? JSON.parse(people || '{}') : people || {};
  } catch {
    core.warning("The REVIEW_PEOPLE org variable isn't valid JSON; not checking who is out.");
    return null;
  }
  if (Object.keys(people).length === 0) {
    core.warning('The REVIEW_PEOPLE org variable is empty or not passed in; not checking who is out.');
    return null;
  }
  const unnamed = Object.entries(people).filter(([, person]) => namesOf(person).length === 0).map(([login]) => login);
  if (unnamed.length > 0) {
    core.warning(`No Rippling name in REVIEW_PEOPLE for ${unnamed.join(', ')}, so their PTO isn't checked.`);
  }
  const year = pacificDate(now).slice(0, 4);
  if (!holidaysFor(holidays, year)) {
    core.warning(`ReviewConfig/holidays.json has no holidays for ${year}; every weekday counts as a business day.`);
  }
  let text;
  try {
    // The URL carries a token, so neither it nor an error that might quote it is logged.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    core.warning(`Couldn't read the PTO calendar (${/^HTTP \d+$/.test(error.message) ? error.message : error.name}); not checking who is out.`);
    return null;
  }
  return outDates(text, people);
}

// The logins who are out today or on the next business day (Pacific): a review assigned now is
// due within about one business day, so someone out tomorrow shouldn't get it today.
//
// Returns an empty set when the feed or the map can't be read: picking someone who is out is
// better than not assigning at all.
async function awaySoon(options) {
  const { now = new Date(), holidays = readHolidays() } = options;
  const dates = await readOutDates({ ...options, now, holidays });
  if (!dates) return new Set();
  const today = pacificDate(now);
  const window = [today, nextBusinessDay(today, holidays)];
  const away = new Set(Object.keys(dates).filter((login) => window.some((d) => dates[login].has(d))));
  options.core.info(`Out ${window.join(' or ')}: ${[...away].join(', ') || 'nobody'}.`);
  return away;
}

module.exports = {
  TIME_ZONE,
  addDays,
  awaySoon,
  holidaysFor,
  isWeekend,
  nextBusinessDay,
  outDates,
  pacificDate,
  parseIcs,
  readHolidays,
  readOutDates,
};
