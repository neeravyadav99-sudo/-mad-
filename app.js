const BINANCE_BASE = "https://api.binance.com";
const QUOTE_ASSET = "USDT";
const TREND_LENGTH = 16;
const STARRED_BASES = new Set(["BTC", "ETH", "ZEC"]);
const EXCLUDED_BASES = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "DAI",
  "USDP",
  "USTC",
  "EUR",
  "TRY",
  "BRL",
  "GBP",
  "AUD"
]);

const els = {
  refreshButton: document.querySelector("#refreshButton"),
  scanStatus: document.querySelector("#scanStatus"),
  universeMode: document.querySelector("#universeMode"),
  customSymbolsWrap: document.querySelector("#customSymbolsWrap"),
  customSymbols: document.querySelector("#customSymbols"),
  timeframe: document.querySelector("#timeframe"),
  symbolLimit: document.querySelector("#symbolLimit"),
  scannedCount: document.querySelector("#scannedCount"),
  uptrendCount: document.querySelector("#uptrendCount"),
  downtrendCount: document.querySelector("#downtrendCount"),
  lastUpdate: document.querySelector("#lastUpdate"),
  uptrendButton: document.querySelector("#uptrendButton"),
  downtrendButton: document.querySelector("#downtrendButton"),
  radarBody: document.querySelector("#radarBody")
};

const state = {
  isScanning: false,
  mode: "up",
  results: {
    up: [],
    down: []
  }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNumber(value, maximumFractionDigits = 2) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits
  }).format(value);
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 8;
  return formatNumber(value, digits);
}

