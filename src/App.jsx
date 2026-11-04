import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  TrendingUp, TrendingDown, DollarSign, Activity, Zap, AlertTriangle, Wind,
  Settings, RefreshCw, Clock, Cpu, ShieldAlert, Newspaper
} from 'lucide-react';

import { supabase } from './services/supabaseClient';
import { COMPANY_META } from './config/constants';
import { getIndoMonth } from './utils/formatters';
import {
  summarizeStock, nextBusinessDays, runBacktest, STRATEGIES, timeAgo, generateDemoRows
} from './utils/analytics';
import BentoCard from './components/BentoCard';
import StockLogo from './components/StockLogo';

// --- TEMA (Deep Navy & Neon) ---
const C = {
  bg: '#0B1330',
  card: '#16213F',
  cardBorder: '#2A3A6B',
  royal: '#1B3AA8',
  royalBorder: '#3D6BFF',
  mint: '#5FD3A6',
  periwinkle: '#4C66C4',
  neon: '#4B8BF5',
  text: '#E0E7FF',
  buy: '#34D399',
  sell: '#F87171',
  hold: '#FACC15',
  forecast: '#F5C542',
};

const SIGNAL_COLOR = { BUY: C.buy, SELL: C.sell, HOLD: C.hold };
const SENTIMENT_BADGE = {
  positive: 'bg-emerald-500 text-white',
  negative: 'bg-red-500 text-white',
  neutral: 'bg-blue-600 text-white',
};

