/**
 * fix277: scraper swarms — many addresses behaving like one script, challenged as a group (Yarin, 29 Oct: "I don't want
 * them on our website"). Pure rules, no imports but node:crypto (unit-tested by scripts/fix277.test.ts); the server side
 * is services/swarmGuard.ts.
 *
 * 29 Oct: 24,720 "bots" against 12 people. One user-agent ("Chrome/155 … X11; Linux x86_64") made 222,665 requests from
 * thousands of addresses, mostly US home networks; only ~38k came from listed data-centre networks, so fix199's proxy
 * rules (data-centre addresses only) never saw the rest. Each address opens a few pages, never sends a seen beacon, and
 * the next address takes over.
 *
 *  - group = hash(user-agent) + country + network (the AS number when the address is on the data-centre list, else the
 *    address's /16, /32 for IPv6); per group and clock hour: distinct addresses, page views, requests, addresses with
 *    human signs (a seen beacon: visible 5+ s and used, not headless; a Quick-check pass; an email-verified account) and
 *    headless signals (webdriver, no languages);
 *  - a group is a swarm when in an hour it has 40+ distinct addresses and fewer than 5% of them showed human signs; a
 *    user-agent is one when it has 300+ distinct addresses in a day (any country) with fewer than 5% human (then every
 *    group of it is challenged except a group whose own day shows 5%+ human: people on one ISP protect their network);
 *    only addresses first seen a minute ago or more are judged (a person's beacon comes after 5 s);
 *  - it stays a swarm for 6 h after the last moment it qualified; admin overrides per user-agent: "Always challenge" /
 *    "Trust" (trust wins over every rule at once).
 * Nothing here holds an address: callers pass salted hashes; group and network keys are hashed again before they are kept.
 */
import { createHash } from 'node:crypto';

export const SWARM_RULES = {
  /** distinct addresses of one group in an hour */
  addrHour: 40,
  /** below this share of addresses with human signs (group hour, user-agent day) */
  humanShare: 0.05,
  /** distinct addresses of one user-agent in a day, any country */
  uaDayAddrs: 300,
  /** a swarm stays one this long after it last qualified */
  holdMs: 6 * 3600000,
  /** an address is judged once it was first seen this long ago (its beacon had time to come) */
  settleMs: 60000,
  /** a group / user-agent is re-judged at most this often */
  evalMs: 10000,
  /** memory caps */
  maxAddrs: 20000, maxGroups: 50000, maxUas: 5000,
  /** an admin row: at least this many addresses in the day (or held / overridden) */
  rowAddrs: 20
};
export type SwarmRules = typeof SWARM_RULES;
export type SwarmOverride = 'trust' | 'challenge';

