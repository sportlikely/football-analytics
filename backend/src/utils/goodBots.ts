/**
 * fix285: link previews and AI crawlers that name themselves (Yarin, 30 Oct: "facebookexternalhit" sat in Admin →
 * Visitors → Swarms as "watching" with 148 addresses). Pure rules, no imports but the range lookup (unit-tested by
 * scripts/fix285.test.ts); the server side is services/goodBots.ts.
 *
 *  - Link previews (Meta's facebookexternalhit / meta-externalfetcher, Twitterbot, WhatsApp, TelegramBot, LinkedInBot,
 *    Slackbot, Discordbot, Pinterestbot; Applebot is a search engine already, fix245): checked by the ranges the company
 *    publishes (Meta: its network AS32934; Telegram: core.telegram.org/resources/cidr.txt) or reverse DNS where that is
 *    what it publishes (Pinterest). Verified → never a swarm / proxy / Quick-check challenge, the stored page with its
 *    Open Graph tags, no provider calls (like a search engine). A name of a company that publishes its addresses, from
 *    another network = a fake: a normal unknown caller.
 *  - Some previews are made where nothing is published: on the sender's phone (WhatsApp, iMessage) or on cloud servers
 *    that change (Slack, Discord). `card` bots: never challenged either, but they get the Open Graph card only (the
 *    page's head, no body) — nothing to scrape, the link still shows its title and picture.
 *  - AI search crawlers that name themselves (ExaBot, PerplexityBot, OAI-SearchBot, Claude-SearchBot, Amazonbot …): one
 *    switch per bot (Admin → Visitors → Swarms): Trust = like a search engine; Challenge (the default unless Yarin set
 *    Trust) = the Quick check on every page / API read. Where the company publishes its addresses, Trust needs them
 *    (a fake from another network is a normal unknown caller). Their pages never count as visits.
 */
import { CrawlerRanges, plainIp } from './crawlerRanges';

export type BotKind = 'preview' | 'ai';
export type BotMode = 'trust' | 'challenge';
export type GoodBot = {
  id: string; name: string; kind: BotKind; owner: string; ua: RegExp;
  /** prefixes (seed) and the URLs of the published lists (JSON { prefixes } or plain text) */
  ranges?: string[]; lists?: { url: string; format: 'json' | 'text' }[];
  /** reverse DNS: the host names its addresses resolve to (then forward back to the address) */
  dns?: RegExp;
  /** previews made where nothing is published (phones, changing cloud servers): never challenged, the Open Graph card only */
  card?: boolean;
};

// Meta (AS32934: Meta's crawler docs say "whois -h whois.radb.net -- '-i origin AS32934'"), Twitter / X (AS13414), LinkedIn
// (AS14413), Telegram (cidr.txt): the networks' registered prefixes
const META = ['31.13.24.0/21', '31.13.64.0/18', '45.64.40.0/22', '57.141.0.0/16', '57.144.0.0/14', '66.220.144.0/20', '69.63.176.0/20', '69.171.224.0/19',
  '74.119.76.0/22', '102.132.96.0/20', '102.221.188.0/22', '103.4.96.0/22', '129.134.0.0/16', '147.75.208.0/20', '157.240.0.0/16', '163.70.128.0/17',
  '163.77.128.0/17', '173.252.64.0/18', '179.60.192.0/22', '185.60.216.0/22', '185.89.216.0/22', '199.201.64.0/22', '204.15.20.0/22',
  '2a03:2880::/29', '2620:0:1c00::/40', '2620:10d:c090::/44'];
const TWITTER = ['69.12.56.0/21', '69.195.160.0/19', '104.244.40.0/21', '185.45.4.0/22', '192.133.76.0/22', '199.16.156.0/22', '199.59.148.0/22',
  '199.96.56.0/21', '202.160.128.0/22', '209.237.192.0/19'];
const LINKEDIN = ['108.174.0.0/20', '185.63.144.0/22', '144.2.0.0/16'];
const TELEGRAM = ['91.105.192.0/23', '91.108.4.0/22', '91.108.8.0/22', '91.108.12.0/22', '91.108.16.0/22', '91.108.20.0/22', '91.108.56.0/22',
  '149.154.160.0/20', '185.76.151.0/24', '2001:b28:f23c::/48', '2001:b28:f23d::/48', '2001:b28:f23f::/48', '2001:67c:4e8::/48', '2a0a:f280::/32'];

