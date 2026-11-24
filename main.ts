// Early-rider paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// The idea, in one paragraph: most new pump.fun coins spike briefly and then
// bleed out, while a rare few run far. So this bot buys a young coin only
// after it proves real buying interest — price up from its creation price,
// buy-heavy recent flow, more than one distinct buyer, and a real reserve big
// enough for a meaningful order — and then it gets out fast: a staged
// take-profit, a trailing stop once the position is ahead, a hard stop, and a
// holding-time cap. At most five slots are open at once, so exits are quick
// and the slots keep turning over; the round-trip bar (trips of at least
// 0.01 SOL on 20+ coins) is met by that turnover, not by holding.
//
// Every decision uses slot numbers only — never the clock, never randomness —
// so two runs of the same window agree byte for byte.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = 1_000_000_000n;
const STAKE = 60_000_000n; // 0.06 SOL per entry
const MIN_BUY = 20_000_000n; // 0.02 SOL: the round-trip bar needs >= 0.01
const MAX_ENTRY_AGE = 2400; // slots after creation; older coins are not chased
const MIN_TRADES = 3; // trades seen before a coin can be bought
const MIN_RISE_BPS = 1000; // price must be +10% over its creation price
const FLOW_WINDOW = 30; // last trades looked at for flow
const MIN_FLOW_BUY = 50_000_000n; // 0.05 SOL of buys inside the flow window
const MIN_BUY_SHARE_BPS = 6000; // buys must be >= 60% of window flow
const MIN_BUYERS = 2; // distinct buyers in the window
const FRESH_SLOTS = 300; // last trade must be this recent
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 2000;
const TP1_BPS = 13500; // +35% -> sell half the tokens
const TP2_BPS = 19000; // +90% -> sell everything left
const TRAIL_ARM_BPS = 11500; // trailing stop arms once value is +15%
const TRAIL_BPS = 8200; // sell when value falls to 82% of its peak
const STOP_BPS = 8200; // sell when value falls to 82% of cost
const MAX_HOLD_SLOTS = 3600; // slots; then sell whatever is left
const TAPE_LEN = 60; // trades remembered per coin

// ------------------------------------------------------------------ helpers

/** SOL per token from virtual reserves (both as bigint lamports / base units). */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What selling `tokens` into the curve would net now, after curve fees and one tx fee. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const curveFee = (gross * 125n) / 10_000n; // ~1.25% protocol + creator
  const net = gross - curveFee - txFee;
  return net > 0n ? net : 0n;
}

// ------------------------------------------------------------------ per-coin tape

interface TapeTrade {
  slot: number;
  price: number;
  buy: boolean;
  sol: bigint;
  user: string;
}

interface CoinTape {
  createdSlot: number;
  createPrice: number;
  trades: TapeTrade[];
  decided: boolean;
}

interface Held {
  buySlot: number;
  peak: bigint; // peak remaining value, lamports
  tp1Done: boolean;
  tokens: bigint; // tokens last seen; a drop means a partial sell filled
}

interface SentOrder {
  mint: string;
  side: 'buy' | 'sell';
}

const tapes = new Map<string, CoinTape>();
const held = new Map<string, Held>();
const sent = new Map<string, SentOrder>();
const fillStats = new Map<string, number>();
let buyCount = 0;
let sellCount = 0;

function tapeOf(mint: string, slot: number, createPrice: number): CoinTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: slot, createPrice, trades: [], decided: false };
    tapes.set(mint, t);
  }
  return t;
}

