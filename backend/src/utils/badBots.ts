/** fix140: bad bots get nothing (index.ts answers 403; the same list is disallowed in robots.txt). */
export const BAD_BOTS = /ShapBot|Bytespider|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot/i;
