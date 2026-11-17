// Dip-buy mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Idea: on 1-minute bars the pool price whipsaws, and a full-size round trip
// costs ~26-37 bps in fee, slippage and impact, so frequent trading loses.
// This bot trades rarely and only on clear signals: it buys a 4-hour dip of
// more than 80 bps (mean reversion: the dip usually recovers within hours),
// sells at +120 bps above its entry, and caps a bad trade with a -250 bps
// stop. If no dip ever comes it buys once late (bar 1200) so the run always
// makes at least one trade. It never buys in the last 10 bars, where a fill
// would leave no time to reach the target before the final flatten.
//
// All decisions use exact bigint arithmetic on the raw close prices, so two
// runs on the same bars produce byte-identical orders. No clock, no network,
// no randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Bars of history a dip is measured over (240 one-minute bars = 4 hours). */
const LOOKBACK_BARS = 240;
/** Buy when the trailing LOOKBACK_BARS return is below this, in bps. */
const DIP_BPS = -80n;
/** Sell when the close is this far above the entry close, in bps. */
const TAKE_PROFIT_BPS = 120n;
/** Sell when the close is this far below the entry close, in bps. */
const STOP_BPS = -250n;
/** If still flat by this batch, buy once so the run always trades. */
const FALLBACK_BAR = 1200;
/** No new buys at or after this batch (a late fill has no room to work). */
const LAST_BUY_BAR = 1430;
/** Per-order slippage bound from the latest close, in bps. */
const MAX_SLIPPAGE_BPS = 100;
/** A buy must spend at least this much (the harness's 1 USDC minimum). */
const MIN_BUY_QUOTE_UNITS = 1_000_000n;

const BPS = 10000n;

/** Raw closes of CBBTC, in the order their bars arrived. */
const closes: bigint[] = [];
/** True from the moment a buy is decided until a sell is decided. */
let holding = false;
/** The close of the bar on which the current position's buy was decided. */
let entryClose: bigint | null = null;

function returnBps(now: bigint, then: bigint): bigint {
  return ((now - then) * BPS) / then;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Reconcile with the fills of the orders decided on the previous batch: a
  // rejected buy means we never held, a rejected sell means we still hold.
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status !== 'rejected') continue;
    if (fill.side === 'buy') {
      holding = false;
      entryClose = null;
    } else if (fill.side === 'sell') {
      holding = true;
    }
  }

  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return []; // CBBTC missing this minute: no signal.
  const close = BigInt(bar.c);
  closes.push(close);

  if (state.warmingUp) return []; // warm-up batches cannot trade.
  if (closes.length <= LOOKBACK_BARS) return []; // not enough history yet.

  if (!holding) {
    const dip = returnBps(close, closes[closes.length - 1 - LOOKBACK_BARS]!);
    const fallback = state.seq >= FALLBACK_BAR;
    if ((dip < DIP_BPS || fallback) && state.seq <= LAST_BUY_BAR && state.cash >= MIN_BUY_QUOTE_UNITS) {
      holding = true;
      entryClose = close;
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Holding: exit on take-profit or stop, measured from the entry close.
  if (entryClose === null) return [];
  const ret = returnBps(close, entryClose);
  if (ret > TAKE_PROFIT_BPS || ret < STOP_BPS) {
    const position = state.positions.get(SYMBOL);
    if (position === undefined || position.qty === 0n) return []; // fill not landed yet; retry next bar.
    holding = false;
    entryClose = null;
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: position.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

await runBars({ onBatch });
