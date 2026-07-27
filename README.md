# Product Wire

Tracks **new grad and internship product roles** (PM, Product Engineer, TPM) and
pushes a phone notification the moment a new one appears.

- **Sources**: ~93 company job boards polled directly via their public
  Greenhouse / Lever / Ashby APIs ([`config/companies.json`](config/companies.json)),
  plus the SimplifyJobs [New-Grad](https://github.com/SimplifyJobs/New-Grad-Positions)
  and [Internships](https://github.com/SimplifyJobs/Summer2026-Internships) lists
  for coverage of companies on custom ATSs.
- **Filter**: PM / Product Engineer / TPM titles with a new-grad or intern
  signal, located in the US or US-remote. Senior/staff/marketing titles and
  ambiguous "APM" (Application Performance Monitoring) titles are excluded.
- **Runner**: GitHub Actions cron every 15 minutes ([`.github/workflows/track.yml`](.github/workflows/track.yml)).
  State lives in `data/seen.json`; each run commits changes back to the repo.
- **Notifications**: one [ntfy.sh](https://ntfy.sh) push per new posting, tap to
  open the application page. The topic name is a repo secret (`NTFY_TOPIC`) so
  strangers can't spam the feed.
- **Dashboard**: static page in [`docs/`](docs/) served by GitHub Pages, reads
  `docs/data.json` written by each run.

## One-time setup

1. **ntfy**: install the ntfy app ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)) and
   subscribe to your secret topic.
2. **Secret**: repo → Settings → Secrets and variables → Actions → New repository
   secret. Name `NTFY_TOPIC`, value = your topic name.
3. **Pages**: repo → Settings → Pages → Deploy from a branch → `main` / `/docs`.
4. Trigger the first run: Actions → `track` → Run workflow (or just wait 15 min).

## Day-to-day

- Add/remove companies by editing `config/companies.json` (`ats` is one of
  `greenhouse` / `lever` / `ashby`; `slug` is the company's board token —
  verify it returns jobs at the ATS's public API before adding).
- Tune title/location filters in `scripts/track.mjs` (the regexes at the top).
- Run locally without sending pushes: `DRY_RUN=1 node scripts/track.mjs`.
- When SimplifyJobs opens their Summer 2027 internships repo, update the URL in
  `SIMPLIFY_SOURCES` in `scripts/track.mjs`.

## Notes

- The first ever run (no `data/seen.json`) seeds state silently instead of
  sending ~90 pushes at once.
- GitHub cron isn't exact — runs can be delayed 5–15 minutes at busy times.
- GitHub disables cron workflows on repos with no activity for 60 days; the
  bot's own commits normally keep it alive, but if GitHub emails you about a
  disabled workflow, one click re-enables it.