const h16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** the user-agent's key (kept in the overrides table and the admin rows) */
export const uaKeyOf = (ua: string) => h16(`swarm-ua|${ua}`);
/** the network part of a group: the AS number when known, else the /16 (IPv4) or /32 (IPv6) of the address */
export function netOf(ip: string, asn: number | null | undefined): string {
  if (asn) return `AS${asn}`;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}/16`;
  const parts = ip.toLowerCase().split(':');
  return `${parts[0] || '0'}:${parts[1] || '0'}/32`;
}

/** one request / beacon: ua = the raw user-agent, addr = the salted address hash, netName = the AS name when known */
export type SwarmHit = { ua: string; country: string | null; net: string; netName?: string | null; addr: string };
export type SwarmEvent = { request?: boolean; view?: boolean; human?: boolean; headless?: boolean };
export type SwarmWhy = 'hour' | 'day' | 'always';
export type SwarmVerdict = { swarm: boolean; why: SwarmWhy | null; trusted: boolean; uaKey: string };

type Bucket = { h: number; addrs: Map<string, number>; human: Set<string>; headless: Set<string>; requests: number; views: number };
type Group = { key: string; uaKey: string; cur: Bucket; dayAddrs: Set<string>; dayHuman: Set<string>; d: number; until: number; since: number | null; evalAt: number };
type UaDay = {
  uaKey: string; ua: string; d: number; addrs: Map<string, number>; human: Set<string>; headless: Set<string>;
  requests: number; views: number; refused: number; wrong: number; refusedByHour: Map<number, number>;
  countries: Map<string, number>; nets: Map<string, number>; otherNets: Set<string>;
  hour: { h: number; addrs: Set<string> }; groups: Set<string>; until: number; since: number | null; evalAt: number
};

const bucket = (h: number): Bucket => ({ h, addrs: new Map(), human: new Set(), headless: new Set(), requests: 0, views: 0 });
const capAdd = (s: Set<string>, v: string, max: number) => { if (s.size < max || s.has(v)) s.add(v); };

export type SwarmRow = {
  ua: string; text: string; state: 'challenged' | 'watching'; why: SwarmWhy | null; override: SwarmOverride | null;
  countries: { cc: string; addresses: number }[]; networks: { name: string; addresses: number }[]; otherNetworks: number;
  addressesHour: number; addresses: number; requests: number; views: number; human: number; humanShare: number; headless: number;
  refused: number; refused24h: number; wrong: number; groupsHeld: number; since: string | null; until: string | null
};
export type SwarmHolds = { g: [string, number, number | null][]; u: [string, number, number | null][] };

export class SwarmTracker {
  private groups = new Map<string, Group>();
  private uas = new Map<string, UaDay>();
  private overrides = new Map<string, SwarmOverride>();
  private r: SwarmRules;
  private now: () => number;
  constructor(rules: SwarmRules = SWARM_RULES, now: () => number = () => Date.now()) { this.r = rules; this.now = now; }

  setOverrides(list: { ua: string; mode: SwarmOverride }[]) {
    this.overrides = new Map(list.filter(x => x.mode === 'trust' || x.mode === 'challenge').map(x => [x.ua, x.mode]));
  }
  overrideOf(uaKey: string): SwarmOverride | null { return this.overrides.get(uaKey) || null; }

  private ua(uaKey: string, text: string, t: number): UaDay {
    const d = Math.floor(t / 86400000), h = Math.floor(t / 3600000);
    let u = this.uas.get(uaKey);
    if (u && u.d !== d) { // a new day: the counts start again, the hold stays
      u = { ...u, d, addrs: new Map(), human: new Set(), headless: new Set(), requests: 0, views: 0, refused: 0, wrong: 0, countries: new Map(), nets: new Map(), otherNets: new Set(), groups: new Set(), refusedByHour: new Map([...u.refusedByHour].filter(([k]) => k > h - 24)) };
      this.uas.set(uaKey, u);
    }
    if (!u) {
      if (this.uas.size >= this.r.maxUas) this.dropQuietUa();
      u = { uaKey, ua: text.slice(0, 300), d, addrs: new Map(), human: new Set(), headless: new Set(), requests: 0, views: 0, refused: 0, wrong: 0, refusedByHour: new Map(), countries: new Map(), nets: new Map(), otherNets: new Set(), hour: { h, addrs: new Set() }, groups: new Set(), until: 0, since: null, evalAt: 0 };
      this.uas.set(uaKey, u);
    }
    if (u.hour.h !== h) u.hour = { h, addrs: new Set() };
    return u;
  }
  private dropQuietUa() {
    let min: UaDay | null = null;
    for (const u of this.uas.values()) if (!u.until && !this.overrides.has(u.uaKey) && (!min || u.addrs.size < min.addrs.size)) min = u;
    if (min) this.uas.delete(min.uaKey);
  }
  private group(hit: SwarmHit, uaKey: string, t: number): Group {
    const key = h16(`swarm-g|${uaKey}|${hit.country || '??'}|${hit.net}`);
    const h = Math.floor(t / 3600000), d = Math.floor(t / 86400000);
    let g = this.groups.get(key);
    if (!g) {
      if (this.groups.size >= this.r.maxGroups) this.prune();
      g = { key, uaKey, cur: bucket(h), dayAddrs: new Set(), dayHuman: new Set(), d, until: 0, since: null, evalAt: 0 };
      this.groups.set(key, g);
    }
    if (g.cur.h !== h) g.cur = bucket(h);
    if (g.d !== d) { g.d = d; g.dayAddrs = new Set(); g.dayHuman = new Set(); }
    return g;
  }

  /** count one request / page view / beacon sign of `hit`; the verdict after it */
  note(hit: SwarmHit, ev: SwarmEvent = {}): SwarmVerdict {
    this.restoreFor(hit);
    const t = this.now(), uaKey = uaKeyOf(hit.ua);
    const u = this.ua(uaKey, hit.ua, t), g = this.group(hit, uaKey, t);
    const max = this.r.maxAddrs;
    u.groups.add(g.key);
    if (!g.cur.addrs.has(hit.addr) && g.cur.addrs.size < max) g.cur.addrs.set(hit.addr, t);
    capAdd(g.dayAddrs, hit.addr, max);
    if (!u.addrs.has(hit.addr) && u.addrs.size < max) {
      u.addrs.set(hit.addr, t);
      const cc = hit.country || '??';
      u.countries.set(cc, (u.countries.get(cc) || 0) + 1);
      if (hit.netName) u.nets.set(hit.netName, (u.nets.get(hit.netName) || 0) + 1);
      else capAdd(u.otherNets, h16(hit.net), max);
    }
    capAdd(u.hour.addrs, hit.addr, max);
    if (ev.request) { g.cur.requests++; u.requests++; }
    if (ev.view) { g.cur.views++; u.views++; }
    if (ev.headless) { capAdd(g.cur.headless, hit.addr, max); capAdd(u.headless, hit.addr, max); }
    if (ev.human && !ev.headless) {
      capAdd(g.cur.human, hit.addr, max); capAdd(g.dayHuman, hit.addr, max); capAdd(u.human, hit.addr, max);
    }
    this.judge(g, u, t);
    return this.verdictOf(g, u, t);
  }

  /** the verdict without counting anything */
  verdict(hit: SwarmHit): SwarmVerdict {
    this.restoreFor(hit);
    const t = this.now(), uaKey = uaKeyOf(hit.ua);
    const o = this.overrides.get(uaKey);
    const g = this.groups.get(h16(`swarm-g|${uaKey}|${hit.country || '??'}|${hit.net}`)), u = this.uas.get(uaKey);
    if (!g || !u) return { swarm: o === 'challenge', why: o === 'challenge' ? 'always' : null, trusted: o === 'trust', uaKey };
    return this.verdictOf(g, u, t);
  }

  /** the address's first request of this hour was at least `ms` ago (a beacon claiming 5 s visible must fit) */
  seenFor(hit: SwarmHit, ms: number): boolean {
    const t = this.now(), uaKey = uaKeyOf(hit.ua);
    const first = this.groups.get(h16(`swarm-g|${uaKey}|${hit.country || '??'}|${hit.net}`))?.cur.addrs.get(hit.addr);
    return first != null && t - first >= ms;
  }

  private settled(m: Map<string, number>, t: number) {
    let n = 0;
    const edge = t - this.r.settleMs;
    for (const at of m.values()) if (at <= edge) n++;
    return n;
  }
  private judge(g: Group, u: UaDay, t: number) {
    if (g.evalAt <= t - this.r.evalMs && g.cur.addrs.size >= this.r.addrHour) {
      g.evalAt = t;
      const n = this.settled(g.cur.addrs, t);
      if (n >= this.r.addrHour && g.cur.human.size < this.r.humanShare * n) { g.until = t + this.r.holdMs; g.since ??= t; }
    }
    if (u.evalAt <= t - this.r.evalMs && u.addrs.size >= this.r.uaDayAddrs) {
      u.evalAt = t;
      const n = this.settled(u.addrs, t);
      if (n >= this.r.uaDayAddrs && u.human.size < this.r.humanShare * n) { u.until = t + this.r.holdMs; u.since ??= t; }
    }
  }
  private verdictOf(g: Group, u: UaDay, t: number): SwarmVerdict {
    const o = this.overrides.get(u.uaKey);
    if (o === 'trust') return { swarm: false, why: null, trusted: true, uaKey: u.uaKey };
    if (o === 'challenge') return { swarm: true, why: 'always', trusted: false, uaKey: u.uaKey };
    if (g.until > t) return { swarm: true, why: 'hour', trusted: false, uaKey: u.uaKey };
    // the user-agent's day rule: a group whose own day shows people is left alone
    if (u.until > t && !(g.dayHuman.size >= this.r.humanShare * Math.max(1, g.dayAddrs.size))) return { swarm: true, why: 'day', trusted: false, uaKey: u.uaKey };
    return { swarm: false, why: null, trusted: false, uaKey: u.uaKey };
  }

  /** a request of this user-agent was answered with the challenge (wrong = it should never have been: trusted / verified engine) */
  refused(hit: SwarmHit, wrong = false) {
    const t = this.now(), u = this.uas.get(uaKeyOf(hit.ua));
    if (!u) return;
    u.refused++;
    const h = Math.floor(t / 3600000);
    u.refusedByHour.set(h, (u.refusedByHour.get(h) || 0) + 1);
    if (wrong) u.wrong++;
  }

  /** Admin → Visitors → Swarms: every user-agent that is challenged, overridden or has 20+ addresses today (biggest first) */
  rows(limit = 30): SwarmRow[] {
    const t = this.now(), h = Math.floor(t / 3600000);
    const out: SwarmRow[] = [];
    for (const u of this.uas.values()) {
      const o = this.overrides.get(u.uaKey) || null;
      let held = 0, since = u.since, until = u.until > t ? u.until : 0;
      for (const k of u.groups) {
        const g = this.groups.get(k);
        if (g && g.until > t) { held++; since = since == null ? g.since : Math.min(since, g.since ?? since); until = Math.max(until, g.until); }
      }
      const challenged = o === 'challenge' || (o !== 'trust' && (u.until > t || held > 0));
      if (!challenged && !o && u.addrs.size < this.r.rowAddrs && !u.refused) continue;
      const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 5);
      let r24 = 0;
      for (const [k, n] of u.refusedByHour) if (k > h - 24) r24 += n;
      out.push({
        ua: u.uaKey, text: u.ua, state: challenged ? 'challenged' : 'watching', why: o === 'challenge' ? 'always' : challenged ? (held ? 'hour' : 'day') : null, override: o,
        countries: top(u.countries).map(([cc, n]) => ({ cc, addresses: n })), networks: top(u.nets).map(([name, n]) => ({ name, addresses: n })), otherNetworks: u.otherNets.size,
        addressesHour: u.hour.h === h ? u.hour.addrs.size : 0, addresses: u.addrs.size, requests: u.requests, views: u.views, human: u.human.size,
        humanShare: u.addrs.size ? Math.round((1000 * u.human.size) / u.addrs.size) / 10 : 0, headless: u.headless.size,
        refused: u.refused, refused24h: r24, wrong: u.wrong, groupsHeld: held,
        since: challenged && since != null ? new Date(since).toISOString() : null, until: challenged && until ? new Date(until).toISOString() : null
      });
    }
    return out.sort((a, b) => (a.state === b.state ? b.addresses - a.addresses : a.state === 'challenged' ? -1 : 1)).slice(0, limit);
  }

  /** the holds, to keep across a restart (hashed keys only) */
  holds(): SwarmHolds {
    const t = this.now();
    return {
      g: [...this.groups.values()].filter(g => g.until > t).map(g => [g.key, g.until, g.since] as [string, number, number | null]),
      u: [...this.uas.values()].filter(u => u.until > t).map(u => [u.uaKey, u.until, u.since] as [string, number, number | null])
    };
  }
  /** after a restart: the holds come back (a group / user-agent seen again picks its hold up) */
  private pending: SwarmHolds = { g: [], u: [] };
  loadHolds(h: SwarmHolds | null | undefined) { if (h && Array.isArray(h.g) && Array.isArray(h.u)) this.pending = h; this.applyPending(); }
  private applyPending() {
    const t = this.now();
    this.pending.g = this.pending.g.filter(([, until]) => until > t);
    this.pending.u = this.pending.u.filter(([, until]) => until > t);
  }
  /** (note() picks up a pending hold the first time a group / user-agent is seen) */
  restoreFor(hit: SwarmHit) {
    if (!this.pending.g.length && !this.pending.u.length) return;
    const uaKey = uaKeyOf(hit.ua), gk = h16(`swarm-g|${uaKey}|${hit.country || '??'}|${hit.net}`);
    const pg = this.pending.g.find(x => x[0] === gk), pu = this.pending.u.find(x => x[0] === uaKey);
    if (!pg && !pu) return;
    const t = this.now(), u = this.ua(uaKey, hit.ua, t), g = this.group(hit, uaKey, t);
    if (pg) { g.until = Math.max(g.until, pg[1]); g.since ??= pg[2]; this.pending.g = this.pending.g.filter(x => x !== pg); }
    if (pu) { u.until = Math.max(u.until, pu[1]); u.since ??= pu[2]; this.pending.u = this.pending.u.filter(x => x !== pu); }
  }

  /** drop groups of past hours that hold nothing (every few minutes) */
  prune() {
    const t = this.now(), h = Math.floor(t / 3600000);
    for (const [k, g] of this.groups) if (g.cur.h < h - 1 && g.until <= t) this.groups.delete(k);
    for (const u of this.uas.values()) for (const k of u.groups) if (!this.groups.has(k)) u.groups.delete(k);
    this.applyPending();
  }
}

/** the 07:00 summary line ("Swarms challenged today: 2 groups, 18,400 requests"), null when none */
export function swarmSummaryLine(rows: { refused24h: number }[]): string | null {
  const hit = rows.filter(r => r.refused24h > 0);
  if (!hit.length) return null;
  const n = hit.reduce((s, r) => s + r.refused24h, 0);
  return `Swarms challenged today: ${hit.length} group${hit.length === 1 ? '' : 's'}, ${n.toLocaleString('en-US')} request${n === 1 ? '' : 's'}`;
}
