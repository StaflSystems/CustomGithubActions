# Review config

Shared by the review actions (`AssignReviewers`, and the review SLA job to come): who people are,
when they're out, and which days are company holidays.

## People

This repo is public, so the map from GitHub logins to people is the org variable `REVIEW_PEOPLE`,
not a file here. Each workflow passes it to the action as `people: ${{ vars.REVIEW_PEOPLE }}`. It's
JSON, one entry per engineer on the review teams:

```json
{
  "octocat": { "name": "Mona Octocat", "aliases": ["Mona Lisa Octocat"], "slack": "U0123456789" }
}
```

`name` is the name exactly as Rippling shows it, and `slack` is their Slack member ID, for review
reminders. `aliases` is optional: any other names they may appear under, such as a legal name that
some systems use instead of the name they go by. A calendar entry matches the name or any alias.
Whoever adds or removes someone from the review teams updates it at the same time.

## Files

| File | What it holds | Who updates it |
| --- | --- | --- |
| `holidays.json` | Company paid holidays, by year | By hand, each year, from the holiday calendar People Operations publishes. Add next year's before Jan 1 |
| `pto.js` | Reads the Rippling PTO calendar feed | — |

## Who is out

The Rippling PTO calendar feed URL is the org secret `PTO_CALENDAR_URL`. It carries a token, so it's
passed in as an action input and never logged.

Entries are named `<name> is Out of Office` or `<name> on <leave type>`. Every entry counts as out
except Work From Home. Names are matched to each person's name and aliases in `REVIEW_PEOPLE`,
ignoring case and extra spaces. Entries for anyone not in it are ignored, since the feed covers the
whole company. Someone in `REVIEW_PEOPLE` with neither a name nor an alias gets a warning on every
run, because their time off can't be checked.

All-day entries cover each day up to the day before their end date. Timed entries, such as a half
day, cover each Pacific date they touch.

If the feed can't be fetched, or `REVIEW_PEOPLE` is missing or isn't valid JSON, the actions warn and
carry on as if nobody is out.

## Business days

Business days are Monday to Friday in Pacific time, minus the holidays in `holidays.json`. A year
with no list gets a warning on every run, and every weekday counts until it's added.

## Tests

```bash
node --test ReviewConfig/
```