/** Entry signal for one young coin. Returns the rise in bps, or null. */
function entrySignal(t: CoinTape, nowSlot: number): number | null {
  if (t.decided) return null;
  if (t.trades.length < MIN_TRADES) return null;
  if (nowSlot - t.createdSlot > MAX_ENTRY_AGE) return null;
  const last = t.trades[t.trades.length - 1]!;
  if (nowSlot - last.slot > FRESH_SLOTS) return null;
  if (t.createPrice <= 0) return null;
  const riseBps = Math.round((last.price / t.createPrice - 1) * 10_000);
  if (riseBps < MIN_RISE_BPS) return null;
  const win = t.trades.slice(-FLOW_WINDOW);
  let buySol = 0n;
  let sellSol = 0n;
  const buyers = new Set<string>();
  for (const tr of win) {
    if (tr.buy) {
      buySol += tr.sol;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
  }
  if (buySol < MIN_FLOW_BUY) return null;
  if ((buySol * 10_000n) / (buySol + sellSol) < BigInt(MIN_BUY_SHARE_BPS)) return null;
  if (buyers.size < MIN_BUYERS) return null;
  return riseBps;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const nowSlot = batch.slot;

    // 1. Fills: a buy that did not fill frees the coin for another try.
    for (const f of batch.fills) {
      const s = sent.get(f.client_id);
      const key = `${f.side}:${f.status}:${f.reason ?? ''}`;
      fillStats.set(key, (fillStats.get(key) ?? 0) + 1);
      if (f.status === 'filled') {
        if (f.side === 'buy') buyCount += 1;
        else sellCount += 1;
      }
      if (s === undefined) continue;
      sent.delete(f.client_id);
      if (s.side === 'buy' && f.status !== 'filled') {
        const t = tapes.get(s.mint);
        if (t !== undefined) t.decided = false;
      }
    }

    // 2. Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        tapeOf(e.mint, e.slot, p);
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint, e.slot, 0);
        if (t.createPrice <= 0) {
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        }
        t.trades.push({
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          buy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
        });
        if (t.trades.length > TAPE_LEN) t.trades.splice(0, t.trades.length - TAPE_LEN);
      } else {
        // CompleteEvent: the curve is done, forget the coin.
        tapes.delete(e.mint);
      }
    }

    // 3. Prune tapes that can no longer be entered (old, no position).
    for (const [mint, t] of tapes) {
      if (!state.positions.has(mint) && nowSlot - t.createdSlot > MAX_ENTRY_AGE) {
        tapes.delete(mint);
      }
    }

    // 4. Exits for every held position.
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const sellPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const tokens = pos.token_amount;
      const cost = pos.cost_lamports;
      const value = sellValueLamports(tokens, vq, vt, txFee);
      let h = held.get(mint);
      if (h === undefined) {
        h = { buySlot: nowSlot, peak: value, tp1Done: false, tokens };
        held.set(mint, h);
      }
      // A partial sell filled: rescale the peak to the tokens still held,
      // or the trailing stop would fire on the halved value at once.
      if (tokens < h.tokens && h.tokens > 0n) {
        h.peak = (h.peak * tokens) / h.tokens;
      }
      h.tokens = tokens;
      if (value > h.peak) h.peak = value;
      const ratioBps = cost > 0n ? Number((value * 10_000n) / cost) : 0;
      const peakBps = cost > 0n ? Number((h.peak * 10_000n) / cost) : 0;

      if (ratioBps >= TP2_BPS) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (ratioBps >= TP1_BPS && !h.tp1Done) {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS });
          h.tp1Done = true;
        }
      } else if (peakBps >= TRAIL_ARM_BPS && value <= (h.peak * BigInt(TRAIL_BPS)) / 10_000n) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (ratioBps <= STOP_BPS) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (nowSlot - h.buySlot > MAX_HOLD_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
    // Positions the harness closed (complete / flatten) drop out of state.
    for (const mint of held.keys()) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // 5. Entries: rank young coins by rise, buy the hottest while slots allow.
    const maxOrders = state.hello.caps.max_orders_per_batch;
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (slots > 0 && orders.length < maxOrders) {
      const ranked: { mint: string; riseBps: number }[] = [];
      for (const [mint, t] of tapes) {
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const riseBps = entrySignal(t, nowSlot);
        if (riseBps !== null) ranked.push({ mint, riseBps });
      }
      ranked.sort((a, b) => b.riseBps - a.riseBps || (a.mint < b.mint ? -1 : 1));
      for (const cand of ranked) {
        if (slots <= 0 || orders.length >= maxOrders) break;
        const cap = state.maxBuyLamports(cand.mint);
        if (cap < MIN_BUY) continue;
        const amount = cap < STAKE ? cap : STAKE;
        if (free < amount + txFee) continue;
        const id = state.clientId();
        orders.push({ side: 'buy', mint: cand.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS, client_id: id });
        sent.set(id, { mint: cand.mint, side: 'buy' });
        const t = tapes.get(cand.mint);
        if (t !== undefined) t.decided = true;
        free -= amount + txFee;
        slots -= 1;
      }
    }

    // Tag sell orders so their fills can be followed up.
    for (const o of orders) {
      if (o.side === 'sell' && o.client_id === undefined) {
        const id = state.clientId();
        (o as { client_id: string }).client_id = id;
        sent.set(id, { mint: o.mint, side: 'sell' });
      }
    }
    return orders;
  },

  onDone(state: BotState): void {
    // Diagnostics only; the harness reads stdout, this goes to stderr.
    const cashSol = Number(state.cash) / 1e9;
    const pnl = cashSol - 10;
    const fills = [...fillStats.entries()].sort((a, b) => b[1] - a[1]);
    console.error(
      `[early-rider] done cash=${cashSol.toFixed(4)} pnl=${pnl.toFixed(4)} buys=${buyCount} sells=${sellCount} ` +
        fills.map(([k, v]) => `${k}=${v}`).join(' '),
    );
  },
});
