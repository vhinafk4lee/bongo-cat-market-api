/**
 * Vercel Serverless Function: /api/market
 * -------------------------------------------
 * Uses the `steam-market` npm package (https://github.com/vladpuz/steam-market)
 * to fetch, server-side and without logging in:
 *   1. priceOverview      — lowest price / median price / volume
 *   2. itemOrdersHistogram — the FULL live order book (every price tier,
 *      buy orders AND sell orders), not a static snapshot.
 *
 * The library automatically finds Steam's internal `item_nameid` for us
 * via listings(...).itemNameId() — no manual DevTools digging needed.
 *
 * Cached in-memory for CACHE_MS to avoid hammering Steam. If Steam fails
 * (429 etc.) but we have a previous successful result, we serve that
 * instead of an error.
 */

import SteamMarket from 'steam-market';

const APP_ID = 3419430;
const MARKET_HASH_NAME = 'Robin Hood Hat';
const CACHE_MS = 90 * 1000; // 90 seconds

// Persists only while this serverless instance stays "warm". Vercel may
// spin up a fresh instance at any time, resetting the cache — this is a
// soft optimization, not a guarantee.
let cache = { data: null, timestamp: 0 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.status(200).json(cache.data);
    return;
  }

  try {
    const market = new SteamMarket();

    const [priceOverview, listings] = await Promise.all([
      market.priceOverview(APP_ID, MARKET_HASH_NAME),
      market.listings(APP_ID, MARKET_HASH_NAME),
    ]);

    const itemNameId = await listings.itemNameId();
    const histogram = await market.itemOrdersHistogram(
      APP_ID,
      MARKET_HASH_NAME,
      itemNameId,
    );

    const payload = {
      success: true,
      price: {
        lowestPrice: priceOverview.lowestPrice ?? null,
        medianPrice: priceOverview.medianPrice ?? null,
        volume: priceOverview.volume ?? null,
      },
      orderBook: {
        // Each entry: { price, quantity } — quantity here is the
        // CUMULATIVE volume at/beyond that price tier, matching how
        // Steam's own histogram graph works.
        buyOrders: (histogram.buyOrderGraph ?? []).map((p) => ({
          price: p.price,
          cumulativeQuantity: p.volume,
        })),
        sellOrders: (histogram.sellOrderGraph ?? []).map((p) => ({
          price: p.price,
          cumulativeQuantity: p.volume,
        })),
        highestBuyOrder: histogram.highestBuyOrder ?? null,
        lowestSellOrder: histogram.lowestSellOrder ?? null,
        sellOrderSummary: histogram.sellOrderSummary ?? null, // e.g. "4,757 for sale"
        buyOrderSummary: histogram.buyOrderSummary ?? null,
      },
      fetchedAt: new Date().toISOString(),
      stale: false,
    };

    cache = { data: payload, timestamp: now };
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE-FALLBACK');
      res.status(200).json({ ...cache.data, stale: true, staleReason: String(err) });
      return;
    }
    res.status(502).json({
      success: false,
      error: String(err && err.message ? err.message : err),
    });
  }
}