function setStatus(text) {
  els.scanStatus.textContent = text;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

function symbolToBase(symbol) {
  return symbol.endsWith(QUOTE_ASSET) ? symbol.slice(0, -QUOTE_ASSET.length) : symbol;
}

async function getTopVolumeSymbols(limit) {
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo`),
    fetchJson(`${BINANCE_BASE}/api/v3/ticker/24hr`)
  ]);

  const spotSymbols = new Set(
    exchangeInfo.symbols
      .filter(item =>
        item.status === "TRADING" &&
        item.isSpotTradingAllowed &&
        item.quoteAsset === QUOTE_ASSET &&
        !EXCLUDED_BASES.has(item.baseAsset)
      )
      .map(item => item.symbol)
  );

  return tickers
    .filter(item => spotSymbols.has(item.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, limit)
    .map(item => item.symbol);
}

function parseCustomSymbols(limit) {
  const symbols = els.customSymbols.value
    .split(/[\s,]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
    .map(item => item.endsWith(QUOTE_ASSET) ? item : `${item}${QUOTE_ASSET}`);

  return [...new Set(symbols)].slice(0, limit);
}

async function getKlines(symbol, interval) {
  const limit = interval === "1d" ? 140 : 240;
  const data = await fetchJson(`${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return data.map(item => ({
    time: item[0],
    closeTime: item[6],
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[7])
  }));
}

function calculateTrendSeries(values, length, phase = 50, power = 2) {
  const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
  const beta = 0.45 * (length - 1) / (0.45 * (length - 1) + 2);
  const alpha = Math.pow(beta, power);
  const series = [];

  let e0 = values[0];
  let e1 = 0;
  let e2 = 0;
  let prevTrend = values[0];

  for (const source of values) {
    e0 = (1 - alpha) * source + alpha * e0;
    e1 = (source - e0) * (1 - beta) + beta * e1;
    e2 = (e0 + phaseRatio * e1 - prevTrend) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2;
    prevTrend = e2 + prevTrend;
    series.push(prevTrend);
  }

  return series;
}

function getTrendDirection(candles, trend, index) {
  if (index < 2) {
    return null;
  }

  const currentTrend = trend[index];
  const previousTrend = trend[index - 1];
  const twoBackTrend = trend[index - 2];
  const currentClose = candles[index].close;
  const previousClose = candles[index - 1].close;

  if (
    currentTrend > previousTrend &&
    previousTrend > twoBackTrend &&
    currentClose > currentTrend &&
    previousClose > previousTrend
  ) {
    return "up";
  }

  if (
    currentTrend < previousTrend &&
    previousTrend < twoBackTrend &&
    currentClose < currentTrend &&
    previousClose < previousTrend
  ) {
    return "down";
  }

  return null;
}

function getTrendLineDirection(trend, index) {
  if (index < 1) {
    return null;
  }

  if (trend[index] > trend[index - 1]) {
    return "up";
  }

  if (trend[index] < trend[index - 1]) {
    return "down";
  }

  return null;
}

function findConversionIndex(trend, direction) {
  let index = trend.length - 1;

  while (index > 1 && getTrendLineDirection(trend, index - 1) === direction) {
    index -= 1;
  }

  return index;
}

function formatConvertedAt(timestamp) {
  const daysAgo = getConvertedDaysAgo(timestamp);

  if (daysAgo === 0) {
    return "Today";
  }

  if (daysAgo === 1) {
    return "Yesterday";
  }

  return `${daysAgo + 1}D ago`;
}

function getConvertedDaysAgo(timestamp) {
  const eventDate = new Date(timestamp);
  const today = new Date();
  const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return Math.max(0, Math.floor((todayDay - eventDay) / 86400000));
}

function getConvertedClass(timestamp) {
  const daysAgo = getConvertedDaysAgo(timestamp);

  if (daysAgo === 0) {
    return "today";
  }

  if (daysAgo === 1) {
    return "yesterday";
  }

  return "older";
}

async function scanSymbol(symbol, interval, trendLength) {
  const candles = await getKlines(symbol, interval);
  if (candles.length < trendLength + 5) {
    throw new Error("Not enough candle history");
  }

  const closes = candles.map(item => item.close);
  const trend = calculateTrendSeries(closes, trendLength);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const currentTrend = trend[trend.length - 1];
  const direction = getTrendDirection(candles, trend, candles.length - 1);
  const changePct = previous.close ? (last.close - previous.close) / previous.close * 100 : 0;
  const distancePct = currentTrend ? (last.close - currentTrend) / currentTrend * 100 : 0;
  const conversionIndex = direction ? findConversionIndex(trend, direction) : null;

  return {
    symbol,
    base: symbolToBase(symbol),
    price: last.close,
    changePct,
    volume: last.volume,
    distancePct,
    direction,
    convertedAt: conversionIndex === null ? null : candles[conversionIndex].time
  };
}

function getActiveRows() {
  return state.results[state.mode];
}

function renderModeButtons() {
  els.uptrendButton.classList.toggle("active", state.mode === "up");
  els.downtrendButton.classList.toggle("active", state.mode === "down");
}

function renderRows() {
  const rows = getActiveRows();
  const isUpMode = state.mode === "up";

  if (!rows.length) {
    const direction = isUpMode ? "uptrend" : "downtrend";
    els.radarBody.innerHTML = `<tr><td colspan="7" class="empty">No confirmed ${direction} found.</td></tr>`;
    return;
  }

  const sorted = [...rows].sort((a, b) => {
    const ageDiff = getConvertedDaysAgo(a.convertedAt) - getConvertedDaysAgo(b.convertedAt);
    if (ageDiff !== 0) {
      return ageDiff;
    }

    return isUpMode ? b.distancePct - a.distancePct : a.distancePct - b.distancePct;
  });

  els.radarBody.innerHTML = sorted.map((row, index) => {
    const changeClass = row.changePct >= 0 ? "positive" : "negative";
    const trendClass = isUpMode ? "up" : "down";
    const label = isUpMode ? "Buy" : "Sell";
    const convertedLabel = row.convertedAt ? formatConvertedAt(row.convertedAt) : "-";
    const convertedClass = row.convertedAt ? getConvertedClass(row.convertedAt) : "";
    const isStarred = STARRED_BASES.has(row.base);
    const star = isStarred ? `<span class="star">★</span>` : "";

    return `
      <tr class="${trendClass}">
        <td>${index + 1}</td>
        <td><span class="coin ${isStarred ? "starred" : ""}"><span class="dot"></span>${star}${row.base}</span></td>
        <td><span class="badge ${trendClass}">${label}</span></td>
        <td><span class="converted ${convertedClass}">${convertedLabel}</span></td>
        <td>$${formatPrice(row.price)}</td>
        <td class="${changeClass}">${row.changePct >= 0 ? "+" : ""}${formatNumber(row.changePct, 2)}%</td>
        <td>$${formatNumber(row.volume, 0)}</td>
      </tr>
    `;
  }).join("");
}

function renderStats(scannedCount) {
  els.scannedCount.textContent = scannedCount;
  els.uptrendCount.textContent = state.results.up.length;
  els.downtrendCount.textContent = state.results.down.length;
  els.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function runScan() {
  if (state.isScanning) {
    return;
  }

  const limit = Math.max(5, Math.min(80, Number(els.symbolLimit.value) || 50));
  const interval = els.timeframe.value;

  state.isScanning = true;
  els.refreshButton.disabled = true;
  state.results = {
    up: [],
    down: []
  };
  els.radarBody.innerHTML = `<tr><td colspan="7" class="empty">Scanning market...</td></tr>`;
  renderModeButtons();
  renderStats(0);

  try {
    const symbols = els.universeMode.value === "custom"
      ? parseCustomSymbols(limit)
      : await getTopVolumeSymbols(limit);

    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index];
      setStatus(`Scanning ${index + 1}/${symbols.length}: ${symbol}`);

      try {
        const result = await scanSymbol(symbol, interval, TREND_LENGTH);
        if (result.direction === "up") {
          state.results.up.push(result);
        } else if (result.direction === "down") {
          state.results.down.push(result);
        }
      } catch (error) {
        console.warn(`Skipping ${symbol}:`, error);
      } finally {
        renderRows();
        renderStats(index + 1);
      }

      await sleep(90);
    }

    setStatus(`Done: ${state.results.up.length} buy, ${state.results.down.length} sell`);
  } catch (error) {
    console.error(error);
    setStatus("Scan failed");
    els.radarBody.innerHTML = `<tr><td colspan="7" class="empty">Scan failed: ${error.message}</td></tr>`;
  } finally {
    state.isScanning = false;
    els.refreshButton.disabled = false;
  }
}

function setMode(mode) {
  state.mode = mode;
  renderModeButtons();
  renderRows();
}

els.refreshButton.addEventListener("click", runScan);
els.uptrendButton.addEventListener("click", () => setMode("up"));
els.downtrendButton.addEventListener("click", () => setMode("down"));
els.universeMode.addEventListener("change", () => {
  els.customSymbolsWrap.hidden = els.universeMode.value !== "custom";
});

function getNextAutoRefreshDelay() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(5, 30, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next - now;
}

function scheduleDailyRefresh() {
  window.setTimeout(async () => {
    await runScan();
    scheduleDailyRefresh();
  }, getNextAutoRefreshDelay());
}

renderModeButtons();
runScan();
scheduleDailyRefresh();
