# Focus Orb

A small floating Pomodoro timer for Windows. A banded planet sits on top of your other windows with a moon circling it: the lit stretch of orbit is the time you have left, the moon is where you are now, and a bell tells you when the lap is done.

## Run it

You need [Node.js](https://nodejs.org) (LTS).

```
npm install
npm start
```

## Build an .exe

```
npm run dist
```

Output lands in `dist/`:

- `Focus-Orb-<version>-portable.exe` is a portable build. Copy it anywhere and run it. It does not update itself.
- `Focus-Orb-Setup-<version>.exe` is a one-click installer (per user, no admin rights). The installed copy updates itself.

The first build downloads Electron and the Windows packaging tools, so it needs internet and takes a minute or two.

### Built and checked on Windows, automatically

`.github/workflows/windows.yml` does all of this on a real Windows machine whenever the project is pushed to GitHub (a private repository is fine; the free plan includes 2,000 Actions minutes a month, and Windows minutes cost more than Linux ones):

1. installs exactly what `package-lock.json` lists, and runs every test;
2. runs `test/windows.test.js`: the real Windows calls the window watcher makes, the watcher itself, and start with Windows through the real registry;
3. builds the installer and the portable `.exe`;
4. starts the built app, reads its log, and fails if the app quit, the window watcher didn't start, or anything was logged as an error;
5. keeps both `.exe` files as downloads on the run's page for 30 days.

`test/packaging.test.js` checks that every file the app loads is in the build's file list. A file missing from that list leaves the built app unable to start, while every test run from the source folder still passes.

### The log

Settings…, About, Show log opens the folder holding `focus-orb.log`: start-up, the window watcher, the browser link, start with Windows, and anything that failed. It never holds window titles, addresses or what you were working on. It is capped at 512 KB, with one previous file kept.

## Using it

The right-click menu keeps to the things you reach for: start or pause, Finish session now, restart, skip, Stats (with today's count), a detour, the task profile, the theme, Settings…, Hide orb and Quit. Every line is kept short, because Windows sizes a menu to its longest line.

**Finish session now** ends a focus session early and counts it, with the minutes you actually spent, then starts the break as usual. During a break the same line reads End break now.

**Settings…** opens one window for everything else, in sections: Timer, Distraction, Alerts, Orb, Keyboard and About. Changes save as you make them. The last session's summary is at the top of Stats, and the version and data folder are under About.

The daily count above the orb and the cycle dots below it are drawn in the orb's own colour on a small dark pill, so they read on a white page as well as a dark one.

| Action | What it does |
| --- | --- |
| Click the orb | Start, pause or resume |
| Drag the orb | Move it (position is remembered) |
| Right-click | Menu: pause, finish, restart, skip, stats, detour, profile, theme, settings |
| Ctrl+Alt+P | Start or pause from anywhere |
| Tray icon | Click to hide or show the orb; right-click for the same menu |

The planet is tomato red for focus, mint for a short break and violet for the long one. The moon passes behind the planet over the top of its orbit and in front underneath.

Defaults are 25 minutes of focus, a 5 minute break, and a 15 minute break after every fourth session. Breaks start by themselves; the next focus session waits for a click. Both are switchable under Settings, Timer.

Skipping a session doesn't count it, and never earns a long break.

## Distraction nudges

While a focus session is running, the orb watches three things and turns the glow and orbit amber when you drift. It rings a few soft notes (three by default; 0 to 8 under Settings, Distraction) and puts a specific hint under the time ("Off task: youtube"). It also raises a Windows notification when a drift starts (Settings, Alerts). If it stays amber it nudges again after 90 s by default (Settings, Distraction, Nudge again). Windows Focus Assist / Do Not Disturb can hide the notification; the glow and dings still work. It never pauses the timer; that part is up to you.

| Signal | What counts |
| --- | --- |
| Off task | The window in front matches your profile's Block list, or isn't on its Allow list (if it has one), for longer than the grace period (20 s by default) |
| Switching | Too many app or browser-tab changes in a minute (Normal is 12) |
| Away | No keyboard or mouse input for a while (2 min by default) |

Short hops don't count. Neither does the shell, the lock screen or the orb itself.

Each kind of work gets a profile (a list on the left, the rules on the right; the title bars follow dark mode): General, Coding and Writing to start with, all editable under Right-click, Task profile, Edit profiles. The editor shows the last window you used and whether it counts, with one-click Allow and Block buttons. Under it, Recent windows lists the last dozen windows the orb saw and how it judged each (kept in memory only, gone when the app closes), which is the quickest way to see why something counted. Click a line for Allow site, Block site, Allow app or Block app; the rule goes into the profile you are editing, and rules already there are shown but greyed out. Rules are one per line: a plain word matches the app name or window title, `app:code` matches the app name exactly, `title:inbox` matches the title only. Block beats allow.

At the end of a focus session the notification adds a one-line summary, for example "81% on task. Drifted twice, longest 4 min on reddit." On-task time is counted from the first second off task, but a drift only after the grace period, so a session can read "99% on task. No drifting, 15 s in short hops." The last one is also at the top of Stats.

What it does and doesn't do with your data:

- It reads the title and app name of the window in front, once a second, by asking Windows directly (through koffi, a small library for calling Windows functions). No extra process.
- Nothing is sent anywhere. Window titles aren't saved or logged. Only counts and one short label per drift are kept for the current session, plus the last summary line.
- When no window has focus it says so rather than keeping the last one, and it repeats itself every 5 s. If it goes quiet for 15 s the orb stops judging and restarts it. Waking from sleep doesn't count as quiet.
- If those calls can't be set up, the window watcher reports "unavailable" in the menu, the log says why, and the orb carries on with idle detection only.

## Everything else it does

**Allow a detour.** Right-click, Allow a detour, 5 to 30 minutes. For when the YouTube tutorial really is the work. Nothing is judged or nudged until it runs out, and the orb tells you how long is left. It's counted separately in the summary, so it doesn't flatter your on-task figure.

**Calls.** Teams, Zoom, Webex and Slack huddles, plus Meet, Zoom and Teams in a browser, are recognised and never judged, from the first second. Sitting silently in a call isn't "away" either. Under Distraction, Calls, you can instead have the orb pause the timer during a call; it tells you when the call ends and leaves the timer for you to restart. Detection goes by window title and, with the browser link, by address, so treat it as a good guess. The detour is the fallback.

**Lock and sleep.** Locking the screen or sleeping the machine pauses a running focus session. Come back within three minutes and it carries on by itself; stay away longer and it waits for you. Breaks are left to run. Switch it off under Settings, Distraction.

**What are you working on?** When you start a focus session yourself, a one-line prompt appears beside the orb. Enter sets it, Esc skips, and it goes away after 15 seconds either way. The timer never waits for it. The text shows in the tray tooltip and in your history, and a matching profile is picked automatically: "coding the settings page" selects Coding, "write the report" selects Writing (it matches the start of the profile name). It doesn't appear when focus sessions start automatically. Switch it off under Settings, Distraction.

**Daily goal.** A small counter above the planet ("3/6"). It turns the accent colour and says "done" when you get there, and the end-of-session notification mentions it once. Change or remove it under Settings, Timer.

**Stats.** Right-click, Stats. Today and this week, your streak, a week in review (this week against last, the time of day you focus best over the last four weeks, and what cost you most this week), the average on-task figure, a 14-day chart (click a day to see it in full: its totals, what pulled you away, and every session with its own drifts, away and detour time), the things that pulled you away most, and your latest sessions. Export CSV writes every session to a file you choose (opens cleanly in Excel; text that could be read as a spreadsheet formula is neutralised). History is kept locally and capped at 5,000 sessions.

**Browser link (optional, off by default).** Window titles only go so far, so there is a small Chrome and Edge extension that reports the address of your active tab. It enables rules like `url:x.com` (the site and its subdomains, not lookalikes) or `url:github.com/some-org`, and the profile editor then offers Allow this site and Block this site. To set it up: Right-click, Settings…, Distraction, Browser link, Set up…, turn it on, press Open extension folder, then in `edge://extensions` or `chrome://extensions` switch on Developer mode and Load unpacked.

**Block sites during focus (optional, off by default).** With the browser link on, Settings…, Distraction, Block sites during focus turns away anything on the active profile's block list while a focus session is running. The tab goes to a page that says which rule caught it and counts down to the end of the session, with Back or Close tab, and Try again. Nothing is blocked while paused, during a detour, or on a break: Allow a detour and then Try again is the way through. Only site rules count (`youtube`, `url:x.com`, `title:…`); `app:` rules are about windows and are left out, so `app:msedge` can't shut every page. New addresses are checked as they open, in any tab, so a blocked page barely shows. A site already open when focus starts is caught at the next report, which is when you switch to it or within 30 seconds.

**Sharing profiles.** In the profile editor, Export this one… and Export all… write a small `.json` file (names, rules and any timings). Import profiles… adds from such a file. It never overwrites: a clashing name becomes "Name (imported)", identical profiles are skipped, the limit is 20, and your active profile never changes.

**Themes.** Right-click, Theme, or Settings, Orb. Planets: Ember (default), Ocean, Aurora, Dusk, Graphite, Plasma core and Liquid (a glass sphere that drains as the session runs). Other things:

| Theme | What shows the time | When you drift |
| --- | --- | --- |
| Tomato | A shadow sweeps round it. Green for a short break, gold for a long one | An amber outline |
| Hourglass | Sand runs down, and it turns over when a phase ends | The glass and the falling sand turn amber |
| Candle | It burns down. Unlit until you start, low while paused | The flame gutters |
| Ensō | A brush circle draws itself, led by a coloured seal | The ink and seal warm to amber |
| Seedling | It grows a leaf every few minutes and flowers at the end. Breaks show it in flower | The leaves droop |
| Ring | A plain ring of the time left | The ring turns amber and pulses |
| Lava lamp | The light in the base runs down; the blobs only move while the timer does | The blobs turn amber |
| Tea | You drink it down while you focus; a break pours it again, with steam | The tea and cup warm to amber |
| Coffee | A layered latte in a glass mug: foam, milk and espresso sink together as you drink it down; a break pours another, with steam | The foam sloshes and the glass warms to amber |

Future:

| Theme | What shows the time | When you drift |
| --- | --- | --- |
| Reactor Core | 40 cells round the core power down one by one; the inner rings counter-rotate | The core flickers amber |
| Hologlobe | A satellite makes one orbit per session round a turning wireframe globe | The projection glitches |
| Hex Shield | The shield charges from the bottom up; a break shows it full | Cracks flash across it |
| Warp Gate | A gold ring round the gate; breaks drop out of warp to a starfield | The tunnel wobbles and speeds up |
| Dyson Sphere | A solar panel joins the shell every minute and a half; breaks show it closed and glowing | A panel drifts loose |

Each theme has its own end-of-session sound (a kitchen timer, wood blocks, a singing bowl, a gong, plucks, two clean tones, a wobble, a spoon on china, a café counter bell), and choosing a theme plays it once.

**Timings per profile.** A profile can have its own focus and break lengths (Edit profiles, Timings for this profile). Blank means the usual ones from the Timing menu. They apply while that profile is in use; picking a profile in the "what are you working on?" prompt within the first minute of a session also retimes that session.

**Quick block and allow.** The right-click menu offers one line for the last real window you used, for the profile in use: Block it if it counts as on task, Stop blocking it if a Block rule caught it, or Allow it if your Allow list left it out. Browsers only get a line when the browser link knows the site, so you never block the whole browser by accident.

**Keyboard shortcuts.** Ctrl+Alt+P start or pause, Ctrl+Alt+R restart the session, Ctrl+Alt+N skip to next, Ctrl+Alt+D a 10-minute detour (again to end it), Ctrl+Alt+O show or hide the orb. All but the first can be switched off under Settings, Keyboard, which also says if another app already has one.

**Full-screen apps.** While a game, a full-screen video or a slideshow fills the screen, the orb hides, and it comes back without taking focus when that ends. A maximised window doesn't count. Switch it off under Settings, Orb.

**Start with Windows.** Settings…, Orb. The switch shows whether Windows will start Focus Orb when you sign in, whichever copy that is. The portable `.exe` has its version in its name, so a newer copy lives at a different path from the one you switched it on in. When the orb starts and finds Windows set to start a different copy, it points the entry at itself, so the switch and Windows agree and you never get an old version at sign-in. An entry switched off in Task Manager's Startup apps counts as off, and is left alone.

**Hide for chosen apps.** Under Settings, Orb, Also hide for these apps, add any app the orb should get out of the way for, such as OBS or a video player. It hides while that app is the window in front, full screen or not, and comes back when you switch away. Add app… lists the apps you've used lately (since the orb started), or type the name Windows gives it, like `obs64`. This works whether or not full-screen hiding is on.

**Start-up check.** If the window watcher isn't running, the browser link couldn't start, or you've been in a browser for a while without the extension reporting in, the orb says so once per launch and puts a warning line at the top of its menu.

**Clicking around the orb.** The window is a fixed, transparent square. Its shape is cut to a disc 100 px from the orb's centre (the glow fades out inside that) plus the ring, so the corners and everything beyond clicks go straight to whatever is underneath. Nothing polls or hooks the mouse (Electron's mouse-forwarding option installs a system-wide hook on Windows and can make the cursor stutter). If a platform refuses the shape, the app falls back to checking the pointer 25 times a second. The page is always kept at 100% zoom, because the shape assumes it. Changing the size (Orb, Size) scales the orb inside the window; the window itself is never resized.

## Updating

**Automatic (installed copy).** Shortly after it starts, and every 4 hours, the installed app asks the public `Nado306/Focus-Orb-releases` repository for a newer version. If there is one, it downloads it in the background and installs it when you quit, or straight away if you choose Restart to update from the orb's menu. It never restarts on its own, so a focus session is never cut short. Settings…, About shows where it stands, with Check now; the switch there turns checking off. This is the only time the app contacts anything beyond your own computer.

Until the app is code-signed, it can't check that an update really came from you: it trusts GitHub's HTTPS and the release page. Signing it closes that gap.

**Releasing a version.** Bump `version` in `package.json`, commit, and push a matching tag (`v1.9.0`). The Windows workflow tests and builds as usual and then publishes the installer, the portable `.exe` and `latest.yml` to `Focus-Orb-releases`. It needs a repository secret, `RELEASES_TOKEN`: a fine-grained GitHub token with Contents: Read and write on `Focus-Orb-releases` only. The source repository stays private.

**By hand.** 
install the new version over the old one with the installer, or replace the portable `.exe`. Settings and history live in `%APPDATA%\focus-orb` and are kept. With the browser link on, the app rewrites the extension's files on launch and the extension reloads itself once when it sees a newer version. Moving from 1.0.0 needs one manual Reload of the extension in `edge://extensions`.

Edge shows "Disable developer mode extensions" at every launch for any unpacked extension; that can't be switched off. The real fix is publishing the extension to the Edge Add-ons store (unlisted), which needs a pairing step in place of the config file. Not built.

When you click to another page, the window title changes a moment before the extension reports the new address. The orb waits up to three seconds for it rather than judging the page on its title alone, so moving around an allowed site never counts as off task. If no address arrives, the title is used.

How it's kept contained:

- The orb listens only on `127.0.0.1`. A secret generated on your machine is copied into the extension's folder, and it never crosses the wire: before sending anything, the extension asks whoever is listening to prove they know it, then signs each request with it, and acts only on replies the app has signed. So a program that grabbed the port while the orb was closed learns neither the secret nor your tabs, and can't make the extension block anything. Signed requests more than five minutes old are refused. A web page can't use it: requests that carry a web origin are refused, and so are requests addressed to any name but `127.0.0.1` or `localhost` (which stops a site re-pointing its own domain at your computer).
- The extension is allowed to contact `127.0.0.1` and nothing else. It does need permission to read tab addresses, which your browser will say out loud.
- The orb keeps tab addresses in memory for matching and never writes them to disk. When a drift is in a browser, session history records the site's name (such as `youtube.com`), never the full address.
- "Make a new secret" re-keys it; reload the extension afterwards.

Settings are in `%APPDATA%\focus-orb\settings.json` and session history is in `sessions.json` beside it.

## Security

- The app's windows only ever show its own pages. Each page runs sandboxed, with no access to Node or the file system, under a content security policy that allows no network access and no inline scripts. Navigating away, pop-ups, embedded web views and browser permissions (camera, microphone, location, notifications) are all refused, for every window.
- Each window can only use its own messages to the app; one window can't drive another's.
- The window watcher makes a few read-only Windows calls from inside the app (`winapi.js`): which window is in front, its title, its program, its size. It starts no other process, so there is no hidden PowerShell for security software to flag.
- Address rules with a path, such as `url:github.com/some-org`, match that site and path only: not another site that mentions it in its address, and not a lookalike such as `evilgithub.com`.
- The built app has Electron's run-as-Node, `NODE_OPTIONS` and debugger switches turned off. It also checks its own code against a fingerprint baked into the `.exe`, and won't start if that code has been altered.
- Besides Electron, the app ships two third-party packages: koffi (MIT licence, no dependencies of its own) for the window watcher's Windows calls, and electron-updater (MIT, from the electron-builder project) for updates. `npm audit --omit=dev` reports nothing against either. CSV exports guard against spreadsheet formulas.
- The `.exe` isn't code-signed, so Windows SmartScreen warns on first run.

## How it's put together

| File | Job |
| --- | --- |
| `engine.js` | The timer state machine and the moon's orbit maths. No DOM, no Electron. Timestamp-based, so it doesn't drift if the machine sleeps |
| `main.js` | Window, tray, menu, settings, global shortcut, dragging, distraction polling |
| `distraction.js` | Rules, the classifier, the drift tracker, call detection, break watching and the summary wording. Pure logic, fully tested |
| `stats.js` | Session history, streaks, aggregates and CSV. Pure logic |
| `bridge.js`, `extension/` | The browser link: a small localhost listener and the Chrome and Edge extension |
| `log.js` | The rolling log |
| `updater.js` | Automatic updates: when to check, and what Settings says |
| `startup.js` | Start with Windows: reads and writes the start-up entries |
| `watcher.js`, `winapi.js` | The foreground-window watcher, and the Windows calls it makes |
| `settings.*`, `profiles.*`, `stats.html`, `stats-ui.js`, `intent.*`, `extension.*`, `preload-*.js` | The profile editor, stats, intent prompt and browser-link windows |
| `preload.js` | The small, explicit bridge between the two |
| `index.html`, `style.css`, `themes-art.css`, `themes-future.css`, `renderer.js` | The planet, orbit and moon, the other themes, and the synthesised chimes |

`npm test` runs the timer, distraction, stats, browser-link and window-watcher tests, plus a smoke test that loads the real `main.js` against a stubbed Electron and drives it through a session.
