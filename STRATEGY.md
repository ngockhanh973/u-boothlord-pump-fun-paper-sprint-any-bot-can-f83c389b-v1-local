# Strategy note — Early-Rider v1

## Why this shape

On a 6-hour pump.fun window most new coins spike briefly and then bleed to
near zero, while a rare few run 5–50x. A bot that buys everything early and
holds rides the losers down; a bot that waits for confirmation misses the
first leg. v1 splits the difference: it demands proof of real buying
(price up, buy-heavy flow, several distinct buyers) and then manages the
exit mechanically, so losers are cut and winners get room to run.

## Entry (all must hold)

- Coin age ≤ 2,400 slots since its CreateEvent.
- At least 3 trades seen; last trade within 300 slots.
- Price ≥ +10% over the creation price (virtual reserves at creation).
- Last ≤ 30 trades: buys ≥ 0.05 SOL in total and ≥ 60% of flow.
- At least 2 distinct buyers in that window (one wallet pumping alone
  does not count).
- Size cap (1% of real SOL reserve) ≥ 0.02 SOL; stake is
  min(0.06 SOL, cap). One buy per coin, ever.
- Candidates are ranked by rise and the hottest go first while the 5
  position slots allow.

## Exit (checked every batch)

- +35% → sell half the tokens.
- +90% → sell everything left.
- Trailing stop: once the position's value is +15% ahead, sell all if it
  falls to 82% of its peak value.
- Hard stop: sell all if value falls to 82% of cost.
- Time-out: sell all after 3,600 slots held.
- The replay closes positions itself when a curve completes; the bot does
  not fight that.

## Guardrails (from the kit)

- Round trips of ≥ 0.01 SOL on ≥ 20 distinct coins: buys are ≥ 0.02 SOL
  and the 5 slots turn over fast, so the bar is met by volume of trips.
- Max drawdown 50%: at most 0.30 SOL is deployed at once (5 × 0.06) and
  every position carries an 18% hard stop, so drawdown stays far below
  the cap.
- Fees are ~1.25% per side plus 105,000 lamports per order; the +35%
  first target clears that several times over.

## What v1 does NOT do

- No re-entry on a coin after selling it.
- No creator / holder / social signals (the replay carries none it can
  trust); only price, flow and distinct buyers from the event stream.
- No randomness and no clock: decisions use slot numbers only, so the
  two grading runs agree byte for byte.
