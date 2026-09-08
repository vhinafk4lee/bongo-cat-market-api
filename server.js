/**
 * Railway deployment: plain Node.js HTTP server
 * -------------------------------------------------
 * Same logic as the Vercel version, adapted to run as a long-lived
 * process (Railway doesn't use the /api serverless-function convention
 * Vercel does — it just runs `node server.js` and keeps it alive).
 *
 * Uses the `steam-market` npm package (https://github.com/vladpuz/steam-market)
 * to fetch, server-side and without logging in:
 *   1. priceOverview       — lowest price / median price / volume
 *   2. itemOrdersHistogram — the FULL live order book (buy + sell orders
 *      at every price tier), found automatically via the item's
 *      internal item_nameid (no manual DevTools digging needed).
 *
 * Cached in-memory for CACHE_MS. If Steam fails (429 etc.) but we have a
 * previous successful result, we serve that instead of an error.
 */

import http from 'node:http';
import SteamMarket from 'steam-market';

const APP_ID = 3419430;
const MARKET_HASH_NAME = 'Robin Hood Hat';
const CACHE_MS = 90 * 1000; // 90 seconds
const PORT = process.env.PORT || 3000;

let cache = { data: null, timestamp: 0 };

async function fetchMarketData() {
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

  return {
    success: true,
    price: {
      lowestPrice: priceOverview.lowestPrice ?? null,
      medianPrice: priceOverview.medianPrice ?? null,
      volume: priceOverview.volume ?? null,
    },
    orderBook: {
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
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', endpoint: '/api/market' }));
    return;
  }

  if (url.pathname !== '/api/market') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
    return;
  }

  const now = Date.now();

  if (cache.data && now - cache.timestamp < CACHE_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
    res.end(JSON.stringify(cache.data));
    return;
  }

  try {
    const payload = await fetchMarketData();
    cache = { data: payload, timestamp: now };
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
    res.end(JSON.stringify(payload));
  } catch (err) {
    if (cache.data) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'STALE-FALLBACK' });
      res.end(JSON.stringify({ ...cache.data, stale: true, staleReason: String(err) }));
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: String(err && err.message ? err.message : err),
    }));
  }
});

server.listen(PORT, () => {
  console.log(`Market API listening on port ${PORT}`);
});
