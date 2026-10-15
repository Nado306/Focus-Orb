/*
 * Distraction logic: no Electron, no DOM, no clock of its own.
 *
 *   rules + profile + foreground window  ->  classify()  ->  on | off | neutral
 *   classified samples over time          ->  tracker     ->  status, nudges, summary
 *
 * Everything here is local and in memory. Window titles are looked at, never
 * stored: the tracker keeps counts and one short label per drift episode.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Distraction = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

  /* ---------- rules ---------- */

  // "reddit"        matches the app name, the window title, or (if known) the page address
  // "app:code"      matches the app name exactly (code.exe, Code, CODE)
  // "title:inbox"   matches the window title only
  // "url:x.com"     matches the site (x.com and its subdomains); needs the browser extension
  // "url:github.com/myorg"  matches part of an address
  function parseRule(raw) {
    const text = norm(raw);
    if (!text) return null;
    let scope = 'any';
    let needle = text;
    if (text.startsWith('app:')) {
      scope = 'app';
      needle = text.slice(4).trim();
    } else if (text.startsWith('title:')) {
      scope = 'title';
      needle = text.slice(6).trim();
    } else if (text.startsWith('url:')) {
      scope = 'url';
      needle = text.slice(4).trim();
    }
    if (!needle) return null;
    return { scope, needle, raw: text };
  }

  function urlHost(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function urlMatches(needle, url) {
    if (!url) return false;
    const n = String(needle).replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!n) return false;
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return false;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const onHost = (h) => host === h || host.endsWith(`.${h}`);
    if (n.includes('/')) {
      // site and path: the site must be that site (or a subdomain), and the address must
      // start with that path there, so "github.com/my-org" never matches another site
      // that merely mentions it, or a lookalike such as evilgithub.com
      const cut = n.indexOf('/');
      const h = n.slice(0, cut);
      const rest = n.slice(cut).toLowerCase();
      const at = `${u.pathname}${u.search}`.toLowerCase();
      if (!h || !onHost(h) || !at.startsWith(rest)) return false;
      // "my-org" is a whole name: not the start of "my-organisation"
      return !/[a-z0-9]$/.test(rest) || at.length === rest.length || !/[a-z0-9_-]/.test(at[rest.length]);
    }
    if (n.includes('.')) return onHost(n);
    return host.includes(n);
  }

  function matches(rule, win) {
    const app = norm(win.process).replace(/\.exe$/, '');
    const title = norm(win.title);
    if (rule.scope === 'app') return app === rule.needle.replace(/\.exe$/, '');
    if (rule.scope === 'title') return title.includes(rule.needle);
    if (rule.scope === 'url') return urlMatches(rule.needle, win.url);
    return app.includes(rule.needle) || title.includes(rule.needle) || norm(win.url).includes(rule.needle);
  }

  // Windows that say nothing about what you're doing: the shell, the lock
  // screen, and the orb's own windows.
  const NEUTRAL_APPS = new Set([
    'explorer',
    'searchhost',
    'searchapp',
    'shellexperiencehost',
    'startmenuexperiencehost',
    'lockapp',
    'logonui',
    'textinputhost',
  ]);

  // Block wins over allow. If a profile has allow rules, anything that matches
  // none of them is off task. With no allow rules, anything not blocked is on.
  function classify(win, profile, opts) {
    if (!win) return { cls: 'neutral', rule: null, why: 'no-window' };
    const app = norm(win.process).replace(/\.exe$/, '');
    if (opts && opts.selfPid && win.pid === opts.selfPid) return { cls: 'neutral', rule: null, why: 'self' };
    if (NEUTRAL_APPS.has(app) || !norm(win.title)) return { cls: 'neutral', rule: null, why: 'system' };

    const block = ((profile && profile.block) || []).map(parseRule).filter(Boolean);
    const allow = ((profile && profile.allow) || []).map(parseRule).filter(Boolean);

    const b = block.find((r) => matches(r, win));
    if (b) return { cls: 'off', rule: b.raw, why: 'block' };

    if (allow.length) {
      const a = allow.find((r) => matches(r, win));
      return a ? { cls: 'on', rule: a.raw, why: 'allow' } : { cls: 'off', rule: null, why: 'not-allowed' };
    }
    return { cls: 'on', rule: null, why: 'default' };
  }

  // A short human label for "what was I distracted by": the rule that caught it, the
  // site for a browser tab (when the browser link knows the address), or the app.
  const BROWSER_NAMES = { msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', arc: 'Arc' };
  function labelFor(win, result) {
    if (result && result.why === 'block' && result.rule) {
      return result.rule.replace(/^(app|title|url):/, '');
    }
    const app = norm(win && win.process).replace(/\.exe$/, '');
    if (BROWSERS.has(app)) return urlHost(win && win.url) || BROWSER_NAMES[app] || app;
    return app || 'another window';
  }

  /* ---------- profiles ---------- */

  const SOCIAL = [
    'youtube', 'reddit', 'facebook', 'instagram', 'tiktok', 'netflix', 'twitch', 'twitter',
    'url:x.com', 'title:home / x', 'app:steam',
  ];

  const DEFAULT_PROFILES = [
    { id: 'general', name: 'General', allow: [], block: SOCIAL.slice() },
    {
      id: 'coding',
      name: 'Coding',
      allow: [
        'app:code', 'app:windowsterminal', 'app:powershell', 'app:pwsh', 'app:cmd', 'app:devenv',
        'github', 'stackoverflow', 'localhost', 'developer.mozilla', 'npmjs', 'docs',
      ],
      block: SOCIAL.slice(),
    },
    {
      id: 'writing',
      name: 'Writing',
      allow: ['app:winword', 'app:notepad', 'app:notion', 'app:obsidian', 'app:code', 'docs'],
      block: SOCIAL.slice(),
    },
  ];

  const slug = (s) =>
    norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'profile';

  function cleanRules(list) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((r) => {
      const t = norm(r).slice(0, 80);
      if (t && !seen.has(t) && out.length < 100) {
        seen.add(t);
        out.push(t);
      }
    });
    return out;
  }

  // Accepts anything, returns a valid, non-empty list with unique ids.
  // Optional timings for a profile. Anything missing or out of range falls back to the global setting.
  const TIMING_RANGE = { focus: [5, 180], short: [1, 60], long: [1, 90] };
  function cleanTiming(t) {
    if (!t || typeof t !== 'object') return null;
    const out = {};
    Object.keys(TIMING_RANGE).forEach((k) => {
      const v = Math.round(Number(t[k]));
      const [lo, hi] = TIMING_RANGE[k];
      if (Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  function sanitiseProfiles(list) {
    const out = [];
    const ids = new Set();
    (Array.isArray(list) ? list : []).forEach((p) => {
      if (!p || typeof p !== 'object' || out.length >= 20) return;
      const name = String(p.name == null ? '' : p.name).trim().slice(0, 40);
      if (!name) return;
      let id = slug(p.id || name);
      let n = 2;
      while (ids.has(id)) id = `${slug(p.id || name).slice(0, 20)}-${n++}`;
      ids.add(id);
      const clean = { id, name, allow: cleanRules(p.allow), block: cleanRules(p.block) };
      const timing = cleanTiming(p.timing);
      if (timing) clean.timing = timing;
      out.push(clean);
    });
    return out.length ? out : JSON.parse(JSON.stringify(DEFAULT_PROFILES));
  }

  /* ---------- sharing profiles ---------- */

  const PROFILE_FILE = 'focus-orb-profiles';
  const MAX_PROFILE_FILE = 200000;
  const MAX_PROFILES = 20;

  // Ids are left out on purpose: an import should never overwrite anything.
  function exportProfiles(profiles, ids) {
    const list = sanitiseProfiles(profiles)
      .filter((p) => !ids || ids.includes(p.id))
      .map((p) => (p.timing ? { name: p.name, allow: p.allow, block: p.block, timing: p.timing } : { name: p.name, allow: p.allow, block: p.block }));
    return `${JSON.stringify({ format: PROFILE_FILE, version: 1, profiles: list }, null, 2)}\n`;
  }

  // Reads a file someone else may have written. Never throws.
  function parseProfilesFile(text) {
    if (typeof text !== 'string' || text.length > MAX_PROFILE_FILE) return { ok: false, error: 'too-big' };
    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      return { ok: false, error: 'not-json' };
    }
    const list = data && data.format === PROFILE_FILE && Array.isArray(data.profiles) ? data.profiles : null;
    if (!list) return { ok: false, error: 'not-profiles' };
    const clean = list
      .filter((p) => p && typeof p === 'object' && String(p.name == null ? '' : p.name).trim())
      .slice(0, MAX_PROFILES)
      .map((p) => {
        const out = { name: String(p.name).trim().slice(0, 40), allow: cleanRules(p.allow), block: cleanRules(p.block) };
        const timing = cleanTiming(p.timing);
        if (timing) out.timing = timing;
        return out;
      });
    return clean.length ? { ok: true, profiles: clean } : { ok: false, error: 'empty' };
  }

  const sameRules = (a, b) => JSON.stringify(cleanRules(a)) === JSON.stringify(cleanRules(b));

  // Adds incoming profiles without touching what's there. An identical copy is
  // skipped; a different profile with a taken name gets "(imported)" added.
  function mergeProfiles(existing, incoming) {
    const out = sanitiseProfiles(existing);
    const taken = () => new Set(out.map((p) => norm(p.name)));
    const res = { added: 0, skipped: 0, renamed: 0, full: 0 };
    (incoming || []).forEach((p) => {
      const stem = norm(p.name);
      const copyOf = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(imported( \\d+)?\\)$`);
      const dupe = out.find((q) => norm(q.name) === stem);
      // already have it, under its own name or as an earlier "(imported)" copy
      const have = out.some((q) => (norm(q.name) === stem || copyOf.test(norm(q.name))) && sameRules(q.allow, p.allow) && sameRules(q.block, p.block));
      if (have) {
        res.skipped += 1;
        return;
      }
      if (out.length >= MAX_PROFILES) {
        res.full += 1;
        return;
      }
      let name = p.name;
      if (dupe) {
        let n = 1;
        do {
          name = `${p.name.slice(0, 28)} (imported${n > 1 ? ` ${n}` : ''})`;
          n += 1;
        } while (taken().has(norm(name)));
        res.renamed += 1;
      }
      out.push({ id: slug(name), name, allow: cleanRules(p.allow), block: cleanRules(p.block), timing: p.timing });
      res.added += 1;
    });
    return { profiles: sanitiseProfiles(out), ...res };
  }

  /* ---------- tracker ---------- */

  const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']);

  const DEFAULT_TRACK = {
    graceMs: 20000, // off task this long before it counts
    idleMs: 120000, // no input this long means away (0 = off)
    switchLimit: 12, // window switches per minute that count as thrashing (0 = off)
    switchWindowMs: 60000,
    repeatMs: 90000, // minimum gap between nudges
    recoverMs: 3000, // on task this long ends a drift episode
  };

  const MAX_STEP_MS = 5000; // a sleep or pause never counts as watched time

  function createTracker(options) {
    const o = Object.assign({}, DEFAULT_TRACK, options);
    let s;

    function fresh() {
      return {
        last: null,
        onMs: 0,
        offMs: 0,
        neutralMs: 0,
        awayMs: 0,
        snoozeMs: 0,
        meetingMs: 0,
        key: '',
        proc: '',
        switches: [],
        offStreak: 0,
        onSince: null,
        episode: null,
        episodes: [],
        thrashing: false,
        thrashEpisodes: 0,
        lastNudgeAt: -Infinity,
        awayNudged: false,
      };
    }
    s = fresh();

    function setOptions(next) {
      Object.assign(o, next);
    }

    function reset() {
      s = fresh();
    }

    // Forget the previous timestamp so a pause isn't counted as watched time.
    function hold() {
      s.last = null;
    }

    function sample(t, input) {
      const win = input.win || null;
      const result = input.result || { cls: 'neutral' };
      const idleSec = Number(input.idleSec) || 0;
      const dt = s.last == null ? 0 : Math.min(Math.max(0, t - s.last), MAX_STEP_MS);
      s.last = t;
      let nudge = null;

      // a call, or a detour you asked for: nothing is judged, nothing is nudged
      if (input.meeting || input.snoozed) {
        s.proc = norm(win && win.process).replace(/\.exe$/, '');
        s.key = `${s.proc}|${norm(win && win.title)}`;
        s.awayNudged = false;
        if (input.meeting) {
          s.meetingMs += dt;
          return { status: 'meeting', reason: 'meeting', label: '', nudge: null };
        }
        s.snoozeMs += dt;
        s.offStreak = 0;
        s.onSince = null;
        s.episode = null;
        s.thrashing = false;
        s.switches = [];
        return { status: 'snoozed', reason: 'snoozed', label: '', nudge: null };
      }

      // away: no input for a while. Nothing else is judged meanwhile.
      if (o.idleMs > 0 && idleSec * 1000 >= o.idleMs) {
        s.awayMs += dt;
        if (!s.awayNudged) {
          s.awayNudged = true;
          nudge = { reason: 'away', label: '' };
        }
        return { status: 'away', reason: 'away', label: '', nudge };
      }
      s.awayNudged = false;

      const cls = result.cls;
      if (cls === 'on') s.onMs += dt;
      else if (cls === 'off') s.offMs += dt;
      else s.neutralMs += dt;

      // window switching: a change of app, or a tab change inside a browser.
      // Terminals retitle themselves constantly, so title changes elsewhere don't count.
      const proc = norm(win && win.process).replace(/\.exe$/, '');
      const key = `${proc}|${norm(win && win.title)}`;
      if (key !== s.key) {
        const hadWindow = s.key !== '';
        const switched = proc !== s.proc || BROWSERS.has(proc);
        if (hadWindow && switched && cls !== 'neutral') s.switches.push(t);
        s.key = key;
        s.proc = proc;
      }
      s.switches = s.switches.filter((x) => t - x <= o.switchWindowMs);
      const thrash = o.switchLimit > 0 && s.switches.length >= o.switchLimit;

      // off task
      const label = labelFor(win, result);
      if (cls === 'off') {
        s.offStreak += dt;
        s.onSince = null;
        if (s.offStreak >= o.graceMs) {
          if (!s.episode) {
            s.episode = { label, ms: s.offStreak, now: label, by: {} };
            s.episodes.push(s.episode);
          }
          s.episode.ms = s.offStreak;
          // The episode is named for where most of it went, but the orb shows where you are now.
          s.episode.now = label;
          s.episode.by[label] = (s.episode.by[label] || 0) + dt;
          if (s.episode.by[label] > (s.episode.by[s.episode.label] || 0)) s.episode.label = label;
          if (t - s.lastNudgeAt >= o.repeatMs) {
            nudge = { reason: 'off-topic', label };
            s.lastNudgeAt = t;
          }
        }
      } else if (cls === 'on') {
        if (s.onSince == null) s.onSince = t;
        if (t - s.onSince >= o.recoverMs) {
          s.offStreak = 0;
          s.episode = null;
        }
      }

      // switching too much
      if (thrash) {
        if (!s.thrashing) {
          s.thrashing = true;
          s.thrashEpisodes += 1;
        }
        if (!nudge && t - s.lastNudgeAt >= o.repeatMs) {
          nudge = { reason: 'switching', label: '' };
          s.lastNudgeAt = t;
        }
      } else {
        s.thrashing = false;
      }

      if (s.episode) return { status: 'drifting', reason: 'off-topic', label: s.episode.now || s.episode.label, nudge };
      if (thrash) return { status: 'drifting', reason: 'switching', label: '', nudge };
      return { status: 'ok', reason: null, label: '', nudge };
    }

    function summary() {
      const tracked = s.onMs + s.offMs;
      const longest = s.episodes.reduce((a, e) => (!a || e.ms > a.ms ? e : a), null);
      return {
        onPct: tracked > 0 ? Math.round((100 * s.onMs) / tracked) : null,
        onMs: s.onMs,
        offMs: s.offMs,
        neutralMs: s.neutralMs,
        awayMs: s.awayMs,
        snoozeMs: s.snoozeMs,
        meetingMs: s.meetingMs,
        distractions: s.episodes.map((e) => ({ label: e.label, ms: e.ms })),
        offEpisodes: s.episodes.length,
        thrashEpisodes: s.thrashEpisodes,
        drifts: s.episodes.length + s.thrashEpisodes,
        longest: longest ? { ms: longest.ms, label: longest.label } : null,
      };
    }

    return { sample, summary, reset, hold, setOptions };
  }

  /* ---------- words ---------- */

  function duration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} s`;
    return `${Math.round(sec / 60)} min`;
  }

  const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

  function describe(sum) {
    if (!sum) return '';
    const watched = sum.onMs + sum.offMs + sum.neutralMs + sum.awayMs + (sum.snoozeMs || 0) + (sum.meetingMs || 0);
    if (watched < 10000) return '';
    const parts = [];
    if (sum.onPct != null) {
      parts.push(`${sum.onPct}% on task.`);
      if (sum.drifts === 0) {
        // Off-task time counts from the first second, a drift only after the grace period,
        // so a few quick looks can cost a percent without ever being a drift. Say so.
        const hops = Math.round((sum.offMs || 0) / 1000) * 1000;
        parts.push(hops >= 1000 ? `No drifting, ${duration(hops)} in short hops.` : 'No drifting.');
      }
    }
    if (sum.offEpisodes > 0) {
      let t = `Drifted ${times(sum.offEpisodes)}`;
      if (sum.longest) t += `, longest ${duration(sum.longest.ms)} on ${sum.longest.label}`;
      parts.push(`${t}.`);
    }
    if (sum.thrashEpisodes > 0) parts.push(`Window-hopping got flagged ${times(sum.thrashEpisodes)}.`);
    if ((sum.meetingMs || 0) >= 60000) parts.push(`On calls for ${duration(sum.meetingMs)}.`);
    if ((sum.snoozeMs || 0) >= 60000) parts.push(`Detour: ${duration(sum.snoozeMs)}.`);
    if (sum.awayMs >= 30000) parts.push(`Away for ${duration(sum.awayMs)}.`);
    return parts.join(' ');
  }

  /* ---------- watcher output ---------- */

  // Feed it raw chunks from the watcher process; it calls back once per
  // complete JSON line. Tolerates split chunks, blank lines, junk and a BOM.
  function createLineParser(onWindow) {
    let buf = '';
    return function feed(chunk) {
      buf += String(chunk);
      if (buf.length > 100000) buf = '';
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\uFEFF/, '').trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o && typeof o === 'object') {
            onWindow({ title: String(o.title == null ? '' : o.title), process: String(o.process == null ? '' : o.process), pid: Number(o.pid) || 0, fs: o.fs === true });
          }
        } catch (e) {
          /* not ours; ignore */
        }
      }
    };
  }

  /* ---------- meetings ---------- */

  const isBrowser = (proc) => BROWSERS.has(norm(proc).replace(/\.exe$/, ''));

  // Best-effort: calls in Teams, Zoom, Webex, Slack huddles, and Meet/Zoom/Teams
  // in a browser. Window titles vary by version, so treat this as a good guess.
  function isMeeting(win) {
    if (!win) return false;
    const app = norm(win.process).replace(/\.exe$/, '');
    const title = norm(win.title);
    const host = urlHost(win.url);
    const path = (() => {
      try {
        return new URL(win.url).pathname.toLowerCase();
      } catch (e) {
        return '';
      }
    })();

    if (app === 'zoom') return /zoom meeting|zoom webinar/.test(title);
    // Teams: meetings and calls, plus the ringing pop-up before you answer
    if (app === 'teams' || app === 'ms-teams' || app === 'msteams') {
      return /meeting|\bcall\b|calling|incoming|ringing/.test(title) || title === 'microsoft teams notification';
    }
    if (app.startsWith('webex')) return title.includes('meeting');
    if (app === 'slack') return title.includes('huddle');
    if (BROWSERS.has(app)) {
      if (host === 'meet.google.com') return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(path);
      if (/(^|\.)zoom\.us$/.test(host)) return path.startsWith('/wc/') || path.startsWith('/j/');
      if (host === 'teams.microsoft.com' || host === 'teams.live.com') return /meetup-join|meeting/.test(`${path}${title}`);
      if (!host) return /^meet - [a-z]{3}-[a-z]{4}-[a-z]{3}/.test(title);
    }
    return false;
  }

  /* ---------- breaks: are you actually taking one? ---------- */

  /* ---------- browser tabs ---------- */

  // The browser extension reports (tab title, address). The foreground window
  // only tells us its title, which contains the tab's title, so we match on that.
  function createTabIndex(max) {
    const limit = max || 30;
    const maxAgeMs = 12 * 3600 * 1000;
    let list = [];
    return {
      report(url, title, at) {
        const t = norm(title);
        const when = at || Date.now();
        list = list.filter((r) => !(r.title === t && r.url === url) && when - r.at < maxAgeMs);
        list.unshift({ url: String(url), title: t, at: when });
        if (list.length > limit) list.length = limit;
      },
      lookup(windowTitle) {
        const wt = norm(windowTitle);
        let best = null;
        list.forEach((r) => {
          if (r.title.length >= 3 && wt.includes(r.title) && (!best || r.title.length > best.title.length)) best = r;
        });
        return best ? best.url : null;
      },
      latest() {
        return list.length ? { host: urlHost(list[0].url), at: list[0].at } : null;
      },
    };
  }

  /* ---------- intent -> profile ---------- */

  // "coding the settings page" picks Coding; "write the report" picks Writing.
  function intentProfile(intent, profiles) {
    const text = norm(intent);
    if (!text) return null;
    const hit = (profiles || []).find((p) => {
      const stem = norm(p.name).replace(/ing$/, '');
      return stem.length >= 3 && text.includes(stem);
    });
    return hit ? hit.id : null;
  }

  return {
    urlMatches,
    urlHost,
    isMeeting,
    isBrowser,
    createTabIndex,
    intentProfile,
    parseRule,
    matches,
    classify,
    labelFor,
    DEFAULT_PROFILES,
    sanitiseProfiles,
    cleanTiming,
    exportProfiles,
    parseProfilesFile,
    mergeProfiles,
    PROFILE_FILE,
    createTracker,
    DEFAULT_TRACK,
    describe,
    duration,
    createLineParser,
  };
});
