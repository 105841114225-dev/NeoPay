import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) {
      throw Object.assign(new Error('Ukuran data maksimal 2 MB.'), { status: 413 });
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('Format JSON tidak valid.'), { status: 400 });
  }
}

function movingAverage(closes, end, period) {
  let total = 0;
  for (let index = end - period + 1; index <= end; index += 1) total += closes[index];
  return total / period;
}

export function topupRdnFromWallet(input, rdn, amount, bank = 'Akun utama') {
  const params = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input
    : { balance: input, rdn, amount, bank };

  const numericBalance = Number(params.balance);
  const numericRdn = Number(params.rdn);
  const numericAmount = Number(params.amount);

  if (!Number.isFinite(numericBalance) || !Number.isFinite(numericRdn) || !Number.isFinite(numericAmount)) {
    throw new Error('Data saldo tidak valid.');
  }
  if (numericAmount <= 0) {
    throw new Error('Nominal top-up harus lebih dari 0.');
  }
  if (numericAmount > numericBalance) {
    throw new Error('Saldo akun tidak cukup untuk top up RDN.');
  }

  return {
    balance: numericBalance - numericAmount,
    rdn: numericRdn + numericAmount,
    bank: String(params.bank || 'Akun utama').trim() || 'Akun utama',
  };
}

export function runBacktest({ candles, fastPeriod, slowPeriod, feePercent = 0.1 }) {
  if (!Array.isArray(candles) || candles.length > 20_000) {
    throw new Error('Data harus berisi maksimal 20.000 candle.');
  }
  if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod)
      || fastPeriod < 2 || slowPeriod <= fastPeriod || slowPeriod > 500) {
    throw new Error('Periode harus bilangan bulat: 2 <= cepat < lambat <= 500.');
  }
  if (candles.length < slowPeriod + 2) {
    throw new Error(`Data harus berisi ${slowPeriod + 2} sampai 20.000 candle.`);
  }
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 5) {
    throw new Error('Biaya transaksi harus antara 0 dan 5 persen.');
  }

  const dates = [];
  const closes = [];
  for (const candle of candles) {
    const timestamp = Date.parse(candle?.date);
    const close = Number(candle?.close);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) {
      throw new Error('Setiap candle harus memiliki tanggal valid dan harga penutupan positif.');
    }
    if (dates.length && timestamp <= dates.at(-1)) {
      throw new Error('Tanggal candle harus unik dan berurutan dari lama ke baru.');
    }
    dates.push(timestamp);
    closes.push(close);
  }

  const fee = feePercent / 100;
  let cash = 1;
  let units = 0;
  let entryPrice = 0;
  let peak = 1;
  let maxDrawdownPercent = 0;
  let completedTrades = 0;
  let winningTrades = 0;
  let positionCapital = 0;

  for (let index = slowPeriod + 1; index < closes.length; index += 1) {
    const signalIndex = index - 1;
    const fastNow = movingAverage(closes, signalIndex, fastPeriod);
    const slowNow = movingAverage(closes, signalIndex, slowPeriod);
    const fastBefore = movingAverage(closes, signalIndex - 1, fastPeriod);
    const slowBefore = movingAverage(closes, signalIndex - 1, slowPeriod);
    const crossUp = fastBefore <= slowBefore && fastNow > slowNow;
    const crossDown = fastBefore >= slowBefore && fastNow < slowNow;
    const price = closes[index];

    if (crossUp && units === 0) {
      positionCapital = cash;
      units = cash * (1 - fee) / price;
      cash = 0;
      entryPrice = price;
    } else if (crossDown && units > 0) {
      cash = units * price * (1 - fee);
      if (cash > positionCapital) winningTrades += 1;
      completedTrades += 1;
      units = 0;
      entryPrice = 0;
    }

    const equity = cash + units * price;
    peak = Math.max(peak, equity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equity) / peak * 100);
  }

  const finalEquity = cash + units * closes.at(-1);
  const buyAndHoldReturnPercent = ((closes.at(-1) / closes[0]) - 1) * 100;
  return {
    initialCapital: 1,
    finalEquity,
    totalReturnPercent: (finalEquity - 1) * 100,
    buyAndHoldReturnPercent,
    maxDrawdownPercent,
    completedTrades,
    winRatePercent: completedTrades ? winningTrades / completedTrades * 100 : 0,
    openPosition: units > 0,
    openPositionReturnPercent: units > 0 ? (closes.at(-1) / entryPrice - 1) * 100 : null,
    candleCount: candles.length,
  };
}

async function serveFile(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const resolvedPath = path.resolve(root, `.${requestedPath}`);
  if (!resolvedPath.startsWith(`${root}${path.sep}`)) {
    json(response, 403, { error: 'Akses ditolak.' });
    return;
  }
  try {
    const content = await readFile(resolvedPath);
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(resolvedPath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'File tidak ditemukan.' });
  }
}

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { ok: true, service: 'dompetku-api' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/backtest') {
    try {
      const payload = await readJson(request);
      json(response, 200, runBacktest(payload));
    } catch (error) {
      json(response, error.status || 400, { error: error.message || 'Backtest gagal.' });
    }
    return;
  }
  if (request.method === 'GET') {
    await serveFile(response, url.pathname);
    return;
  }
  json(response, 405, { error: 'Metode tidak didukung.' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => console.log(`Dompetku berjalan di http://localhost:${port}`));
}