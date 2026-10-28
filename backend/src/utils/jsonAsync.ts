/**
 * fix210: JSON.stringify of a big page in slices. A stored page is mostly one long list ({ data: [...] }: the upcoming
 * matches, a sitemap's rows); one JSON.stringify of several MB blocks the thread for a long time on the server. The
 * long arrays (at the top level or one level down) are turned into JSON 200 items at a time with a yield between; the
 * result is the same string JSON.stringify gives (same key order; undefined / function values left out as it does).
 */
import { yieldLoop } from '../services/perf';

const SLICE = 200;
const LONG = 500;

type Replacer = (key: string, value: any) => any;

async function arrayJson(a: unknown[], r?: Replacer): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < a.length; i += SLICE) {
    const s = JSON.stringify(a.slice(i, i + SLICE), r);
    parts.push(s.slice(1, -1));
    await yieldLoop();
  }
  return `[${parts.join(',')}]`;
}

async function valueJson(v: unknown, depth: number, r?: Replacer): Promise<string | undefined> {
  if (Array.isArray(v) && v.length >= LONG) return arrayJson(v, r);
  if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).toJSON !== 'function'
      && Object.values(v).some(x => Array.isArray(x) && x.length >= LONG)) {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      // fix266: a replacer sees each key as JSON.stringify would (it decides by key: names, shadow models)
      const s = await valueJson(r ? r.call(v, k, x) : x, depth - 1, r);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v, r);
}

/** JSON.stringify(value, replacer), long arrays in slices (the same string) */
export async function stringifyAsync(value: unknown, replacer?: Replacer): Promise<string> {
  return (await valueJson(value, 2, replacer)) ?? 'null';
}
