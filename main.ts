// Launch Sniper: a first-slots bot for the pump.fun bonding-curve replay.
//
// What the dev window taught: momentum entries made after the move has
// started lose money here. By the time a coin is 600 slots old and up 10%,
// the opening spike is usually over and the fade eats the position. The
// money in this market is made in the first seconds of a coin's life, so
// this bot buys young or not at all: it watches every coin from its
// CreateEvent and decides within its first few slots, then gets out fast.
//
// The opening tape is also where the rugs show themselves, so entries pass
// a rug filter first: the creator's own opening buy must be small, the
// launch must not be bundled across many wallets, and the creator must not
// have sold before entry. A coin that fails any of those is skipped for good.
//
// Exits are fast on purpose. A position is sold whole on the first of: a
// 20% take-profit, a 15% stop loss, 120 slots held, the creator selling
// while held, or 100 slots with no trade at all. Most positions leave near
// breakeven minus fees; the profit comes from the few that run or migrate.
// Stakes are small (0.1 SOL) and one per coin, so a single bad coin can
// never hurt the run, and the 1%-of-real-reserve buy cap does the rest of
// the filtering: cold launches never grow a cap worth buying.
//
// Money math: one round trip pays ~1.25% of curve fees each way plus
// 105,000 lamports of transaction fees per order, and about 2% of orders
// fail outright (fees paid, nothing traded). On a 0.1 SOL stake that is
// ~2.7% a round trip, so entries smaller than 0.01 SOL are never worth
// sending. A probe round trip keeps the run above the guardrail pace
// (at least 20 coins traded) when the signal goes quiet.
//
// Deterministic by construction: no clock, no randomness, no environment.
// Every decision comes from the batch stream (and block times the events
// carry) alone; iteration is only over insertion-ordered maps fed by that
// stream, so two runs decide byte for byte alike.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports in one SOL, as a plain number for sizing math
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, paid on every fill
const BPS = 10_000;

// --- entry window -----------------------------------------------------------
const MAX_AGE = 4; // slots after creation during which a first buy may be decided
const MIN_RQ_SOL = 0.3; // curve real SOL at decision, low end
const MAX_RQ_SOL = 30; // curve real SOL at decision, high end
const MAX_DEV_BUY_SOL = 1.0; // creator's own buy in the create slot, at most
const MAX_OPEN_BUYERS = 3; // distinct non-creator buyers in the opening, at most
const MIN_TRADES = 3; // trades seen before entry
const MAX_RUNUP = 0.5; // price now over the create price, at most

// --- sizing -----------------------------------------------------------------
const STAKE_SOL = 0.1; // SOL put into one coin, single buy, no adds
const MIN_BUY_SOL = 0.01; // smallest buy worth sending
const BUY_SLIP_BPS = 10_000; // buys go out wide open so the latency never refuses them

// --- exits ------------------------------------------------------------------
const TAKE_PROFIT = 0.2; // exit when value is 20% over cost
const STOP_LOSS = 0.1; // exit when value is 10% under cost
const MAX_HOLD = 60; // slots before the time limit exits a position
const STALE_SLOTS = 100; // slots with no trade before a position is closed

// --- guardrail pacing -------------------------------------------------------
const TARGET_COINS = 25; // coins the run aims to trade
const TARGET_FILLS = 60; // own fills the run aims for
const PACE_SECS = 14_400; // block-time seconds the pace is measured over
const PROBE_SOL = 0.02; // size of one probe round trip
const MAX_PROBES = 1; // most probes open at once

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  created: number;
  creator: Pubkey;
  createPrice: number; // SOL per token at creation, from the CreateEvent reserves
  devBuy: number; // SOL the creator bought in the create slot
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number; // SOL bought by everyone but the creator
  sold: number; // SOL sold by everyone but the creator
  lastTradeSlot: number;
  decided: boolean; // an entry decision was made (bought or skipped for good)
}

interface Held {
  opened: number;
  lastTradeSlot: number;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

const coinOf = (mint: Pubkey, created: number, creator: Pubkey, createPrice: number): Coin => {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      created,
      creator,
      createPrice,
      devBuy: 0,
      devSold: false,
      trades: 0,
      buyers: new Set(),
      bought: 0,
      sold: 0,
      lastTradeSlot: created,
      decided: false,
    };
    coins.set(mint, c);
  }
  return c;
};

/** What a whole position would fetch if sold now, in SOL, curve and tx fees deducted. */
const closeValue = (state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number => {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mk = batch.marks.find((m) => m.mint === mint);
  const vq = Number(mk ? mk.virtual_quote_reserves : curve.virtual_quote_reserves);
  const vt = Number(mk ? mk.virtual_token_reserves : curve.virtual_token_reserves);
  const n = Number(tokens);
  const gross = (n * vq) / (vt + n) / SOL;
  return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / SOL;
};

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coinOf(
          e.mint,
          e.slot,
          e.creator,
          Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        );
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          const sol = Number(e.sol_amount) / SOL;
          c.trades++;
          c.lastTradeSlot = e.slot;
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else c.devSold = true;
          } else {
            if (e.is_buy) {
              c.bought += sol;
              c.buyers.add(e.user);
            } else {
              c.sold += sol;
            }
          }
        }
        traded.add(e.mint);
      } else if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) c.decided = true;
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / SOL;
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // Exits first: take profit, stop loss, time limit, creator sold, stale.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c !== undefined && c.lastTradeSlot > h.lastTradeSlot) h.lastTradeSlot = c.lastTradeSlot;
      const value = closeValue(state, batch, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / SOL;
      let exit = false;
      if (value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD) exit = true;
      if (!exit && c !== undefined && c.devSold) exit = true;
      if (!exit && now - h.lastTradeSlot > STALE_SLOTS) exit = true;
      if (!exit) continue;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      if (!selling) probes.set(mint, true);
    }

    // Entries: young coins only, rug filter first, one buy per coin.
    let free = Number(state.freeCashLamports()) / SOL;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      const c = coins.get(mint);
      if (c === undefined || c.decided) continue;
      const age = now - c.created;
      if (age > MAX_AGE) {
        c.decided = true;
        continue;
      }
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      const rqSol = Number(curve.real_quote_reserves) / SOL;
      // Rug filter: a big creator buy, a bundled launch, or a creator who
      // already sold all mean the opening tape cannot be trusted.
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      if (c.devBuy > MAX_DEV_BUY_SOL) {
        c.decided = true;
        continue;
      }
      if (c.buyers.size > MAX_OPEN_BUYERS) {
        c.decided = true;
        continue;
      }
      if (c.devSold) {
        c.decided = true;
        continue;
      }
      if (c.trades < MIN_TRADES || c.bought - c.sold <= 0) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      if (c.createPrice > 0 && price / c.createPrice - 1 > MAX_RUNUP) {
        c.decided = true;
        continue;
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * SOL));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      c.decided = true;
      held.set(mint, { opened: now, lastTradeSlot: c.lastTradeSlot });
      free -= amount + tx;
      slotsLeft--;
    }

    // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / SOL < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * SOL)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