/** first match wins: iMessage's preview names Facebook and Twitter, Telegram's "like TwitterBot": each goes first */
export const GOOD_BOTS: GoodBot[] = [
  // ---- link previews ----
  { id: 'imessage', name: 'iMessage preview', kind: 'preview', owner: 'Apple', ua: /facebookexternalhit\/1\.1 Facebot Twitterbot\/1\.0/i, card: true },
  { id: 'whatsapp', name: 'WhatsApp', kind: 'preview', owner: 'Meta', ua: /WhatsApp\//i, ranges: META, card: true },
  { id: 'meta', name: 'Facebook / Instagram (facebookexternalhit)', kind: 'preview', owner: 'Meta', ua: /facebookexternalhit|meta-externalfetcher|facebookcatalog|Facebot/i, ranges: META },
  { id: 'telegrambot', name: 'TelegramBot', kind: 'preview', owner: 'Telegram', ua: /TelegramBot/i, ranges: TELEGRAM, lists: [{ url: 'https://core.telegram.org/resources/cidr.txt', format: 'text' }] },
  { id: 'twitterbot', name: 'Twitterbot (X)', kind: 'preview', owner: 'X', ua: /Twitterbot/i, ranges: TWITTER },
  { id: 'linkedinbot', name: 'LinkedInBot', kind: 'preview', owner: 'LinkedIn', ua: /LinkedInBot/i, ranges: LINKEDIN },
  { id: 'pinterestbot', name: 'Pinterestbot', kind: 'preview', owner: 'Pinterest', ua: /Pinterest(bot)?\//i, dns: /\.pinterest\.com$/i },
  { id: 'slackbot', name: 'Slackbot', kind: 'preview', owner: 'Slack', ua: /Slackbot/i, card: true },
  { id: 'discordbot', name: 'Discordbot', kind: 'preview', owner: 'Discord', ua: /Discordbot/i, card: true },
  // ---- AI search crawlers that name themselves (meta-externalagent: Meta's AI crawler, not a preview) ----
  { id: 'oai-searchbot', name: 'OAI-SearchBot (ChatGPT search)', kind: 'ai', owner: 'OpenAI', ua: /OAI-SearchBot/i, lists: [{ url: 'https://openai.com/searchbot.json', format: 'json' }] },
  { id: 'chatgpt-user', name: 'ChatGPT-User', kind: 'ai', owner: 'OpenAI', ua: /ChatGPT-User/i, lists: [{ url: 'https://openai.com/chatgpt-user.json', format: 'json' }] },
  { id: 'gptbot', name: 'GPTBot', kind: 'ai', owner: 'OpenAI', ua: /GPTBot/i, lists: [{ url: 'https://openai.com/gptbot.json', format: 'json' }] },
  { id: 'perplexitybot', name: 'PerplexityBot', kind: 'ai', owner: 'Perplexity', ua: /PerplexityBot/i, lists: [{ url: 'https://www.perplexity.com/perplexitybot.json', format: 'json' }] },
  { id: 'perplexity-user', name: 'Perplexity-User', kind: 'ai', owner: 'Perplexity', ua: /Perplexity-User/i, lists: [{ url: 'https://www.perplexity.com/perplexity-user.json', format: 'json' }] },
  { id: 'claude-searchbot', name: 'Claude-SearchBot', kind: 'ai', owner: 'Anthropic', ua: /Claude-SearchBot/i },
  { id: 'claude-user', name: 'Claude-User', kind: 'ai', owner: 'Anthropic', ua: /Claude-User/i },
  { id: 'claudebot', name: 'ClaudeBot', kind: 'ai', owner: 'Anthropic', ua: /ClaudeBot/i },
  { id: 'exabot', name: 'ExaBot / ExaUser', kind: 'ai', owner: 'Exa', ua: /Exa(Bot|User)/i },
  { id: 'amazonbot', name: 'Amazonbot', kind: 'ai', owner: 'Amazon', ua: /Amazonbot/i, dns: /\.crawl\.amazonbot\.amazon$/i },
  { id: 'meta-externalagent', name: 'meta-externalagent (Meta AI)', kind: 'ai', owner: 'Meta', ua: /meta-externalagent/i, ranges: META },
  { id: 'duckassistbot', name: 'DuckAssistBot', kind: 'ai', owner: 'DuckDuckGo', ua: /DuckAssistBot/i },
  { id: 'mistralai-user', name: 'MistralAI-User', kind: 'ai', owner: 'Mistral', ua: /MistralAI-User/i },
  { id: 'youbot', name: 'YouBot', kind: 'ai', owner: 'You.com', ua: /YouBot/i },
  { id: 'ccbot', name: 'CCBot (Common Crawl)', kind: 'ai', owner: 'Common Crawl', ua: /CCBot/i }
];
export const goodBotById = (id: string) => GOOD_BOTS.find(b => b.id === id) || null;
/** the bot this user-agent names, or null */
export function goodBotOfUa(ua: string | undefined | null): GoodBot | null {
  const s = String(ua || '');
  if (!s) return null;
  for (const b of GOOD_BOTS) if (b.ua.test(s)) return b;
  return null;
}
/** the AI bots' switches before Yarin sets any: Challenge (he trusts one with Admin → Visitors → Swarms) */
export const DEFAULT_MODES: Record<string, BotMode> = Object.fromEntries(GOOD_BOTS.filter(b => b.kind === 'ai').map(b => [b.id, 'challenge']));
export const modeOf = (id: string, modes: Record<string, BotMode>): BotMode => modes[id] || DEFAULT_MODES[id] || 'challenge';

/** every bot's seed prefixes, by id (the published lists are added on top by the server) */
export const seedRanges = (): Record<string, string[]> => Object.fromEntries(GOOD_BOTS.filter(b => b.ranges?.length).map(b => [b.id, [...b.ranges!]]));
/** the lookup: a bot's address list (seed + downloaded) */
export const rangesOf = (lists: Record<string, string[]>) => new CrawlerRanges<string>(lists);
/** checkable = the company publishes its addresses (ranges / lists) or a DNS name */
export const checkable = (b: GoodBot) => !!(b.ranges?.length || b.lists?.length || b.dns);

/**
 * what this request is: 'verified' (the address is in the bot's published list / its DNS checked out), 'card' (a preview
 * made where nothing is published: never challenged, the Open Graph card only), 'named' (an AI bot that publishes
 * nothing: its name is all there is), 'pending' (DNS still running: treated like 'fake' meanwhile), 'fake' (a company
 * that publishes its addresses, from another network: a normal unknown caller).
 */
export type BotStatus = 'verified' | 'card' | 'named' | 'pending' | 'fake';
export function botStatus(b: GoodBot, ip: string | undefined | null, r: CrawlerRanges<string>, dnsOk: boolean | null): BotStatus {
  const addr = plainIp(ip);
  const listed = !!addr && (b.ranges?.length || b.lists?.length) ? r.engineOf(addr) : null;
  // a bot's own list, or (Meta's preview names) the owner's same network: WhatsApp's servers sit in Meta's ranges
  if (listed && (listed === b.id || (b.owner === 'Meta' && goodBotById(listed)?.owner === 'Meta'))) return 'verified';
  if (b.dns && addr && dnsOk === true) return 'verified';
  if (b.card) return 'card';
  if (!checkable(b)) return 'named';
  if (b.dns && !(b.ranges?.length || b.lists?.length) && dnsOk === null) return 'pending';
  return 'fake';
}

/**
 * The request's treatment. `trusted` = like a verified search engine (stored page, never challenged, no provider calls);
 * `card` = never challenged, the Open Graph card only; `challenge` = the Quick check on every read (an AI bot on
 * Challenge, whatever its address); `normal` = nothing special (a fake: the usual unknown-caller rules).
 */
export type BotAct = 'trusted' | 'card' | 'challenge' | 'normal';
export function botAct(b: GoodBot, status: BotStatus, mode: BotMode): BotAct {
  if (b.kind === 'preview') return status === 'verified' ? 'trusted' : status === 'card' ? 'card' : 'normal';
  if (mode === 'challenge') return 'challenge';
  return status === 'verified' || status === 'named' ? 'trusted' : 'normal';
}

/** a page of HTML as its Open Graph card: the head (title, description, og:* tags), an empty body */
export function ogCard(html: string): string {
  const i = html.indexOf('</head>');
  const head = i >= 0 ? html.slice(0, i) : html.slice(0, 20000);
  return `${head.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]+rel="(?:modulepreload|preload|stylesheet)"[^>]*>/gi, '')}</head><body></body></html>`;
}

/**
 * Admin → Visitors headline: one category per caller (each counted once: people first, then the strongest bot reason).
 * People · Search engines · Link previews · Blocked bots · Other bots — they add up to all callers.
 */
export type VisitorKind = 'people' | 'search' | 'previews' | 'blocked' | 'other';
export const VISITOR_KINDS: VisitorKind[] = ['people', 'search', 'previews', 'blocked', 'other'];
/** visits.bot reason → its category (anything else = other bots) */
export const REASON_KIND: Record<string, VisitorKind> = { crawler: 'search', 'ai-trusted': 'search', preview: 'previews', swarm: 'blocked', 'ai-blocked': 'blocked', blocked: 'blocked' };
/** SQL: a caller's category rank (the highest of its rows wins; 5 = people) */
export const KIND_RANK_SQL = `MAX(CASE WHEN human = 1 OR signed_in = 1 THEN 5 WHEN bot IN ('crawler', 'ai-trusted') THEN 4 WHEN bot = 'preview' THEN 3 WHEN bot IN ('swarm', 'ai-blocked', 'blocked') THEN 2 ELSE 1 END)`;
export const RANK_KIND: Record<number, VisitorKind> = { 5: 'people', 4: 'search', 3: 'previews', 2: 'blocked', 1: 'other' };
