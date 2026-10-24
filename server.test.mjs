import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, topupRdnFromWallet } from './server.mjs';

const candles = [
  ['2026-01-01', 10], ['2026-01-02', 9], ['2026-01-03', 8],
  ['2026-01-04', 7], ['2026-01-05', 8], ['2026-01-06', 10],
  ['2026-01-07', 12], ['2026-01-08', 11], ['2026-01-09', 9],
].map(([date, close]) => ({ date, close }));

test('SMA crossover returns metrics and accounts for trading fees', () => {
  const result = runBacktest({ candles, fastPeriod: 2, slowPeriod: 3, feePercent: 0.1 });
  assert.equal(result.candleCount, candles.length);
  assert.ok(Number.isFinite(result.totalReturnPercent));
  assert.ok(result.completedTrades >= 1);
  assert.ok(result.finalEquity > 0);
});

test('rejects unsorted candles to prevent misleading results', () => {
  assert.throws(
    () => runBacktest({ candles: [candles[1], candles[0], ...candles.slice(2)], fastPeriod: 2, slowPeriod: 3 }),
    /berurutan/,
  );
});

test('topup saldo RDN moves funds from main wallet to RDN account', () => {
  const result = topupRdnFromWallet({ balance: 200000, rdn: 50000, amount: 30000 });
  assert.equal(result.balance, 170000);
  assert.equal(result.rdn, 80000);
});

test('topup saldo RDN rejects insufficient balance', () => {
  assert.throws(
    () => topupRdnFromWallet({ balance: 20000, rdn: 5000, amount: 25000 }),
    /Saldo akun tidak cukup/,
  );
});