const usd = (v, digits = 2) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pct = (v, digits = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
const shortDate = (d) => `${d.getDate()} ${getIndoMonth(d.getMonth())}`;
const longDate = (d) => d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const App = () => {
  // --- STATE ---
  const [priceHistory, setPriceHistory] = useState({}); // { AAPL: [{ datetime, open, high, low, close }, ...] } lama -> baru
  const [forecasts, setForecasts] = useState({}); // { AAPL: baris terbaru forecast_results }
  const [dataSource, setDataSource] = useState(null); // 'live' (Supabase) atau 'demo' (data simulasi)
  const [selectedCode, setSelectedCode] = useState(null);
  const [newsData, setNewsData] = useState([]);
  const [strategyKey, setStrategyKey] = useState('trend200');
  const [showConfig, setShowConfig] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const [simRunning, setSimRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // --- DATA FETCHING (Supabase, fallback ke data simulasi jika gagal/kosong) ---
  const fetchMarketData = useCallback(async () => {
    const codes = Object.keys(COMPANY_META);
    let history = {};

    try {
      // Tabel stock_prices diisi oleh collector/stock_fetcher.py (data harian, ~1 tahun)
      const results = await Promise.all(codes.map(code =>
        supabase
          .from('stock_prices')
          .select('datetime, open, high, low, close')
          .eq('ticker', code)
          .order('datetime', { ascending: false })
          .limit(260)
      ));
      results.forEach(({ data, error }, i) => {
        if (error) throw error;
        if (data && data.length >= 2) history[codes[i]] = [...data].reverse();
      });

      // Tabel forecast_results diisi oleh processing/forecasting.py; ambil baris terbaru per saham
      const { data: fc, error: fcError } = await supabase
        .from('forecast_results')
        .select('symbol, signal, predicted_price, last_price, forecast_5d, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (fcError) console.warn('Gagal mengambil forecast dari Supabase:', fcError);
      const latest = {};
      (fc || []).forEach(row => { if (!latest[row.symbol]) latest[row.symbol] = row; });
      setForecasts(latest);
    } catch (err) {
      console.warn('Gagal mengambil data dari Supabase, memakai data simulasi:', err);
      history = {};
    }

    if (Object.keys(history).length > 0) {
      setDataSource('live');
    } else {
      history = Object.fromEntries(codes.map((code, i) => [code, generateDemoRows(100 + i * 60)]));
      setForecasts({});
      setDataSource('demo');
    }

    setPriceHistory(history);
    setSelectedCode(prev => prev || Object.keys(history)[0]);
  }, []);

  const fetchNews = useCallback(async () => {
    if (!selectedCode) return;

    if (dataSource === 'live') {
      // Tabel news_sentiment diisi oleh collector/news_fetcher.py + sentiment.py
      const { data, error } = await supabase
        .from('news_sentiment')
        .select('id, title, source, url, sentiment_label, published_at')
        .eq('symbol', selectedCode)
        .order('published_at', { ascending: false })
        .limit(100);
      if (error) console.warn('Gagal mengambil berita dari Supabase:', error);
      setNewsData((data || []).map(n => ({
        id: n.id ?? n.url,
        title: n.title,
        source: n.source || 'News',
        url: n.url,
        publishedAt: n.published_at,
        sentiment: (n.sentiment_label || 'neutral').toLowerCase(),
      })));
      return;
    }

    const now = new Date().toISOString();
    setNewsData([
      { id: 1, title: `Harga ${selectedCode} diprediksi naik setelah rilis laporan Q3.`, source: 'News Source A', sentiment: 'positive', publishedAt: now },
      { id: 2, title: 'Volatilitas pasar menahan laju pertumbuhan sektor teknologi.', source: 'Tech Daily', sentiment: 'neutral', publishedAt: now },
      { id: 3, title: `Analisis teknikal menunjukkan sinyal jual kuat untuk ${selectedCode}.`, source: 'Market Insight', sentiment: 'negative', publishedAt: now },
    ]);
  }, [selectedCode, dataSource]);

  useEffect(() => { fetchMarketData(); }, [fetchMarketData]);
  useEffect(() => { fetchNews(); }, [fetchNews]);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchMarketData(), fetchNews()]);
    setRefreshing(false);
  };

  // Waktu run pipeline terakhir = forecast terbaru yang tersimpan
  const lastPipelineRun = useMemo(() => {
    const times = Object.values(forecasts).map(f => new Date(f.created_at).getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }, [forecasts]);

  // --- DATA TURUNAN ---
  const rows = priceHistory[selectedCode];
  const stock = useMemo(() => (rows ? summarizeStock(rows) : null), [rows]);
  const forecast = forecasts[selectedCode];
  const forecast5d = Array.isArray(forecast?.forecast_5d) ? forecast.forecast_5d : null;

  const stockList = useMemo(() => Object.entries(priceHistory).map(([code, r]) => ({
    code,
    change: r[r.length - 1].close / r[r.length - 2].close - 1,
  })), [priceHistory]);

  const recommendation = useMemo(() => {
    if (!stock) return null;
    if (forecast5d) {
      const trend = forecast5d[forecast5d.length - 1] / stock.price - 1;
      return { signal: forecast.signal || 'HOLD', trend, target: forecast5d[forecast5d.length - 1], basis: 'TREND OVER 5 DAYS' };
    }
    // Tanpa hasil model: aturan sederhana dari perubahan 24 jam
    const signal = stock.change > 0.01 ? 'BUY' : stock.change < -0.01 ? 'SELL' : 'HOLD';
    return { signal, trend: stock.change, target: null, basis: 'BERDASARKAN PERUBAHAN 24 JAM' };
  }, [stock, forecast, forecast5d]);

  const chartData = useMemo(() => {
    if (!rows) return [];
    const hist = rows.slice(-30).map(r => ({ label: shortDate(new Date(r.datetime)), price: r.close, forecast: null }));
    if (!forecast5d) return hist;
    // Titik terakhir histori ikut jadi awal garis prediksi supaya tersambung
    hist[hist.length - 1].forecast = hist[hist.length - 1].price;
    const dates = nextBusinessDays(new Date(rows[rows.length - 1].datetime), forecast5d.length);
    return [...hist, ...forecast5d.map((p, i) => ({ label: shortDate(dates[i]), price: null, forecast: p }))];
  }, [rows, forecast5d]);

  const sentiment30 = useMemo(() => {
    const cutoff = Date.now() - 30 * 86400000;
    const recent = newsData.filter(n => !n.publishedAt || new Date(n.publishedAt).getTime() >= cutoff);
    const count = s => recent.filter(n => n.sentiment === s).length;
    const total = recent.length;
    return {
      total,
      parts: [
        { key: 'positive', label: 'Positif', n: count('positive'), color: C.buy },
        { key: 'neutral', label: 'Netral', n: count('neutral'), color: '#60A5FA' },
        { key: 'negative', label: 'Negatif', n: count('negative'), color: C.sell },
      ].map(p => ({ ...p, share: total ? p.n / total : 0 })),
    };
  }, [newsData]);

  const activities = useMemo(() => {
    if (!stock) return [];
    const items = [];
    if (forecast5d) {
      const t = recommendation.trend;
      items.push({
        id: 'ai', source: 'AI Model', icon: Cpu, time: forecast.created_at,
        sentiment: t > 0.01 ? 'positive' : t < -0.01 ? 'negative' : 'neutral',
        title: `Harga ${selectedCode} diprediksi ${t >= 0 ? 'naik' : 'turun'} ${Math.abs(t * 100).toFixed(2)}% dalam 5 hari ke depan (${usd(recommendation.target)}).`,
      });
    }
    items.push({
      id: 'system', source: 'System Alert', icon: ShieldAlert, time: stock.lastDate,
      sentiment: stock.isAnomaly ? 'negative' : 'neutral',
      title: stock.isAnomaly
        ? `Anomali harga terdeteksi: z-score ${stock.zScore.toFixed(2)} di luar batas ±3σ.`
        : `Harga ${selectedCode} dalam rentang normal (z-score ${stock.zScore.toFixed(2)}), volatilitas ${stock.regime === 'HIGH VOL' ? 'tinggi' : 'rendah'}.`,
    });
    newsData.slice(0, 15).forEach(n => items.push({ ...n, icon: Newspaper, time: n.publishedAt }));
    return items;
  }, [stock, forecast, forecast5d, recommendation, newsData, selectedCode]);

  // --- STRATEGY SIMULATOR ---
  const runSimulation = useCallback(() => {
    if (!rows) return;
    setSimRunning(true);
    // Jeda singkat supaya tombol terlihat bekerja
    setTimeout(() => {
      setSimulation(runBacktest(rows, strategyKey));
      setSimRunning(false);
    }, 300);
  }, [rows, strategyKey]);

  // Jalankan otomatis saat saham berganti agar kartu selalu terisi
  useEffect(() => { if (rows) setSimulation(runBacktest(rows, strategyKey)); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!stock) {
    return (
      <div className="min-h-screen flex items-center justify-center font-sans" style={{ backgroundColor: C.bg, color: C.text }}>
        <RefreshCw className="animate-spin mr-2" /> Loading Dashboard...
      </div>
    );
  }

  const signalColor = SIGNAL_COLOR[recommendation.signal] || C.hold;
  const isUp = stock.change >= 0;

  return (
    <div className="min-h-screen w-full p-3 sm:p-5 font-sans" style={{ backgroundColor: C.bg, color: C.text }}>
      <div className="max-w-[1600px] mx-auto space-y-4">

        {/* JUDUL */}
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="w-10 h-10" />
            <div>
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">Dashboard Analitik Saham</h1>
              <p className="text-sm text-slate-400">Harga harian, sentimen berita, dan prediksi 5 hari untuk 9 saham teknologi AS</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-400">
            <span className="flex items-center gap-2" title={dataSource === 'live' ? 'Data diambil dari Supabase' : 'Supabase tidak dapat diakses atau kosong, menampilkan data simulasi'}>
              <span className={`w-2 h-2 rounded-full ${dataSource === 'live' ? 'bg-emerald-400' : 'bg-yellow-400'}`} />
              <span className="text-slate-200">{dataSource === 'live' ? 'Live dari Supabase' : 'Data demo'}</span>
            </span>
            {lastPipelineRun && <span>Pipeline terakhir: {timeAgo(lastPipelineRun)}</span>}
            <button onClick={refreshAll} disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-slate-200 hover:bg-white/5 disabled:opacity-60 transition-colors">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Muat ulang
            </button>
          </div>
        </header>

        {/* 0. DAFTAR SAHAM */}
        <div className="rounded-2xl border px-3 py-3" style={{ backgroundColor: C.card, borderColor: C.cardBorder }}>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar">
            {stockList.map(({ code, change }) => {
              const active = code === selectedCode;
              return (
                <button
                  key={code}
                  onClick={() => setSelectedCode(code)}
                  className={`flex-shrink-0 flex items-center gap-2 pl-2 pr-4 py-2 rounded-xl transition-all duration-200 ${active ? 'shadow-xl' : 'opacity-75 hover:opacity-100 hover:bg-white/5'}`}
                  style={active ? { backgroundColor: C.royal } : undefined}
                >
                  <StockLogo code={code} className="w-9 h-9" />
                  <span className="text-left leading-tight">
                    <span className="block font-bold text-sm">{code}</span>
                    <span className={`block text-[11px] font-semibold ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pct(change)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. HEADER + KEY INFORMATION */}
        <div className="grid grid-cols-12 gap-4">
          <div
            className="col-span-12 lg:col-span-8 rounded-2xl border p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5"
            style={{ backgroundColor: C.royal, borderColor: C.royalBorder }}
          >
            <StockLogo code={selectedCode} className="w-16 h-16 sm:w-20 sm:h-20 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold tracking-wide text-blue-200">{selectedCode} · NASDAQ</p>
              <h2 className="font-display font-extrabold tracking-tight tabular-nums text-3xl sm:text-4xl text-white leading-tight truncate">{COMPANY_META[selectedCode]?.name}</h2>
            </div>
            <div className="sm:text-right">
              <p className="text-sm text-blue-200">Penutupan {longDate(stock.lastDate)}</p>
              <p className="font-display font-extrabold tracking-tight tabular-nums text-4xl sm:text-5xl text-white mt-1">{usd(stock.price)}</p>
              <span className={`mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold ${isUp ? 'bg-emerald-500/25 text-emerald-300' : 'bg-red-500/25 text-red-300'}`}>
                {isUp ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />} {pct(stock.change)}
              </span>
            </div>
          </div>

          <div className="col-span-12 lg:col-span-4 rounded-2xl p-5 flex flex-col justify-center" style={{ backgroundColor: C.mint, color: '#10203F' }}>
            <p className="text-base font-bold border-b border-[#10203F]/20 pb-3 mb-4">Key Information</p>
            <div className="grid grid-cols-3 gap-3">
              <KeyItem icon={DollarSign} label="Price" value={usd(stock.price)} />
              <KeyItem icon={Activity} label="Change" value={pct(stock.change)} valueClass={isUp ? 'text-emerald-800' : 'text-red-600'} />
              <KeyItem icon={Zap} label="Regime" value={stock.regime} />
            </div>
          </div>
        </div>

        {/* 2. SENTIMEN, REKOMENDASI, ANOMALI, REGIME */}
        <div className="grid grid-cols-12 gap-4">
          <BentoCard title="News Sentiment Breakdown (30D)" className="col-span-12 md:col-span-6 xl:col-span-4" style={{ backgroundColor: C.periwinkle, borderColor: '#6F86DA' }}>
            {sentiment30.total > 0 ? (
              <>
                <div className="flex h-4 w-full rounded-full overflow-hidden bg-white/20">
                  {sentiment30.parts.filter(p => p.n > 0).map(p => (
                    <div key={p.key} style={{ width: `${p.share * 100}%`, backgroundColor: p.color }} title={`${p.label}: ${p.n}`} />
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                  {sentiment30.parts.map(p => (
                    <div key={p.key}>
                      <p className="text-xs uppercase text-blue-100 flex items-center justify-center gap-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} /> {p.label}
                      </p>
                      <p className="text-xl font-extrabold text-white">{Math.round(p.share * 100)}%</p>
                      <p className="text-[11px] text-blue-100">{p.n} berita</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-blue-100">Belum ada berita 30 hari terakhir.</p>
            )}
          </BentoCard>

          <div className="col-span-12 md:col-span-6 xl:col-span-4 rounded-2xl border p-5 flex flex-col items-center justify-center text-center" style={{ backgroundColor: C.card, borderColor: C.cardBorder }}>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Recommended Action</p>
            <p className="font-display font-extrabold tracking-tight tabular-nums text-5xl my-2" style={{ color: signalColor }}>{recommendation.signal}</p>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{recommendation.basis}</p>
            {recommendation.target !== null && (
              <p className="text-sm text-slate-300 mt-2 tabular-nums">Prediksi hari ke-5: {usd(recommendation.target)} ({pct(recommendation.trend)})</p>
            )}
          </div>

          <StatusCard
            className="col-span-6 xl:col-span-2" borderColor={C.cardBorder}
            title="Anomaly" value={stock.isAnomaly ? 'ANOMALY' : 'NORMAL'} valueColor={stock.isAnomaly ? '#FB923C' : '#3FBF95'}
            icon={AlertTriangle} note={stock.isAnomaly ? `Z-score ${stock.zScore.toFixed(2)} (di luar ±3σ)` : `Normal Trading Range · z ${stock.zScore.toFixed(2)}`}
          />
          <StatusCard
            className="col-span-6 xl:col-span-2" borderColor={C.cardBorder}
            title="Regime" value={stock.regime} valueColor={stock.regime === 'HIGH VOL' ? '#FB923C' : C.neon}
            icon={Wind} note={`Vol Index: ${stock.volatility.toFixed(4)}`}
          />
        </div>

        {/* 3. BAGIAN BAWAH: kiri (chart + statistik), kanan (simulator + berita) */}
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
            <BentoCard title={`Chart Historical${forecast5d ? ' & Forecast (30D + 5D)' : ' (30D)'}`} style={{ backgroundColor: C.card, borderColor: C.cardBorder }}
              action={forecast5d && (
                <div className="flex items-center gap-4 text-xs text-gray-300">
                  <span className="flex items-center gap-1"><span className="w-3 h-0.5" style={{ backgroundColor: C.neon }} /> Historis</span>
                  <span className="flex items-center gap-1"><span className="w-3 border-t-2 border-dashed" style={{ borderColor: C.forecast }} /> Prediksi AI</span>
                </div>
              )}>
              <div className="h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.neon} stopOpacity={0.7} />
                        <stop offset="95%" stopColor={C.neon} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorForecast" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.forecast} stopOpacity={0.6} />
                        <stop offset="95%" stopColor={C.forecast} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="4 4" stroke="#2A3A6B" />
                    <XAxis dataKey="label" stroke="#6B7AA6" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={20} />
                    <YAxis stroke="#6B7AA6" tickFormatter={v => `$${Math.round(v).toLocaleString('en-US')}`} domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={70} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area type="monotone" dataKey="price" stroke={C.neon} strokeWidth={3} fill="url(#colorPrice)" dot={false} connectNulls={false} />
                    <Area type="monotone" dataKey="forecast" stroke={C.forecast} strokeWidth={3} strokeDasharray="6 5" fill="url(#colorForecast)" dot={false} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </BentoCard>

            <BentoCard title="Statistik Deskriptif & Volatilitas" style={{ backgroundColor: C.card, borderColor: C.cardBorder }}>
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Sesi terakhir · {longDate(stock.lastDate)}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Open" value={usd(stock.session.open)} />
                <StatBox label="High" value={usd(stock.session.high)} color="text-emerald-400" />
                <StatBox label="Low" value={usd(stock.session.low)} color="text-red-400" />
                <StatBox label="Vol." value={stock.volatility.toFixed(4)} hint="Std. return harian 20D" />
              </div>
              <p className="text-xs uppercase tracking-wide text-gray-400 mt-5 mb-2">30 hari terakhir (harga penutupan)</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox label="Rata-rata" value={usd(stock.stats30.mean)} />
                <StatBox label="Std. Deviasi" value={usd(stock.stats30.std)} />
                <StatBox label="Minimum" value={usd(stock.stats30.min)} color="text-red-400" />
                <StatBox label="Maksimum" value={usd(stock.stats30.max)} color="text-emerald-400" />
              </div>
            </BentoCard>
          </div>

          <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
            <BentoCard title="Strategy Simulator" style={{ backgroundColor: C.card, borderColor: C.cardBorder }}>
              <div className="flex items-center justify-between gap-3">
                <Settings className="w-5 h-5 text-gray-300" />
                <span className="font-semibold">Backtest Setting</span>
                <button onClick={() => setShowConfig(v => !v)} className="text-sm px-4 py-1 rounded-full bg-blue-700 hover:bg-blue-600 transition-colors">
                  {showConfig ? 'Tutup' : 'Configure'}
                </button>
              </div>

              {showConfig && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {Object.entries(STRATEGIES).map(([key, s]) => (
                    <button key={key} onClick={() => setStrategyKey(key)}
                      className={`text-xs text-left px-3 py-2 rounded-lg border transition-colors ${strategyKey === key ? 'border-blue-400 bg-blue-900/60 text-white' : 'border-white/10 text-gray-300 hover:bg-white/5'}`}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-4 rounded-xl p-4" style={{ backgroundColor: '#1D2A4F' }}>
                {simulation ? (
                  <>
                    <p className="text-sm text-gray-300">Last Simulation: <span className="font-bold text-white">{simulation.label}</span></p>
                    <p className={`text-2xl font-extrabold mt-1 ${simulation.strategyReturn >= 0 ? 'text-yellow-300' : 'text-red-400'}`}>
                      {pct(simulation.strategyReturn, 1)} Return (Sim.)
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                      Buy &amp; Hold: {pct(simulation.buyHoldReturn, 1)} · {simulation.trades} transaksi · {simulation.days} hari bursa sejak {shortDate(simulation.from)} {simulation.from.getFullYear()}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400">Data belum cukup untuk {STRATEGIES[strategyKey].label}.</p>
                )}
              </div>

              <button onClick={runSimulation} disabled={simRunning}
                className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-white bg-green-600 hover:bg-green-500 disabled:opacity-70 transition-colors">
                <RefreshCw className={`w-4 h-4 ${simRunning ? 'animate-spin' : ''}`} /> Run Simulation
              </button>
            </BentoCard>

            <BentoCard title="Recent Activities / News Feed" className="flex-1 flex flex-col min-h-0" style={{ backgroundColor: C.card, borderColor: C.cardBorder }}>
              <div className="space-y-3 overflow-y-auto custom-scroll pr-2 max-h-[420px]">
                {activities.map(item => (
                  <ActivityItem key={item.id} item={item} />
                ))}
              </div>
            </BentoCard>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="flex flex-col md:flex-row md:justify-between gap-2 pt-4 border-t border-white/10 text-xs text-slate-500">
          <p>Sumber data: Yahoo Finance (harga &amp; berita) · Sentimen: VADER · Prediksi: Random Forest · Diperbarui otomatis tiap 4 jam oleh Apache Airflow</p>
          <p>Hanya untuk keperluan analisis dan pembelajaran, bukan saran investasi.</p>
        </footer>
      </div>
    </div>
  );
};

// --- KOMPONEN PEMBANTU ---
const KeyItem = ({ icon: Icon, label, value, valueClass = 'text-[#10203F]' }) => (
  <div className="text-center min-w-0">
    <p className="text-xs uppercase flex items-center justify-center gap-1 text-[#10203F]/80"><Icon className="w-4 h-4" /> {label}</p>
    <p className={`font-display font-extrabold tracking-tight tabular-nums text-xl sm:text-2xl mt-1 break-words ${valueClass}`}>{value}</p>
  </div>
);

const StatusCard = ({ className, borderColor, title, value, valueColor, icon: Icon, note }) => (
  <div className={`${className} rounded-2xl border p-4 flex flex-col`} style={{ backgroundColor: C.card, borderColor }}>
    <p className="text-base font-semibold pb-3 mb-3 border-b border-white/10">{title}</p>
    <div className="flex items-center justify-between gap-2">
      <p className="font-display font-extrabold tracking-tight tabular-nums text-2xl leading-none" style={{ color: valueColor }}>{value}</p>
      <Icon className="w-7 h-7 shrink-0" style={{ color: valueColor }} />
    </div>
    <p className="text-xs text-gray-300 mt-2">{note}</p>
  </div>
);

const StatBox = ({ label, value, color = 'text-white', hint }) => (
  <div className="rounded-xl p-3 text-center" style={{ backgroundColor: '#1D2A4F' }} title={hint}>
    <p className="text-xs text-gray-400">{label}</p>
    <p className={`text-lg font-extrabold mt-1 ${color}`}>{value}</p>
  </div>
);

const ActivityItem = ({ item }) => {
  const Icon = item.icon;
  const content = (
    <div className="rounded-xl p-3 transition-colors hover:bg-[#25345F]" style={{ backgroundColor: '#1D2A4F' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold text-white min-w-0">
          <Icon className="w-4 h-4 shrink-0 text-blue-300" /> <span className="truncate">{item.source}</span>
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase shrink-0 ${SENTIMENT_BADGE[item.sentiment] || SENTIMENT_BADGE.neutral}`}>
          {item.sentiment}
        </span>
      </div>
      <p className="text-sm mt-1.5 leading-snug text-gray-100">{item.title}</p>
      {item.time && (
        <p className="text-xs text-gray-400 mt-1.5 flex items-center gap-1"><Clock className="w-3 h-3" /> {timeAgo(item.time)}</p>
      )}
    </div>
  );
  return item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="block">{content}</a> : content;
};

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload) return null;
  const point = payload.find(p => p.value !== null && p.value !== undefined);
  if (!point) return null;
  const isForecast = point.dataKey === 'forecast' && point.payload.price === null;
  return (
    <div className="p-3 rounded-lg shadow-lg text-sm" style={{ backgroundColor: C.card, border: `1px solid ${isForecast ? C.forecast : C.neon}` }}>
      <p className="font-bold text-gray-300">{label}</p>
      <p className="text-white mt-1">{isForecast ? 'Prediksi' : 'Harga'}: {usd(point.value)}</p>
    </div>
  );
};

export default App;
