// Business hours for the review SLA: 10:00 to 17:00 Pacific on business days (Monday to Friday,
// minus the holidays in holidays.json). Start and end times vary across the team, so the band is
// narrower than anyone's working day, and a business day is 7 hours.

const { TIME_ZONE, addDays, holidaysFor, isWeekend, pacificDate } = require('./pto.js');

const OPENS = 10;
const CLOSES = 17;
const HOUR_MS = 3600 * 1000;

function isBusinessDay(date, holidays) {
  return !isWeekend(date) && !holidaysFor(holidays, date.slice(0, 4))?.has(date);
}

// Pacific's UTC offset on a date, in hours (-7 or -8). DST changes at 02:00, so it's the same
// all through business hours.
function pacificOffset(date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName').value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) + Number(match[3]) / 60) : 0;
}

// The instant it's `hour`:00 Pacific on `date`.
function pacificTime(date, hour) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + (hour - pacificOffset(date)) * HOUR_MS);
}

// [opens, closes] on a business day, or null on a weekend or holiday.
function businessWindow(date, holidays) {
  return isBusinessDay(date, holidays) ? [pacificTime(date, OPENS), pacificTime(date, CLOSES)] : null;
}

// Business hours between two instants. 0 if `end` isn't after `start`.
function businessHoursBetween(start, end, holidays) {
  if (end <= start) return 0;
  let ms = 0;
  const last = pacificDate(end);
  for (let date = pacificDate(start); date <= last; date = addDays(date, 1)) {
    const window = businessWindow(date, holidays);
    if (!window) continue;
    const from = Math.max(start, window[0]);
    const to = Math.min(end, window[1]);
    if (to > from) ms += to - from;
  }
  return ms / HOUR_MS;
}

// The instant `hours` business hours after `start`: when a review started then is due.
function addBusinessHours(start, hours, holidays) {
  let remaining = hours * HOUR_MS;
  for (let date = pacificDate(start); ; date = addDays(date, 1)) {
    const window = businessWindow(date, holidays);
    if (!window) continue;
    const from = Math.max(start, window[0]);
    if (from >= window[1]) continue;
    if (from + remaining <= window[1]) return new Date(from + remaining);
    remaining -= window[1] - from;
  }
}

module.exports = { addBusinessHours, businessHoursBetween, isBusinessDay, pacificOffset, pacificTime };
