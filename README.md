[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ngockhanh973/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1-local/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ngockhanh973/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1-local/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Early-Rider — pump.fun paper bot

Entry for the make.fun bounty [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
One program, `main.ts` (Node 22), paper-trading pump.fun on a 6-hour replay.
Highest net PnL wins; starting capital 10 SOL.

## Strategy (v1)

Buy a young coin only after it proves real buying interest, then exit fast:

- **Entry:** coin younger than 2,400 slots, price +10% over its creation
  price, buy-heavy recent flow (buys ≥ 60% of the last 30 trades, ≥ 0.05 SOL
  of buys), at least 2 distinct buyers, and a size cap of at least 0.02 SOL.
  Stake 0.06 SOL per coin, at most 5 open positions.
- **Exit:** sell half at +35%, sell all at +90%; trailing stop at 82% of the
  position's peak once it is +15% ahead; hard stop at 82% of cost; time-out
  after 3,600 slots held.

See [STRATEGY.md](STRATEGY.md) for the full note. The SDK shim is vendored
unchanged at `vendor/makefun-bot.ts` (kit's `sdk/ts/makefun-bot.ts`).

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
