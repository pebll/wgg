# WG Gefunden! (wgg)

*Find your WG, before everyone else.* The CLI and package are called `wgg`.

A private WG-Gesucht monitor: scrapes configured WG-Gesucht search result pages, stores new
listings in SQLite and (in later phases) scores and notifies. 

My wgg page runs at wgg.léo.com. With this repo you can host this on your own :)

## Setup

```sh
yarn install
cp config/wgg.example.yaml config/wgg.yaml   # edit searches + schedule
cp config/users.example.yaml config/users.yaml   # accounts (see "Accounts and login"); needs a password hash:
node bin/wgg.js hash-password                    # paste the printed line as passwordHash
cp .env.example .env                          # secrets: SESSION_SECRET (openssl rand -hex 32), LLM gateway, SMTP
```

## Usage

```sh
node bin/wgg.js scrape-once   # one cycle: prints listings not seen before
node bin/wgg.js run           # poll on the configured interval (default 30 min +/- 20 %, exponential backoff on bot detection) and serve the web UI
node bin/wgg.js serve         # web UI + API only, no scraping
node bin/wgg.js details       # fetch the pending detail pages once (--limit N: at most N listings)
node bin/wgg.js llm          # assess fetched listings with the LLM (--limit N, --ids 1,2, --force)
node bin/wgg.js llm-check    # probe the LLM gateway: status, path, model ids (--chat: one tiny completion)
node bin/wgg.js notify        # send the pending email alerts now (--dry-run: print them, mark nothing)
node bin/wgg.js test-mail     # send one test email, or name the missing SMTP variables
node bin/wgg.js hash-password # print a scrypt hash for config/users.yaml (hidden prompt; or pipe the password in)
node bin/wgg.js evaluate      # (re)evaluate stored listings (--all: also evaluated ones, --regeocode: geocode again)
yarn test && yarn lint
```

Only wg-gesucht.de is contacted, plus the one-time CloakBrowser binary download and OpenStreetMap Nominatim for
geocoding (see below), plus the LLM gateway you configure in `.env` (only the listing text goes there). Bot detection or
human verification is never bypassed: wgg logs it and backs off. No telemetry.

## Web UI

```sh
yarn build:frontend           # builds the React + Semi UI app into ui/dist (gitignored)
node bin/wgg.js serve         # or: node bin/wgg.js run (scheduler + UI in one process)
```

Open http://127.0.0.1:9998 (login required, see "Accounts and login"). The dashboard has a header, a toolbar and two columns. The header shows the **last fetch**
("9 min ago (12:01, 3 new)", plus errors or bot detection) and the **next fetch** ("in 5 min (12:05)", "backing off: ..."
or "scheduler not running") from `/api/status`, polled every 30 s. The left column is a grid of clickable tiles (real
buttons: click, Enter or Space; the selected tile is highlighted, the first offer is selected automatically and the
selection survives list refreshes): photo, score badge, rent, size, district, distance to your scoring target ("3.2 km to <target name>", "≈ ... (district
only)" when only the district was geocoded), 5-star score and "posted 3 h ago". The right column is a sticky **detail
panel** for the selected offer (stacked above the list below 1024 px): large photo, "Open on WG-Gesucht" link, facts,
the exclusion reason, and the score breakdown with the overall score as 5 stars (score / 2, half stars, "8.4/10") and one
row per parameter (stars, value, reason; fields without data are listed as "not scored"). Once the detail page has been fetched
(see "Detail pages") the panel also shows the exact address, a **costs** table (Miete, Nebenkosten, Kaution, ... as the
page words them, "n.a." as "not given"), the **flat share** facts ("Die WG", "Gesucht wird"), the **property** facts,
and the **description** as a short excerpt with a collapsible "Show full description" holding every section with its
heading; until then a status line reads "Details pending", "Details pending (attempt 1 failed: ...)", "Details
failed: <reason>" or "Details skipped (listing too old)". The toolbar sorts by Score, AI Score or Rent and filters by recency (New, < 1 day,
< 3 days; default < 1 day); the header shows the offer count. Dark mode follows the system
setting (`prefers-color-scheme`); the sun/moon button overrides it and is remembered in localStorage.
Listings that have not been evaluated yet show a grey badge. `GET /api/listings` (same query parameters: `sort`,
`dir`, `minScore`, `maxRent`, `maxAgeDays`, `maxAgeHours`, `page`, `pageSize`; `maxAgeDays` / `maxAgeHours` (positive,
fractions allowed) keep listings whose publish time (fallback: first seen) is at most that old, no age filter when omitted;
`sort` is `overall`, `price`, `first_seen` or `ai`, the LLM fit score, descending, unassessed last). The toolbar has
"Sort by: Score | AI Score | Rent" and "Recency: New (< 1 hour) | < 1 day | < 3 days" (default < 1 day, remembered in
localStorage) and `GET /api/health` are also available.

