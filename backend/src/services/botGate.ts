/**
 * fix243: a crawler burst never stalls the web thread and never holds a real visitor back. Page renders for bots
 * (any crawler / tool user-agent: search engines included) take a slot: at most BOT_PAGES at a time, up to BOT_QUEUE
 * more wait (at most BOT_WAIT_MS) for a free slot, any further one gets 503 + Retry-After at once. Browsers never
 * take a slot and never wait here. 26 Oct: 33 web stalls an hour, the worst 3.8 s, during bursts of /pt/* /tr/* /it/*
 * pages and past-season basketball games from crawlers.
 */
export const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|fetcher|python|curl|wget|httpclient|okhttp|java\/|go-http|libwww|headless|phantom|puppeteer|playwright|semrush|ahrefs|mj12|dotbot|petal|bytespider|gptbot|claudebot|ccbot|amazonbot|perplexity|dataforseo|seznam|sogou|baidu|yeti|ia_archiver/i;
/** a bot's request: a crawler / tool user-agent, or none at all */
export const isBotUa = (ua: string | undefined | null) => !ua || BOT_UA.test(ua);

export class BotGate {
  private running = 0;
  private queue: { go: () => void; timer: NodeJS.Timeout }[] = [];
  readonly stats = { served: 0, queued: 0, refused: 0, timedOut: 0, maxRunning: 0, maxQueue: 0, crawlerWaited: 0, crawlerUnslotted: 0 };
  constructor(readonly max = Number(process.env.BOT_PAGES) || 4, readonly queueMax = Number(process.env.BOT_QUEUE) || 16, readonly waitMs = Number(process.env.BOT_WAIT_MS) || 4000,
    readonly crawlerWaitMs = Number(process.env.CRAWLER_WAIT_MS) || 15000) {}
  /**
   * a slot (call the returned release when the page is sent), or null = over the limit (503).
   * fix245: `patient` (a verified search engine) never gets null: it queues past BOT_QUEUE, waits up to CRAWLER_WAIT_MS,
   * then goes on without a slot (the page route sends stored pages only) — a 503 to Googlebot hurts the site's crawl health.
   */
  async enter(patient = false): Promise<(() => void) | null> {
    if (this.running < this.max) return this.take();
    if (patient) {
      this.stats.crawlerWaited++;
      if (await this.wait(this.crawlerWaitMs)) return this.slot();
      this.stats.crawlerUnslotted++;
      return () => {};
    }
    if (this.queue.length >= this.queueMax) { this.stats.refused++; return null; }
    const ok = await this.wait(this.waitMs);
    return ok ? this.slot() : null; // the slot was handed over by the request that left (running unchanged)
  }
  private wait(ms: number): Promise<boolean> {
    this.stats.queued++;
    return new Promise<boolean>(resolve => {
      const item = { go: () => { clearTimeout(item.timer); resolve(true); }, timer: setTimeout(() => { this.queue = this.queue.filter(x => x !== item); this.stats.timedOut++; resolve(false); }, ms) };
      this.queue.push(item);
      this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length);
    });
  }
  private take(): () => void {
    this.running++;
    this.stats.maxRunning = Math.max(this.stats.maxRunning, this.running);
    return this.slot();
  }
  private slot(): () => void {
    this.stats.served++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) next.go(); else this.running--;
    };
  }
  status() { return { running: this.running, waiting: this.queue.length, max: this.max, queueMax: this.queueMax, ...this.stats }; }
}

export const botGate = new BotGate();
