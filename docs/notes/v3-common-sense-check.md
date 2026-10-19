# Common-sense check for near-even games (fix179, 19 Oct 2026)

**Result: not shipped in any model.** The rule made predictions worse on the games it changed in football and basketball. NFL passed only on 6 games, which proves nothing. Instead, every sport shows an **"Even game"** chip when the home and away win chances are less than 3 points apart. It appears on list rows (the shared `GameRow` block and the football `DcBlock`), on the football pick badge (`OurPick` / `OurPickBadge`) and on the winner-sport prediction box (it replaces "Close game" there).

## Why it was tried
Getafe vs Rayo (PD 564717) was shown as a Getafe favourite. Rayo was better on head-to-head, squad value, Elo, attack and form, and home advantage flipped it.

## The rule that was tested
Six plain signals per game. Each one says home better, away better, or neither:

| Signal | Counts as neither when |
|---|---|
| Elo | within 5 points |
| Squad value | within 3% |
| Form (last 6) | level points |
| Head-to-head (last 10) | fewer than 3 meetings, or a share within 0.05 of 50% |
| Table points per game | within 0.05 |
| Grid totals | within 1 point |

- **Rule 1:** the favourite is worse on at least 4 of the 6 and leads by less than 6 points. Its win % is capped at the other side's. The difference goes to the other side and the draw, in proportion.
- **Rule 2:** v3-mix disagrees with grid-v3 and the gap is under 3. The signals majority picks the favourite; a 3-3 split is an even game.
- **To ship:** overall log loss no worse than +0.0005 **and** the changed games better.

## Football (walk-forward, 2024-25, 2025-26, 2026-27 to date)
grid-v3 was rebuilt weekly. The feature model was fitted at each season's 1 July cutoff and mixed 50/50 with grid-v3, as v3-mix does.

| Variant | Overall log loss | Changed games | Changed log loss | Favourite right (changed) |
|---|---|---|---|---|
| 4 of 6, grid-v3 | 1.02116 → 1.02140 (21,279 games) | 1,102 | 1.09240 → 1.09706 | 422 → 347 (hit 38.7 → 32.8%) |
| 4 of 6, v3-mix rule 1 | 1.01403 → 1.01442 (9,847 games) | 599 | 1.09020 → 1.09661 | 234 → 192 |
| 4 of 6, v3-mix rules 1+2 | 1.01403 → 1.01442 | 622 (+11 even) | worse | — |
| 5 of 6, grid-v3 | 1.02116 → 1.02126 | 399 | 1.09559 → 1.10082 | 153 → 120 |
| 5 of 6, v3-mix rule 1 | 1.01403 → 1.01410 | 211 | 1.09197 → 1.09503 | 72 → 76 |
| 5 of 6, v3-mix rules 1+2 | 1.01403 → 1.01411 | 269 | 1.09391 → 1.09687 | 97 → 89 |

Every variant fails. In these games home advantage is real: when the favourite is "worse on paper" and still ahead by under 6 points, the model was right more often than the signals.

## Basketball (bb-v3 walk-forward, the last 3 seasons of 18 leagues, 15,667 games)
The signals are season win %, home record (home side) vs away record (away side), wins in the last 6, H2H (last 10), point difference per game, and the average margin over the last 10.

| Variant | Overall log loss | Changed | Changed log loss | Changed hit |
|---|---|---|---|---|
| 4 of 6, gap < 4 (the spec) | 0.57759 → 0.57761 | 243 | 0.69260 → 0.69419 | 53.1 → 46.9% |
| 5 of 6, gap < 4 | 0.57759 → 0.57757 | 113 | 0.69486 → 0.69195 | 47.8 → 52.2% |
| 4 of 6, gap < 2 | 0.57759 → 0.57762 | 130 | 0.69157 → 0.69485 | 55.4 → 44.6% |

The spec's rule fails. The 5-of-6 variant is a small gain on 113 games (4 picks). That's noise-sized, and it was chosen after seeing the results, so it wasn't shipped.

## NFL (walk-forward 2023–2025, 636 games, league 1)
The signals are the same as basketball's, except model Elo replaces season win % and net yards per play replaces the home/away record.

| Variant | Overall log loss | Changed | Changed log loss | Changed hit |
|---|---|---|---|---|
| 4 of 6, gap < 4 | 0.57094 → 0.57087 (Brier 0.19403 → 0.19399) | 6 | 0.69726 → 0.68952 | 33.3 → 66.7% |
| 5 of 6, gap < 4 | — | 2 | — | — |
| 4 of 6, gap < 2 | — | 3 | — | — |

This passes the letter of the test, but on 6 games (2 picks flipped), so it's not evidence. It wasn't shipped, so all three sports stay on one rule. Re-test after the 2026 season with more games (the signals can be computed from stored games alone; the rule is described above).

## Don't retry blindly
- Capping a favourite that is "worse on paper" hurts football at every threshold tried (4 or 5 of 6; gap 6), on grid-v3 and v3-mix alike.
- A Getafe–Rayo type game is better handled by the factor rows themselves (e.g. the H2H guard in `h2hGuard.ts`), tested on unseen games, than by a vote over signals the model already uses.