`GET /api/status` returns `{ lastFetch: {id, startedAt, finishedAt, newCount, errorCount, botDetected, error} | null,
nextFetchAt, backoff, schedulerRunning }` (epoch ms). Every scrape cycle (`wgg run` and `scrape-once`) is recorded in the
SQLite table `fetch_runs` (`finishedAt` is null while it runs); the `wgg run` scheduler stores its planned next cycle
(after jitter/backoff) in `scheduler_state`, so a separate `wgg serve` shows the same status. `schedulerRunning` is a
heuristic: a next fetch is planned and not overdue by more than 10 minutes (a clean shutdown clears the plan; a crashed
process reads as not running after the grace period). `nextFetchAt`/`backoff` are null/false when it is not running.

**Dates.** Availability is shown in European form with the month spelled out ("1 November 2026", ranges with an en
dash: "1 November 2026 – 30 April 2027"); a start date of today or earlier reads "immediately" ("immediately – 30
April 2027"), unknown dates show "—". Used on tiles and in the panel.

**Hiding offers.** One mechanism, two origins. "Not interested" (on the tile and in the panel) hides an
offer **by you** (reason "Not interested"); "Messaged" does the same for offers you already contacted (reason "Messaged", shown as "Messaged on <date>"; `messaged_at` is kept after a restore, and the POST takes an optional `{"reason": "not_interested"|"messaged"}`); a toast offers **Undo** for 8 s and the selection moves to the next tile.
The program hides an offer **automatically** whenever its evaluation excludes it (excluded keyword, rent above the hard
maximum, LLM Verbindung probability at the threshold) with the exclusion as reason, and optionally when its overall score
is below `autoHide.belowOverall` in `config/evaluation.yaml` (default `null` = off; reason "Score 2.3 below 3"). Nothing
is ever deleted (`listings.dismissed_at` is the hidden time, `hidden_by` is `user` or `program`, `hidden_reason` the
text). The toolbar switches **Show not interested** and **Show messaged** list your own hidden offers (labelled "Hidden
by you" / "Messaged on ...", with a **Restore** button); **Show removed automatically** lists the offers the program
removed (each tile and the panel say "Removed automatically: <reason>", e.g. "excluded keyword "Corps"" or "LLM: not
eligible: ...", with a **Restore** button). With the switch off the toolbar says "N removed automatically"
(`hiddenAutomatically` in the `/api/listings` payload). Your decision wins: restoring an automatically hidden offer sets
`hide_override`, so later evaluations never hide it again; hiding it yourself turns it into a "by you" hide; and when a
re-evaluation no longer excludes a program-hidden offer it becomes visible again. `POST /api/listings/:id/dismiss` hides,
`DELETE /api/listings/:id/dismiss` restores (404 for an unknown id, 400 for a non-numeric id); `GET /api/listings` and
`GET /api/stats` skip hidden offers unless `show=not_interested,messaged,auto` (hidden ones by kind: yours, and removed
automatically) or `includeHidden=1`
(everything, also automatically hidden; `includeDismissed=1` still works); each listing carries
`hidden: {by, reason, at}` or `null`. The same filter (`buildListingFilter`) is the place a future notifier must use so
hidden offers (both kinds) are never announced. Hidden offers are not fetched for details and not sent to the LLM.

**Distribution.** The collapsible "Distribution" section above the list shows four bar charts, each in its own card
(2 x 2 on a desktop), for the offers matching the current filters: **Score** (bins 1-2 ... 9-10; not-yet-scored offers
are counted beside the chart), **AI score** (the LLM fit score, same bins; "not assessed" counted beside it), **Rent**
(50 EUR steps, offers without a price counted separately) and **Distance** (1 km steps, unknown counted separately).
Inline SVG, no chart library; hover a bar for its count. **Click a bar** to show only the offers in that bar (that chart's
range filter); click the active bar again to clear it. The active bar is highlighted, the others dimmed. One range per
chart, ranges of different charts are AND-combined, and they stack with the recency filter and the hidden switches.
Each chart ignores its own range, so its other bars stay visible and clickable. The toolbar's **Filter: All | Custom**
shows the active ranges as removable chips ("Score 7-8 x", "Rent 600-650 EUR x"); "All" clears them. Sort, recency and
the ranges are remembered in localStorage. The last bar of a chart has no upper bound (it also holds everything above, and
the score 10).

`GET /api/listings` and `GET /api/stats` take the range filters `scoreMin`/`scoreMax`, `aiMin`/`aiMax`, `rentMin`/`rentMax`
and `distMin`/`distMax`: half-open `[min, max)` like the bins, either bound optional, anything that is not a number is
ignored, an offer without that value never matches an active range. `/api/stats` takes the same filters as `/api/listings`
(`minScore`, `maxRent`, `maxAgeDays`, `maxAgeHours`, `show`, `includeHidden`, the ranges) and returns
`{ total, score: {bins: [{from, to, count}], unscored}, ai: {bins, unassessed}, rent: {bins, unknown}, distance: {bins, unknown} }`
for the logged-in user. `total` honours every filter; each chart's bins leave out that chart's own range.
Listings with an exclusion reason (keyword such as Studentenverbindung, rent above the hard maximum, the LLM verdict) are
left out of the statistics entirely: not in `total`, not in any bin. `GET /api/listings` still lists them (grey badge,
reason in the panel).

**Fetch now.** The header button starts a fetch on demand; it is disabled with "Available in 7 min (14:32)" until the
gap and any bot backoff have passed (`GET /api/status` reports `manualFetch.availableAt`; the server's 429 stays the
authority). It shows a spinner while it runs, then a toast "3 new offers" or the
error (the UI polls `/api/status` every 2 s meanwhile). `POST /api/fetch` answers 202 and runs the cycle asynchronously:
with `wgg run` it wakes the scheduler (which then plans the next fetch as usual), with `wgg serve` it runs one cycle in the
server process (same browser wiring as `scrape-once`). It follows the same politeness rules as automatic fetching:
**409** while a cycle is running (in this process, or an unfinished run younger than 15 min in the database, e.g. from
`scrape-once`); **429** with `retryAfterSeconds` (and a `Retry-After` header) while in bot backoff, and when the last fetch
started less than `schedule.manualFetchMinGapSeconds` ago (default 600 = 10 minutes, `0` disables the gap; the gap counts
from the start of the last fetch, scheduled or manual, and keeps wgg polite towards WG-Gesucht). Without a live scheduler, a
bot-detected last run also blocks for the first backoff interval (2 x `intervalMinutes`). A cycle that fails before it
starts (for example the browser does not launch) is recorded as a failed run, so it shows in the header and counts for the
gap. When the scheduler is not running the header says "Automatic fetching is off - start `wgg run`".

**Database path.** A relative `db` path in the config (default `./db/wgg.db`) is resolved against the project root, the
directory that holds `package.json`, not against the directory you start `wgg` from; absolute paths and `:memory:` are
used as they are.

Host and port are set in `config/wgg.yaml`:

```yaml
server:
  host: 127.0.0.1   # default: loopback only
  port: 9998
```

(`publicPath`, `publicUrl`, `trustProxy` and `sessionHours` are described under "Deployment behind a reverse proxy".)

For UI development, run `wgg serve` and `yarn start:frontend:dev` (vite dev server, proxies `/api` to port 9998).

### Presentation page

Visitors without a session land on a public presentation page (hero, live examples of the scoring, the AI review, the
Verbindung detection, the charts and filters, the alerts and the settings, the polite-scraping rules, "Interested? Request
an account at leo@brucker.fr", and the license note). Its "Log in" opens the login form (`#/login`); the login screen
has a "What is this?" button back to it (`#/about`), and a logged-in user opens it with "About" in the header. The routes
are hash-only, so the page works at `/` and under `/wgg/`; the server serves `index.html` without a session, and every
API call except `/api/health` still needs one. The examples are static, made-up data (no real listing, photo or address)
and the page makes no API call of its own (the app asks `/api/me` once on load to know whether a session exists).

## Accounts and login

wgg has accounts. Only the admin (you) creates them, by hand, in the gitignored `config/users.yaml`
(`config/users.example.yaml` is the template); there is no self-registration. `wgg run` / `wgg serve` refuse to start
without it and say how to create it; every other command that touches the database needs it too.

```yaml
users:
  - username: leo          # lowercase letters, digits . _ -   (the stable id of the account)
    admin: true            # at least one admin; the FIRST admin owns everything wgg collected before accounts existed
    email: you@example.org # optional default for this user's alerts (editable later)
    passwordHash: "scrypt$32768$8$1$..."   # from: node bin/wgg.js hash-password
```

- `wgg hash-password` asks for the password twice (hidden, at least 10 characters) and prints one line. For scripts:
  `printf '%s' "the password" | node bin/wgg.js hash-password`. Restart wgg after editing `users.yaml`.
- `SESSION_SECRET` (at least 32 characters, in `.env`) signs the login cookie; wgg exits with a message when it is
  missing. Generate one with `openssl rand -hex 32` and never reuse it elsewhere. Sessions are stored in the database, so
  a restart does not log anybody out; they end after `server.sessionHours` (default 168) without use, and on logout.
- The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` whenever the request came in over https. Login attempts are
  limited to 5 per minute per address and username (and 30 per address); every `/api/*` route except `/api/health` and
  `/api/login` answers `401` without a session, and every query is scoped to the logged-in user on the server.
- API: `POST /api/login {username, password}` -> `{username, admin, email, targetName}`, `POST /api/logout`, `GET /api/me` (same shape; `targetName` is the name of the
  user's scoring target, which the UI puts into every distance label and the AI prompt names too).
- Security: passwords are only stored as scrypt hashes, a login failure never says which part was wrong, an unknown user
  costs the same time as a wrong password, and the session id changes at login. wgg is for a home network or a VPN; if
  it is reachable from the internet, serve it over HTTPS only (see the reverse proxy section) and use strong passwords.

**Upgrading from the single-user version.** On the first start with `users.yaml`, wgg backs up `db/wgg.db` to
`db/wgg.db.pre-multiuser.bak`, migrates it, and hands everything that was per listing (evaluations, AI assessments,
hidden and messaged offers, alert marks) and the `searches` of `config/wgg.yaml` (as queries) to the first admin, exactly
once. Listings, detail pages and geocoding stay shared; new users start with default settings and a copy of the admin's
queries. See the per-user sections below.

## Options (per user)

The **Options** tab (next to **Offers**) is where every user, not only the admin, sets up their own wgg. Everything is
stored per user (`user_settings`, `user_queries`); nothing here can see or change another user's data. Each section has
its own **Save** and **Reset to default** (reset fills the fields with the defaults, nothing is stored until you save).

- **Queries.** The WG-Gesucht searches wgg runs for you ("1 of 1" is used, see "Search query limits"). To get the address:
  1. Open wg-gesucht.de, choose your city and "WG-Zimmer", and set your filters (max rent, districts, radius...).
  2. Click Search.
  3. Copy the full address from the browser bar of the results page and paste it into Options. Only wg-gesucht.de result
     pages work; results are sorted newest-first automatically.

  Add, edit, enable/disable and delete; the server's validation message is shown under the form. Adding or changing an
  enabled query starts a fetch right away (`POST /api/fetch`); if one is already running or came too recently (409/429)
  that is shown as information, the query is saved and the scheduler fetches it anyway.
- **Notifications.** Email address, alerts on/off, and the thresholds for **Fantastic** offers (one mail right after the
  AI assessment) and **Good** offers (collected into one digest) as two numbers each, "Score >" and "AI score >" (stored as the rules
  `[{overall: {gt: x}, ai: {gt: y}}]`; an empty field is ignored). Rules that are more complex than that (several rules,
  other fields such as rent or distance) are shown read-only as JSON, "edit in config" (`notify` in `config/wgg.yaml` is
  the default for new users). Also the maximum age of an announced offer. **Send test mail** mails the saved address and
  shows why it cannot (no address, server without SMTP, too many tests).
- **AI profile.** The text the local LLM reads each offer against (who moves in, budget, how long you stay, deal-breakers),
  and the switch that hides offers the AI finds not eligible (they stay listed under "Show removed automatically"). New
  users start with the admin's profile from `config/evaluation.yaml` as an example: replace it with your own. Saving
  re-assesses your listings automatically (assessments store a hash of prompt version, profile and model).
- **Auto-reject.** Two switches that hide offers automatically (they stay listed under "Show removed automatically" with
  the reason, and **Restore** keeps one visible). **Reject Verbindungen automatically** (on by default) has two parts:
  the **Word list** (the exclusion keywords of Scoring, shown read-only here) and the **AI check** (the AI's Verbindung
  probability is at least the slider, default 60 %, 30-95 %). Turning the switch off only stops the hiding: the
  Verbindung badge still shows. **Reject short-term rentals** (off by default) hides offers that have an end date and a
  stay shorter than the minimum (1-24 months, default 6), counted from the later of move-in date and today, with the reason
  "Short-term: 5 weeks (< 6 months)". Open-ended offers, without an end date, are never rejected by this rule (the soft
  "stay length" score of Scoring still applies). Saving re-checks all your offers; the settings are stored as
  `autoReject` in your settings and existing users keep today's behaviour until they change them.
- **Scoring.** Target name and address (the address is looked up when you save, the result is shown as latitude/longitude,
  an unknown address is refused), rent best/worst/hard maximum, size, distance, recency, stay length (wanted stay and
  shortest acceptable, in days), weights and the exclusion keywords. Saving scores your offers again. The same rules as in
  "Evaluation (scoring)" apply (best and worst must differ, weights >= 0 with at least one above 0, ...).

API: `GET /api/settings` -> `{settings, defaults}`, `PUT /api/settings` (a partial document; unknown keys are refused, the
target coordinates only come from geocoding), `POST /api/settings/test-mail`, and `GET/POST /api/queries`,
`PUT/DELETE /api/queries/:id`.

### Setting up the accounts (admin)

```sh
cp config/users.example.yaml config/users.yaml        # gitignored
printf '%s' 'a long password' | node bin/wgg.js hash-password   # or run it without the pipe for a hidden prompt
#   -> paste the printed scrypt$... line as passwordHash, one entry per person (admin: true for you)
openssl rand -hex 32                                   # -> SESSION_SECRET=... in .env (never commit .env)
# restart: stop the running `wgg run`, then
yarn build:frontend && node bin/wgg.js run
```

Behind Caddy under `/wgg` add `server.publicPath: /wgg` (and `publicUrl` for links in emails), see "Deployment behind a
reverse proxy". Open the site, log in, and each user finishes their Options (email, thresholds, AI profile).

## Search query limits (why)

Every user has their own search queries (a WG-Gesucht result page, see Options), but each DISTINCT enabled URL costs one
request to WG-Gesucht per cycle, and WG-Gesucht blocks clients that ask too often. So, in `config/wgg.yaml`:

```yaml
queries:
  maxPerUser: 1            # default 1 (>= 1); the API answers 409 "You can have at most 1 query ..." beyond it
  maxDistinctPerCycle: 5   # default 5: with more distinct URLs, the ones fetched longest ago go first, the rest next cycle
```

Users with the same URL share one request. When the cap cuts a cycle short wgg logs a warning and rotates (round robin),
so nobody starves. The data model and the scheduler already handle many queries and users; only these numbers hold them back.

## Deployment behind a reverse proxy (Caddy, under /wgg)

wgg itself speaks plain http on loopback; put HTTPS in front of it. To serve it under a path of an existing site, let the
proxy **strip the prefix**, for example with Caddy (before the catch-all of that site):

```caddyfile
example.org {
    redir /wgg /wgg/
    handle_path /wgg/* {
        reverse_proxy 127.0.0.1:9998
    }
    # ... your existing handlers
}
```

The UI uses relative URLs only (vite `base: './'`, requests like `api/listings`), so it works at `/` and under any prefix.
In `config/wgg.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 9998
  publicPath: /wgg                 # cookie path; default "/"
  publicUrl: https://example.org/wgg   # optional: alert emails link back to the app (derives publicPath when it is not set)
  trustProxy: loopback             # whose X-Forwarded-For / -Proto to believe: loopback (default), true, false, a hop count, or addresses
  sessionHours: 168
```

`trustProxy` matters for two things: the client address of the login rate limit and the `Secure` flag of the cookie (from
`X-Forwarded-Proto`). Behind a proxy on the same machine the default is right; set it to `false` when wgg is reached
directly.

> wgg is still meant for a home network or a VPN. If you expose it, use HTTPS (the proxy above), strong passwords and a
> private `SESSION_SECRET`.

## Deploy on a home server (Docker + Caddy)

Files: `Dockerfile`, `.dockerignore`, `deploy/compose.yml`, `deploy/Caddyfile.snippet`, `deploy/config.server.example.yaml`.
The image holds the code and the system libraries; the database, the config and `.env` are mounted, and the stealth
Chromium (CloakBrowser, ~700 MB) is downloaded on first use into the `cloakbrowser` volume.

**1. DNS and network.** For `wgg.léo.com` (punycode `wgg.xn--lo-bja.com`): an `AAAA` record to the server's IPv6 (and allow
80/443 to it in the router's IPv6 firewall) plus an `A` record to the router's public IPv4 with ports 80 and 443
forwarded to the server. Caddy obtains the certificate itself.

**2. Copy to the server** (folder `~/wgg`; the container runs as uid 1000):

```sh
ssh lo-server 'mkdir -p ~/wgg/{db,config,repo}'
rsync -a --delete --exclude node_modules --exclude db --exclude .env --exclude 'config/*.yaml' --exclude ui/dist \
  ./ lo-server:~/wgg/repo/
scp deploy/compose.yml lo-server:~/wgg/compose.yml
```

Alternative without building on the server: `docker build -t wgg:latest . && docker save wgg:latest | gzip | ssh lo-server 'gunzip | docker load'`,
then `docker compose up -d --no-build`.

**3. Migrate the data** (stop the local `wgg run` first; the real files never go into git):

```sh
sqlite3 db/wgg.db ".backup /tmp/wgg.db" && scp /tmp/wgg.db lo-server:~/wgg/db/wgg.db
scp config/{wgg,evaluation,users}.yaml lo-server:~/wgg/config/
scp .env lo-server:~/wgg/.env && ssh lo-server 'chmod 600 ~/wgg/.env'
ssh lo-server 'chown -R 1000:1000 ~/wgg/db ~/wgg/config'   # only needed when the server user is not uid 1000
```

In `~/wgg/config/wgg.yaml` use the `server:` block of `deploy/config.server.example.yaml` (host `0.0.0.0`, `publicUrl`,
`trustProxy`). Keep `db: ./db/wgg.db`.

**4. Caddy.** Add `deploy/Caddyfile.snippet` to the Caddyfile of the nextcloud project, then
`docker exec caddy caddy reload --config /etc/caddy/Caddyfile`. The compose file joins the external network
`nextcloud_backend` (confirm the name with `docker network ls`; adjust `name:` in `compose.yml`).

**5. First start and checks**

```sh
cd ~/wgg && docker compose up -d --build
docker compose logs -f wgg                      # first fetch downloads Chromium
docker exec wgg node bin/wgg.js llm-check       # is the LLM gateway reachable from home?
docker exec wgg node bin/wgg.js test-mail       # SMTP
docker compose ps                               # "healthy" after the start period
```

**Updates:** rsync the repo again (step 2), then `cd ~/wgg && docker compose up -d --build`. The cached Chromium survives.

**Backups:** `sqlite3 ~/wgg/db/wgg.db ".backup ~/wgg/db/backup-$(date +%F).db"` on the host (consistent even while wgg
runs), or inside the container `docker exec wgg node -e "import('better-sqlite3').then(({default:D})=>new D('db/wgg.db').backup('db/backup.db')).then(()=>console.log('ok'))"`.
Back up `~/wgg/config` and `~/wgg/.env` too.

## Detail pages

The search cards carry no description, so wgg also fetches each listing's own page (`lib/provider/wgGesuchtDetail.js`)
and stores what the page actually contains in the listing: the description tabs as sections (`{heading, text}`, the real
headings, e.g. "Zimmer"), the full plain description (`description_text`), the cost rows (Miete, Nebenkosten, Sonstige
Kosten, Kaution, Ablösevereinbarung: raw text and parsed number, "n.a." is not a number), the exact address, "frei ab",
"Online", the WG facts ("Die WG", "Gesucht wird" bullet points) and the object facts ("Angaben zum Objekt"). The parser
reads nothing that is not on the page. Per listing `details_status` is `pending`, `fetched`, `failed` (3 attempts used
up, `details_error` holds the last message) or `skipped` (older than `details.maxAgeDays`).

**The queue.** `wgg run` starts a background worker after each search cycle and drains the pending listings: the
highest score first (unscored last, then newest; so a Studentenverbindung among the best offers is found and excluded
quickly; the LLM queue uses the same order), one page at a time, `details.delaySeconds` (default 60) +/- `details.jitterPercent` (default 50, so 30-90 s) between
two requests, one browser for the whole drain (closed when the queue is empty). Dismissed listings are not fetched,
listings older than `details.maxAgeDays` (default 7) are marked `skipped`. A failed page is retried after the other
listings, up to `details.maxAttempts` (default 3) attempts, then `failed`; a page without any description or costs
counts as a failure. After a page is stored the listing is geocoded again when the detail address is more precise
(only a district was known, or the detail street has a house number the card lacked) and evaluated again, so the keyword
exclusion also sees the full description. Politeness: detail requests and search cycles share one lock (never in
parallel; a cycle waits for a detail request in flight and vice versa) and one bot backoff: a bot wall on a detail page
is never retried, stops the queue, is recorded like a bot-detected cycle and makes the scheduler wait the next
exponentially longer interval; no detail page is fetched while that backoff lasts. `wgg details [--limit N] [--ids ...]` drains
the queue once (also refused during the backoff); Ctrl-C / SIGTERM stops `run` and `details` cleanly after the current
step. `GET /api/status` has `details: {pending, fetched, failed, running, nextAt}` (`pending` excludes dismissed and
too-old listings; `running`/`nextAt` describe the worker of that process), and the header shows "Details: 12 pending
(next in 45 s)". `GET /api/listings` items carry a `details` object (`status`, `attempts`, `error`, `fetchedAt`,
`description`, `sections`, `costs`, `address`, `wgFacts`, `objectFacts`).

## Evaluation (scoring)

Every new listing is geocoded, evaluated and stored by the scrape cycle; `wgg evaluate` does the same for stored
listings (`--all` re-evaluates already evaluated ones, which also refreshes the recency score; `--regeocode`
geocodes every row again and retries places Nominatim did not know before).

Each parameter is scored 1 (bad) to 10 (great), linearly between a `worst` and a `best` value. The overall score is
the weighted average, rounded to one decimal. Parameters that cannot be read (no price, no location, ...) are left
out of the average and listed under `missing`; they are never scored as 0. Parameters: `rent`, `distance`
(straight-line km to the target, default the TUM Universitätsbibliothek), `recency` (hours since the ad went online:
0 h = 10, 72 h = 1), `size`, `stayLength` (temporary listings; open-ended = 10; the move-in date itself is not
scored). The WG size ("3er WG") is shown on the offer but not scored. There is no rent cap: limit the rent in the WG-Gesucht
search itself. Hard exclusions (the keyword list such as Studentenverbindung/Burschenschaft/Corps) set the overall
score to 1 and store the reason; the individual scores are
still computed. The keywords are checked against the title, the card details and, once the detail page has been fetched
(see "Detail pages"), the full description; the evaluation is re-run after the details are stored.

Tuning: `cp config/evaluation.example.yaml config/evaluation.yaml` (gitignored) and edit. All values in the example
are placeholders to tune; omitted keys keep the example's value; without a real file the example is used and a
warning is logged. Then run `node bin/wgg.js evaluate --all`. The keyword match is on whole words and the default list
holds specific terms (Studentenverbindung, Verbindungshaus, Burschenschaft, Corps, Landsmannschaft, Bundesbrüder,
Aktivitas). Do not add a plain "Verbindung": it also matches "gute Verbindung zur U-Bahn" in ordinary descriptions.

`published_at` is the first-seen time minus the "Online: ..." age (or local midnight of an "Online: dd.mm.yyyy" date);
it is NULL when unknown, in which case recency falls back to the first-seen time and says so.

### Geocoding policy (OpenStreetMap Nominatim)

Locations come from the public Nominatim service and follow its usage policy: one request at a time, at least 1.1 s
between requests, an identifying `User-Agent` (`wgg/<version> (private self-hosted; ...)`), an optional contact address
from the environment variable `NOMINATIM_EMAIL` (sent as `email`, set it in `.env`), and every answer, including "not
found", is cached in the SQLite table `geocode_cache`, so each query hits the network at most once. Errors and
timeouts are logged, treated as "unknown" and not cached. Lookup order: street + district, street only, then the
district centroid (`geo_precision` = `district`); a bare "München" without district is never geocoded (unknown), and
results more than 60 km from the target are rejected as a wrong-city match. Nothing is guessed silently: the
precision (`address`, `district`, or unknown) is stored and shown. Distance is a straight line (haversine); routing or
public-transport times are a possible future extension.

### Evaluator extension point

`lib/evaluation/ruleBasedEvaluator.js` defines the `Evaluator` interface (`{name, evaluate(listing, context) ->
{scores, overall, missing, details, excluded?}}`) and the rule-based implementation. `lib/evaluation/llmEvaluator.js`
is the second implementation (see below): the same shape, except that `evaluate` is asynchronous, and its 1-10 fit
score is merged by `mergeLlm` as one more weighted parameter (`scores.llm` / `details.llm`, weight `llm.weight`) into
the rule-based result. A re-evaluation of a stored listing (new details, `wgg evaluate`) re-merges the stored LLM
result, so it is never lost.

## LLM assessment

Once a listing's detail page is fetched, wgg sends everything it knows (title, rent and all costs, size, WG size,
address and distance, availability, online since, WG and object facts, the full description) to an LLM through an
OpenAI-compatible gateway (plain `fetch`, no SDK). The system prompt explains that the user wants a normal WG and
lists Studentenverbindung signals ("Bundesbrüder", "Aktivitas", "Kneipe", ... and false-positive traps such as
"gute Verbindung zur U-Bahn"). The model answers with one JSON object (`temperature` 0, `response_format` json when the
gateway accepts it, code fences tolerated, one retry on invalid JSON, 60 s timeout):
`verbindungProbability` 0..1, `verbindungSignals` (German quotes), `fitScore` 1..10, `summary` (English, 2 sentences),
`positives`, `redFlags`. The result is stored in `llm_json` (+ `llm_status` pending / done / failed / skipped,
`llm_model`, `llm_evaluated_at`, `llm_error`, `llm_attempts`).

- **Secrets and model** live in `.env`: `LLM_BASE_URL`, `LLM_API_KEY`, optional `LLM_MODEL` (overrides `llm.model` in
  `config/evaluation.yaml`). The key is only sent in the `Authorization` header and masked in every error message, log
  line and database column. The gateway tested here is the KIT SCC KI-Toolbox (`/models`, `/chat/completions`).
- **`wgg llm-check [--chat] [--model id]`** prints the HTTP status, the working path and the model ids only;
  `--chat` adds one tiny completion.
- **Config** (`llm:` in `config/evaluation.yaml`): `enabled`, `model`, `weight` (default 2), `excludeThreshold` (0.6),
  `badgeThreshold` (0.3, the UI shows "Verbindung? 45 %" from there), `maxDescriptionChars` (12000; a longer text is
  cut, the prompt and the stored result say so: `truncated`), `delaySeconds` (2 s between two calls).
- **About you**: `llm.profile` (multi-line text: gender, age, status, languages, the WG you want) and today's date go
  into the prompt, so the AI judges fit (WG atmosphere, Zweck-WG low) and eligibility. The AI also answers `eligible` /
  `eligibilityReason`; with `llm.hideIneligible` (default true) an ad that explicitly excludes you (only women, age
  range, language ...) is excluded and hidden with `LLM: not eligible: <reason>`.
- **Calibration and deductions**: the prompt tells the AI to use the full 1-10 range (start from 10, deduct per concrete
  shortcoming) and to list every deduction as `deductions: [{points, reason}]`; the UI and the Fantastic/Good mails show
  them as "Why not 10?" (or "Perfect match"). The shown AI score is computed from the deductions (10 minus their sum, rounded to 0.5, 1..10; 1 when not eligible), so the score always matches its explanation; the model's own number is kept as `modelFitScore` when it differs.
- **Prompt version**: each assessment stores the `PROMPT_VERSION` it used; after a prompt change the queue assesses
  those listings again automatically.
- **Merge**: `llm` score = `fitScore` as an extra weighted parameter. A probability at or above `excludeThreshold`
  excludes the listing (overall 1, reason `LLM: likely Studentenverbindung (p=0.82): <signals>`; excluded listings are
  left out of the statistics). An LLM failure never breaks anything: the rule-based result stays and the error is
  stored and shown.
- **Skipped (no tokens spent)**: listings the rules already exclude (keyword, rent above the hard maximum) and listings
  without a description (`no description`; details failed or skipped).
- **Queue**: `wgg run` assesses the queue after the detail queue (serially, never touching WG-Gesucht, no fetch
  lock). `wgg llm [--limit N] [--ids 1,2] [--force]` runs it once (`--force` assesses finished listings again);
  `wgg details --ids 1,2` fetches the named listings (re-queues skipped or failed ones, ignores age and dismissal).
  `--ids` takes provider ids or row ids. `/api/status` reports `llm: {pending, done, failed, badgeThreshold}`.

## Email alerts

wgg mails you about good offers, but only **after the AI assessment** (an alert needs the scores of both the rules and
the AI). Two tiers, both configured under `notify:` in `config/wgg.yaml` (see `config/wgg.example.yaml`):

- **Fantastic** offers: one email for one listing, sent right after its AI assessment is stored (subject prefix
  "✦ Fantastic:"). Default: overall > 7 AND AI > 7. Config key `notify.priority`.
- **Good** offers: ONE digest email (a compact card per offer, best overall score first) once the bulk is done, that is
  when the detail queue and the AI queue have no work left after a fetch (also at the end of `wgg details` / `wgg llm`).
  Default: overall > 5 AND AI > 5. Listings already sent as Fantastic are not repeated; an empty digest is never sent.
  If a bot wall or backoff stops the queues, the digest waits for the next cycle. Config key `notify.bulk`; the subject is
  "N good offers — WG Gefunden!".

**Naming.** The names in the UI and in the mails are Fantastic (config `notify.priority`, `notified_kind = 'priority'`)
and Good (config `notify.bulk`, `notified_kind = 'bulk'`). The config keys and the stored values keep their old names, so
existing `config/wgg.yaml` files, saved settings and database rows keep working unchanged.

**Tiers and the filter.** Every listing has a tier per user: *Fantastic* when it matches your Fantastic rules, else
*Good* when it matches your Good rules, else none (`user_listings.tier`, `tier` field of `/api/listings`). It is
computed by the same function the mails use, so the dashboard filter "All | Good | Fantastic | Custom"
(`?tier=good|fantastic` on `/api/listings` and `/api/stats`) and your inbox never disagree. The tier needs a finished AI
assessment with your current AI settings and a listing that is not excluded; it ignores hiding and the age limit (those
only restrict emails), and is recomputed when the assessment is stored, when you change your alert rules or AI profile,
and for all rows at startup.

Only listings with a finished AI assessment (current prompt version), not excluded, not hidden (by you, by the program,
or marked Messaged) and posted (else first seen) within `notify.maxAgeHours` (default 24, so the old backlog is not
mailed) are ever announced.

**Setup.** Put the SMTP settings in `.env` (never in the YAML; `.env` is gitignored):

```sh
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_USER=you@example.org
SMTP_PASS=an-app-password
MAIL_FROM="WG Gefunden! <you@example.org>"
MAIL_TO=you@example.org
# SMTP_SECURE=true   # optional; by default TLS-on-connect is used for port 465 only (587 uses STARTTLS)
```

Many providers need an app password (an extra password for apps, created in the account's security settings) instead
of your normal login password, for example when two-factor authentication is on. Run `node bin/wgg.js test-mail`: it
sends one test email, or names the missing variables (never their values).

**Rules.** `rules` is a list; every rule is an object whose conditions must ALL hold (AND); the alert fires when ANY
rule matches (OR). A condition is `field: {operator: number}`:

- Fields: `overall` (rule-based score), `ai` (AI fit score), `rent` (EUR), `size` (m2), `distanceKm`,
  `verbindungProbability` (0..1). A listing without a value for a field never matches a condition on it.
- Operators: `gt`, `gte`, `lt`, `lte`, `eq` (several may be combined: `rent: {gte: 400, lt: 700}`).
- `rules: []` switches that kind of alert off. Mistakes are reported with their path, e.g.
  `notify.priority.rules[1].rent.gtt: unknown operator`.

```yaml
notify:
  priority: # the "Fantastic" offers
    rules:
      - { overall: { gt: 7 }, ai: { gt: 7 } }
      - { overall: { gt: 5 }, rent: { lt: 700 } } # OR: a fairly good, cheap room is Fantastic too
  bulk: # the "Good" offers
    rules:
      - { overall: { gt: 5 }, ai: { gt: 5 } }
```

**Dry run.** Without complete SMTP settings, with `notify.dryRun: true`, or with `--dry-run` (`wgg run --dry-run`,
`wgg notify --dry-run`), wgg only prints the full email ("would send": subject and plain text) and sends and marks
nothing, so real sending works as soon as SMTP is set up. `wgg notify --dry-run` shows what would go out right now.

**Never twice.** A listing is marked as announced (`notified_at`, `notified_kind` priority / bulk, shown as Fantastic / Good) in one atomic update
before the mail is sent. If sending fails, the mark is undone and the error is stored (`notify_error`); the next
trigger retries, at most 3 times per listing. The web UI shows "Fantastic alert sent · 14:32" or "In Good digest · 14:40".
`wgg notify` sends what is pending now (Fantastic mails, then the Good digest) without waiting for a fetch.

## License

MIT, see `LICENSE`. Copyright (c) 2026 Léo Brucker. A private, non-commercial project; not affiliated with WG-Gesucht.
