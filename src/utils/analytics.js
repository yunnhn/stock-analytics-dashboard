// Perhitungan analitik di sisi web, dari baris harga harian (urut lama -> baru)
// Bentuk baris: { datetime, open, high, low, close }

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1));
};

// Batas volatilitas harian untuk regime (sama dengan versi sebelumnya)
export const HIGH_VOL_THRESHOLD = 0.03;

export function summarizeStock(rows) {
  const closes = rows.map((r) => r.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const returns = closes.slice(1).map((c, i) => c / closes[i] - 1);

  // Volatilitas = standar deviasi return harian 20 hari terakhir
  const volatility = stdev(returns.slice(-20));

  // Anomali = rolling z-score harga 20 hari > 3 (sama dengan processing/anomaly_detection.py)
  const win = closes.slice(-20);
  const winStd = stdev(win);
  const zScore = winStd ? (last - mean(win)) / winStd : 0;

  const last30 = closes.slice(-30);
  const lastRow = rows[rows.length - 1];

  return {
    price: last,
    change: prev ? last / prev - 1 : 0,
    volatility,
    regime: volatility >= HIGH_VOL_THRESHOLD ? 'HIGH VOL' : 'LOW VOL',
    zScore,
    isAnomaly: Math.abs(zScore) > 3,
    lastDate: new Date(lastRow.datetime),
    session: { open: lastRow.open, high: lastRow.high, low: lastRow.low, close: lastRow.close },
    stats30: { mean: mean(last30), std: stdev(last30), min: Math.min(...last30), max: Math.max(...last30) },
  };
}

// Tanggal bursa berikutnya (lewati Sabtu/Minggu)
export function nextBusinessDays(from, n) {
  const days = [];
  const d = new Date(from);
  while (days.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d));
  }
  return days;
}

export const STRATEGIES = {
  trend200: { label: 'Trend Following (200D MA)', type: 'ma', window: 200 },
  trend50: { label: 'Trend Following (50D MA)', type: 'ma', window: 50 },
  cross: { label: 'MA Crossover (5/20)', type: 'cross', fast: 5, slow: 20 },
  hold: { label: 'Buy & Hold', type: 'hold' },
};

const sma = (closes, i, window) => (i + 1 < window ? null : mean(closes.slice(i + 1 - window, i + 1)));

// Backtest sederhana: posisi hari t ditentukan sinyal penutupan hari t-1, tanpa biaya transaksi
export function runBacktest(rows, strategyKey) {
  const strat = STRATEGIES[strategyKey];
  const closes = rows.map((r) => r.close);

  const signalAt = (i) => {
    if (strat.type === 'hold') return 1;
    if (strat.type === 'ma') {
      const ma = sma(closes, i, strat.window);
      return ma === null ? null : closes[i] > ma ? 1 : 0;
    }
    const fast = sma(closes, i, strat.fast);
    const slow = sma(closes, i, strat.slow);
    return slow === null ? null : fast > slow ? 1 : 0;
  };

  const start = closes.findIndex((_, i) => signalAt(i) !== null);
  if (start < 0 || start >= closes.length - 1) return null;

  let equity = 1;
  let trades = 0;
  let prevPos = 0;
  for (let i = start + 1; i < closes.length; i++) {
    const pos = signalAt(i - 1);
    if (pos === 1 && prevPos === 0) trades++;
    equity *= 1 + pos * (closes[i] / closes[i - 1] - 1);
    prevPos = pos;
  }

  return {
    label: strat.label,
    strategyReturn: equity - 1,
    buyHoldReturn: closes[closes.length - 1] / closes[start] - 1,
    trades,
    days: closes.length - 1 - start,
    from: new Date(rows[start].datetime),
  };
}

export function timeAgo(date) {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'Baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

// Data simulasi (dipakai jika Supabase tidak bisa diakses)
export function generateDemoRows(basePrice, days = 260) {
  const rows = [];
  const dates = nextBusinessDays(new Date(Date.now() - days * 1.45 * 86400000), days);
  let close = basePrice;
  for (const d of dates) {
    const open = close * (1 + (Math.random() - 0.5) * 0.01);
    close = open * (1 + (Math.random() - 0.48) * 0.03);
    rows.push({
      datetime: d.toISOString(),
      open,
      high: Math.max(open, close) * (1 + Math.random() * 0.01),
      low: Math.min(open, close) * (1 - Math.random() * 0.01),
      close,
    });
  }
  return rows;
}
