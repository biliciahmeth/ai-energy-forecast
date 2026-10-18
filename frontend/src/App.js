import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip as LeafletTooltip, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
import {
  LineChart, Line, ComposedChart, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import './App.css';
import WIND_FARMS from './data/windFarms.json';

const API = 'https://ai-energy-forecast.onrender.com';

// ── Referans sistem varsayımları (gerçek bir santral/kurulum değil, örnek göstergedir) ──
const TURBINE = { cutIn: 3, rated: 12, cutOut: 25, ratedPowerKW: 2000, hubHeight: 80, measureHeight: 10, shearExp: 0.14 };
const PV = { capacityKW: 5, performanceRatio: 0.8 }; // 5 kWp çatı tipi kurulum
// Türkiye şebeke elektriği için yaklaşık/gösterge amaçlı ortalama emisyon faktörü.
// Kaynaktan kaynağa değişir (~380-470 gCO2/kWh); kesin bir resmi rakam değil, karşılaştırma içindir.
const GRID_EMISSION_FACTOR = 442; // gCO2/kWh

const MODELS = {
  GRAP: { label: 'GraphCast', color: '#f97316' },
  FOUR: { label: 'FourCastNet', color: '#a855f7' },
  PANG: { label: 'Pangu-Weather', color: '#10b981' },
  AURO: { label: 'Aurora', color: '#06b6d4' },
};
const MODEL_KEYS = Object.keys(MODELS);

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

const pinIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

const pointBIcon = new L.DivIcon({
  html: '<div class="point-b-marker">B</div>',
  className: '',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

function windPowerKW(speedAt10m) {
  if (speedAt10m == null || Number.isNaN(speedAt10m)) return null;
  const vHub = speedAt10m * Math.pow(TURBINE.hubHeight / TURBINE.measureHeight, TURBINE.shearExp);
  if (vHub < TURBINE.cutIn || vHub >= TURBINE.cutOut) return 0;
  if (vHub >= TURBINE.rated) return TURBINE.ratedPowerKW;
  const frac = (vHub ** 3 - TURBINE.cutIn ** 3) / (TURBINE.rated ** 3 - TURBINE.cutIn ** 3);
  return Math.max(0, TURBINE.ratedPowerKW * frac);
}

function solarPowerKW(irradianceWm2) {
  if (irradianceWm2 == null || Number.isNaN(irradianceWm2)) return null;
  return Math.max(0, PV.capacityKW * (irradianceWm2 / 1000) * PV.performanceRatio);
}

function round(value, digits) {
  return value == null || Number.isNaN(value) ? null : parseFloat(value.toFixed(digits));
}

const TOLERANCE_MS = 3 * 60 * 60 * 1000;
function matchByTime(targetMs, series) {
  let best = null;
  let bestDiff = Infinity;
  for (const d of series) {
    const diff = Math.abs(d.tsMs - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return best && bestDiff <= TOLERANCE_MS ? best : null;
}

function buildAiSeries(rows, selLat, selLon) {
  const byTimestamp = new Map();
  for (const d of rows) {
    const dist = (d.lat - selLat) ** 2 + (d.lon - selLon) ** 2;
    const existing = byTimestamp.get(d.timestamp);
    if (!existing || dist < existing.dist) byTimestamp.set(d.timestamp, { row: d, dist });
  }
  return Array.from(byTimestamp.values()).map(({ row: d }) => {
    const windSpeed = parseFloat(Math.sqrt(d.u10 ** 2 + d.v10 ** 2).toFixed(2));
    return {
      tsMs: new Date(d.timestamp).getTime(),
      windSpeed,
      t2: parseFloat((d.t2 - 273.15).toFixed(1)),
      msl: parseFloat((d.msl / 100).toFixed(1)),
    };
  }).sort((a, b) => a.tsMs - b.tsMs);
}

function downloadCSV(rows, filename) {
  if (!rows.length) return;
  const cols = [
    'time', 'windSpeedMeteo',
    ...MODEL_KEYS.map(code => `windSpeed${code}`),
    'ensembleMean', 'ensembleStd',
    't2Meteo', 'mslMeteo', 'irradiance', 'windPowerMeteo', 'solarPowerMeteo',
  ];
  const header = cols.join(',');
  const lines = rows.map(r => cols.map(c => (r[c] ?? '')).join(','));
  const csv = [header, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function LocationPicker({ onSelect }) {
  useMapEvents({
    click(e) {
      onSelect(e.latlng.lat, e.latlng.lng);
    }
  });
  return null;
}

function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 9, { duration: 1.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return null;
}

function HeatLayer({ points, dark }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return undefined;
    const layer = L.heatLayer(points, {
      radius: 22,
      blur: 25,
      maxZoom: 8,
      max: 1,
      minOpacity: 0.25,
      gradient: dark
        ? { 0.2: '#1d4ed8', 0.45: '#16a34a', 0.7: '#eab308', 1: '#ef4444' }
        : { 0.2: '#3b82f6', 0.45: '#22c55e', 0.7: '#eab308', 1: '#dc2626' },
    }).addTo(map);
    return () => { map.removeLayer(layer); };
  }, [map, points, dark]);
  return null;
}

function SkeletonCard() {
  return <div className="skeleton skeleton-card" />;
}
function SkeletonChart() {
  return <div className="skeleton skeleton-chart" />;
}

function App() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);
  const dark = theme === 'dark';
  const chartTheme = {
    grid: dark ? '#273041' : '#f3f4f6',
    tick: dark ? '#7b8699' : '#9ca3af',
    tooltipBg: dark ? '#1a2130' : '#fff',
    tooltipBorder: dark ? '#2d3648' : '#e5e7eb',
  };

  const [selectedLat, setSelectedLat] = useState(null);
  const [selectedLon, setSelectedLon] = useState(null);
  const [flyTarget, setFlyTarget] = useState(null);
  const [region, setRegion] = useState('turkey');
  // GRAP+FOUR en uzun süredir arşivde olan/en güvenilir iki model — varsayılan
  // olarak açık. PANG+AURO yeni eklendi, grafik kalabalaşmasın diye kapalı
  // başlıyor; isteyen tek tıkla açabiliyor.
  const [enabledModels, setEnabledModels] = useState({ GRAP: true, FOUR: true, PANG: false, AURO: false });
  const toggleModel = (code) => setEnabledModels(prev => ({ ...prev, [code]: !prev[code] }));
  const setAllModels = (value) => setEnabledModels(Object.fromEntries(MODEL_KEYS.map(k => [k, value])));
  const [meteoData, setMeteoData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showMeteo, setShowMeteo] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const [heatmap, setHeatmap] = useState([]);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [heatmapModel, setHeatmapModel] = useState('GRAP');

  const [compareMode, setCompareMode] = useState(false);
  const [pointB, setPointB] = useState(null);
  const [meteoDataB, setMeteoDataB] = useState([]);
  const [loadingB, setLoadingB] = useState(false);

  const handleLocationSelect = (lat, lon) => {
    if (compareMode && selectedLat != null) {
      setPointB({ lat: lat.toFixed(2), lon: lon.toFixed(2) });
    } else {
      setSelectedLat(lat.toFixed(2));
      setSelectedLon(lon.toFixed(2));
    }
    setSearchResults([]);
  };

  const runSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { format: 'json', q: searchQuery, limit: 5 }
      });
      setSearchResults(res.data || []);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  };

  const pickSearchResult = (r) => {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    handleLocationSelect(lat, lon);
    setFlyTarget([lat, lon]);
    setSearchQuery(r.display_name.split(',')[0]);
  };

  const fetchPointData = useCallback(async (lat, lon) => {
    const selLat = parseFloat(lat), selLon = parseFloat(lon);
    const [meteoRes, ...modelResList] = await Promise.all([
      axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: lat,
          longitude: lon,
          hourly: 'temperature_2m,windspeed_10m,pressure_msl,shortwave_radiation',
          forecast_days: 10,
          timezone: 'auto',
          windspeed_unit: 'ms',
        }
      }),
      ...MODEL_KEYS.map(code =>
        axios.get(`${API}/forecast`, { params: { model: code, region, lat, lon } }).catch(() => ({ data: { data: [] } }))
      ),
    ]);

    const seriesByModel = {};
    MODEL_KEYS.forEach((code, i) => {
      seriesByModel[code] = buildAiSeries(modelResList[i].data.data || [], selLat, selLon);
    });

    const hourly = meteoRes.data.hourly;
    return hourly.time
      .filter((_, i) => i % 6 === 0)
      .map((ts, i) => {
        const idx = i * 6;
        const tsMs = new Date(ts).getTime();
        const windSpeedMeteo = parseFloat(hourly.windspeed_10m[idx]?.toFixed(2));
        const irradiance = hourly.shortwave_radiation[idx] ?? 0;
        const row = {
          tsMs,
          time: new Date(ts).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric', hour: '2-digit' }),
          dateKey: new Date(ts).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' }),
          windSpeedMeteo,
          t2Meteo: parseFloat(hourly.temperature_2m[idx]?.toFixed(1)),
          mslMeteo: parseFloat(hourly.pressure_msl[idx]?.toFixed(1)),
          irradiance: round(irradiance, 0),
          windPowerMeteo: round(windPowerKW(windSpeedMeteo), 0),
          solarPowerMeteo: round(solarPowerKW(irradiance), 1),
        };
        const speeds = [];
        MODEL_KEYS.forEach(code => {
          const m = matchByTime(tsMs, seriesByModel[code]);
          row[`windSpeed${code}`] = m ? m.windSpeed : null;
          row[`t2${code}`] = m ? m.t2 : null;
          row[`msl${code}`] = m ? m.msl : null;
          if (m) speeds.push(m.windSpeed);
        });
        row.ensembleN = speeds.length;
        if (speeds.length >= 1) {
          const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
          row.ensembleMean = round(mean, 2);
          row.ensembleStd = speeds.length >= 2
            ? round(Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length), 2)
            : null;
        } else {
          row.ensembleMean = null;
          row.ensembleStd = null;
        }
        return row;
      });
  }, [region]);

  useEffect(() => {
    if (!selectedLat || !selectedLon) return;
    let cancelled = false;
    setLoading(true);
    fetchPointData(selectedLat, selectedLon)
      .then(m => { if (!cancelled) setMeteoData(m); })
      .catch(err => console.error(err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedLat, selectedLon, fetchPointData]);

  useEffect(() => {
    if (!compareMode || !pointB) { setMeteoDataB([]); return undefined; }
    let cancelled = false;
    setLoadingB(true);
    fetchPointData(pointB.lat, pointB.lon)
      .then(m => { if (!cancelled) setMeteoDataB(m); })
      .catch(err => console.error(err))
      .finally(() => { if (!cancelled) setLoadingB(false); });
    return () => { cancelled = true; };
  }, [compareMode, pointB, fetchPointData]);

  // Türkiye geneli rüzgar potansiyeli ısı haritası — seçilen modelin verisinden
  // nokta başına ortalama rüzgar gücü hesaplanır. Model değişince yeniden çekilir.
  useEffect(() => {
    (async () => {
      setHeatmapLoading(true);
      try {
        const res = await axios.get(`${API}/forecast`, { params: { model: heatmapModel, region: 'turkey', limit: 2000 } });
        const rows = res.data.data || [];
        const byCell = new Map();
        for (const d of rows) {
          const key = `${d.lat},${d.lon}`;
          const speed = Math.sqrt(d.u10 ** 2 + d.v10 ** 2);
          if (!byCell.has(key)) byCell.set(key, { lat: d.lat, lon: d.lon, sum: 0, n: 0 });
          const cell = byCell.get(key);
          cell.sum += speed;
          cell.n += 1;
        }
        const cells = Array.from(byCell.values()).map(c => {
          const avgSpeed = c.sum / c.n;
          return { lat: c.lat, lon: c.lon, avgSpeed, avgPowerKW: windPowerKW(avgSpeed) };
        }).sort((a, b) => b.avgPowerKW - a.avgPowerKW);
        setHeatmap(cells);
      } catch {
        setHeatmap([]);
      }
      setHeatmapLoading(false);
    })();
  }, [heatmapModel]);

  // Her santral için en yakın ısı haritası grid hücresindeki rüzgar hızından
  // genel referans türbin eğrisiyle bir kapasite faktörü çıkarıp, santralin
  // gerçek kurulu gücüne (capacity_mw) ölçekliyoruz — gerçek türbin modeli
  // bilinmediği için yaklaşık/gösterge amaçlı bir tahmindir.
  const windFarmsWithOutput = useMemo(() => {
    if (heatmap.length === 0) return [];
    return WIND_FARMS.map(farm => {
      let nearest = null, bestDist = Infinity;
      for (const c of heatmap) {
        const dist = (c.lat - farm.lat) ** 2 + (c.lon - farm.lon) ** 2;
        if (dist < bestDist) { bestDist = dist; nearest = c; }
      }
      const capacityFactor = nearest ? nearest.avgPowerKW / TURBINE.ratedPowerKW : null;
      const estimatedOutputMW = farm.capacity_mw != null && capacityFactor != null
        ? farm.capacity_mw * capacityFactor
        : null;
      return { ...farm, avgSpeed: nearest?.avgSpeed ?? null, capacityFactor, estimatedOutputMW };
    });
  }, [heatmap]);

  const heatPoints = useMemo(() => {
    if (heatmap.length === 0) return [];
    const maxPower = heatmap[0].avgPowerKW || 1;
    return heatmap.map(c => [c.lat, c.lon, Math.max(0.05, c.avgPowerKW / maxPower)]);
  }, [heatmap]);

  const aiAvailableByModel = useMemo(() => {
    const out = {};
    MODEL_KEYS.forEach(code => { out[code] = meteoData.some(d => d[`windSpeed${code}`] != null); });
    return out;
  }, [meteoData]);
  const anyAiAvailable = MODEL_KEYS.some(code => aiAvailableByModel[code]);
  const availableModelCount = MODEL_KEYS.filter(code => aiAvailableByModel[code]).length;

  // Ensemble tutarlılığı: modellerin birbirine ne kadar yakın tahmin verdiği
  // (düşük CV = modeller hemfikir, yüksek CV = modeller arası belirsizlik yüksek)
  const ensembleStats = useMemo(() => {
    const withEnsemble = meteoData.filter(d => d.ensembleN >= 2 && d.ensembleMean > 0);
    if (!withEnsemble.length) return null;
    const avgCV = withEnsemble.reduce((s, d) => s + d.ensembleStd / d.ensembleMean, 0) / withEnsemble.length;
    let label, color;
    if (avgCV < 0.15) { label = 'Yüksek Tutarlılık'; color = '#16a34a'; }
    else if (avgCV < 0.30) { label = 'Orta Tutarlılık'; color = '#eab308'; }
    else { label = 'Düşük Tutarlılık'; color = '#ef4444'; }
    return { avgCV, label, color, n: withEnsemble.length };
  }, [meteoData]);

  // Modeller arası ikili korelasyon (Pearson r), ortak zaman noktaları üzerinden
  const correlationMatrix = useMemo(() => {
    const matrix = {};
    for (const a of MODEL_KEYS) {
      matrix[a] = {};
      for (const b of MODEL_KEYS) {
        if (a === b) { matrix[a][b] = 1; continue; }
        const pairs = meteoData
          .map(d => [d[`windSpeed${a}`], d[`windSpeed${b}`]])
          .filter(([x, y]) => x != null && y != null);
        matrix[a][b] = pairs.length >= 3 ? pearson(pairs.map(p => p[0]), pairs.map(p => p[1])) : null;
      }
    }
    return matrix;
  }, [meteoData]);

  const regionCenters = {
    turkey: [39, 35],
    europe: [54, 10],
    america: [40, -100],
    africa: [0, 20],
  };

  // Önümüzdeki 24 saatlik (4 nokta, 6'şar saat) ortalamalara göre özet üretim göstergeleri
  const next24 = meteoData.slice(0, 4);
  const avgWindPower = next24.length
    ? next24.reduce((s, d) => s + (d.windPowerMeteo || 0), 0) / next24.length
    : null;
  const avgSolarPower = next24.length
    ? next24.reduce((s, d) => s + (d.solarPowerMeteo || 0), 0) / next24.length
    : null;
  const windCapacityFactor = avgWindPower != null ? (avgWindPower / TURBINE.ratedPowerKW) * 100 : null;
  const estDailyKWh = avgWindPower != null && avgSolarPower != null
    ? (avgWindPower + avgSolarPower) * 24
    : null;
  const dailyCO2SavedKg = estDailyKWh != null ? (estDailyKWh * GRID_EMISSION_FACTOR) / 1000 : null;

  // Haftalık özet: güne göre ortalama toplam güç, en verimli 3 gün
  const bestDays = useMemo(() => {
    const byDay = new Map();
    for (const d of meteoData) {
      if (!byDay.has(d.dateKey)) byDay.set(d.dateKey, { day: d.dateKey, sum: 0, n: 0 });
      const entry = byDay.get(d.dateKey);
      entry.sum += (d.windPowerMeteo || 0) + (d.solarPowerMeteo || 0);
      entry.n += 1;
    }
    return Array.from(byDay.values())
      .map(e => ({ day: e.day, avgPower: e.sum / e.n }))
      .sort((a, b) => b.avgPower - a.avgPower)
      .slice(0, 3);
  }, [meteoData]);

  const topLocations = heatmap.slice(0, 10);

  // Karşılaştırma modu: B noktası için aynı özet göstergeler + A/B birleşik güç grafiği
  const next24B = meteoDataB.slice(0, 4);
  const avgWindPowerB = next24B.length
    ? next24B.reduce((s, d) => s + (d.windPowerMeteo || 0), 0) / next24B.length
    : null;
  const avgSolarPowerB = next24B.length
    ? next24B.reduce((s, d) => s + (d.solarPowerMeteo || 0), 0) / next24B.length
    : null;
  const estDailyKWhB = avgWindPowerB != null && avgSolarPowerB != null
    ? (avgWindPowerB + avgSolarPowerB) * 24
    : null;

  const comparisonData = useMemo(() => {
    if (!compareMode || !pointB || meteoDataB.length === 0) return [];
    const len = Math.max(meteoData.length, meteoDataB.length);
    const out = [];
    for (let i = 0; i < len; i++) {
      const a = meteoData[i], b = meteoDataB[i];
      out.push({
        time: a?.time ?? b?.time,
        totalPowerA: a ? (a.windPowerMeteo || 0) + (a.solarPowerMeteo || 0) : null,
        totalPowerB: b ? (b.windPowerMeteo || 0) + (b.solarPowerMeteo || 0) : null,
      });
    }
    return out;
  }, [compareMode, pointB, meteoData, meteoDataB]);

  return (
    <div className="app">

      <header className="header">
        <div className="header-inner">
          <div className="header-logo">
            <span className="logo-icon">⚡</span>
            <h1>AI Energy Forecast</h1>
          </div>
          <div className="header-right">
            <span className="header-sub">NOAA MLWP · GraphCast · FourCastNet · Pangu-Weather · Aurora</span>
            <button className="theme-toggle" onClick={() => setTheme(dark ? 'light' : 'dark')} title="Tema değiştir">
              {dark ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-text">
          <h2>Rüzgar ve Güneş Enerjisi<br /><span>AI ile Tahmin</span></h2>
          <p>Dünyanın herhangi bir noktası için NOAA açık meteoroloji verisi ve yapay zeka modelleriyle rüzgar hızı, sıcaklık, atmosfer basıncı ve tahmini enerji üretimi.</p>
        </div>
      </section>

      <div className="stats-bar">
        <div className="stat-item">
          <span className="stat-value">4</span>
          <span className="stat-label">AI Model</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">4</span>
          <span className="stat-label">Bölge</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">24s</span>
          <span className="stat-label">Güncelleme</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">NOAA</span>
          <span className="stat-label">Açık Veri</span>
        </div>
      </div>

      <form className="search-bar" onSubmit={runSearch}>
        <input
          type="text"
          placeholder="🔍 Bir şehir ara (örn. İzmir, Berlin, Texas)..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        <button type="submit" disabled={searching}>{searching ? '...' : 'Ara'}</button>
        {searchResults.length > 0 && (
          <ul className="search-results">
            {searchResults.map((r, i) => (
              <li key={i} onClick={() => pickSearchResult(r)}>{r.display_name}</li>
            ))}
          </ul>
        )}
      </form>

      <div className="controls">
        <div className="control-group">
          <label>Modeller</label>
          <div className="model-checkboxes">
            {MODEL_KEYS.map(code => (
              <label className="chip" key={code} style={{ '--chip-color': MODELS[code].color }}>
                <input type="checkbox" checked={enabledModels[code]} onChange={() => toggleModel(code)} />
                {MODELS[code].label}
              </label>
            ))}
            <button type="button" className="model-quick-btn" onClick={() => setAllModels(true)}>Tümü</button>
            <button type="button" className="model-quick-btn" onClick={() => setAllModels(false)}>Temizle</button>
          </div>
        </div>
        <div className="control-group">
          <label>Bölge</label>
          <select value={region} onChange={e => setRegion(e.target.value)}>
            <option value="turkey">Türkiye</option>
            <option value="europe">Avrupa</option>
            <option value="america">Amerika</option>
            <option value="africa">Afrika</option>
          </select>
        </div>
        {selectedLat && (
          <div className="selected-info">
            📍 A: {selectedLat}°N, {selectedLon}°E
          </div>
        )}
        <div className="control-group">
          <label>&nbsp;</label>
          <button
            type="button"
            className={`compare-btn ${compareMode ? 'active' : ''}`}
            onClick={() => {
              setCompareMode(c => !c);
              if (compareMode) setPointB(null);
            }}
          >
            🆚 {compareMode ? 'Karşılaştırmayı Kapat' : 'Karşılaştır'}
          </button>
        </div>
        {compareMode && (
          <div className="selected-info point-b">
            📍 B: {pointB ? `${pointB.lat}°N, ${pointB.lon}°E` : 'haritada ikinci bir nokta seçin'}
          </div>
        )}
        {meteoData.length > 0 && (
          <div className="toggle-group">
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={showMeteo}
                onChange={e => setShowMeteo(e.target.checked)}
              />
              <span>Meteoroloji tahmini</span>
            </label>
          </div>
        )}
        {meteoData.length > 0 && (
          <button type="button" className="csv-btn" onClick={() => downloadCSV(meteoData, `enerji-tahmini-${selectedLat}-${selectedLon}.csv`)}>
            ⬇️ CSV indir
          </button>
        )}
      </div>

      {!anyAiAvailable && selectedLat && !loading && (
        <div className="info-banner">
          ℹ️ AI model verisi (GraphCast/FourCastNet) şu an yalnızca <strong>Türkiye</strong> bölgesi için işleniyor. Bu nokta için yalnızca açık meteoroloji tahmini gösteriliyor.
        </div>
      )}

      <div className="main-content">
        <div className="map-container">
          <MapContainer
            center={regionCenters[region]}
            zoom={5}
            style={{ height: '400px', width: '100%' }}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='© OpenStreetMap'
            />
            <LocationPicker onSelect={handleLocationSelect} />
            <FlyTo target={flyTarget} />
            {selectedLat && selectedLon && (
              <Marker position={[parseFloat(selectedLat), parseFloat(selectedLon)]} icon={pinIcon}>
                <Popup>
                  📍 {selectedLat}°N, {selectedLon}°E<br />
                  {avgWindPower != null && <>💨 ~{avgWindPower.toFixed(0)} kW rüzgar<br /></>}
                  {avgSolarPower != null && <>☀️ ~{avgSolarPower.toFixed(1)} kW güneş</>}
                </Popup>
              </Marker>
            )}
            {compareMode && pointB && (
              <Marker position={[parseFloat(pointB.lat), parseFloat(pointB.lon)]} icon={pointBIcon}>
                <Popup>
                  📍 B: {pointB.lat}°N, {pointB.lon}°E<br />
                  {avgWindPowerB != null && <>💨 ~{avgWindPowerB.toFixed(0)} kW rüzgar<br /></>}
                  {avgSolarPowerB != null && <>☀️ ~{avgSolarPowerB.toFixed(1)} kW güneş</>}
                </Popup>
              </Marker>
            )}
          </MapContainer>
          <p className="map-hint">
            {compareMode
              ? '🖱️ A için bir kez, B için ikinci kez haritaya tıklayın'
              : '🖱️ Haritada bir noktaya tıklayın ya da yukarıdan şehir arayın'}
          </p>
        </div>

        {loading && (
          <>
            <div className="power-summary">
              <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
            </div>
            <SkeletonChart />
            <SkeletonChart />
          </>
        )}

        {!loading && meteoData.length > 0 && (
          <>
            <div className="power-summary">
              <div className="power-card">
                <span className="power-icon">💨</span>
                <div>
                  <span className="power-value">{avgWindPower != null ? avgWindPower.toFixed(0) : '–'} <small>kW</small></span>
                  <span className="power-label">Ort. Rüzgar Gücü (24s)</span>
                </div>
              </div>
              <div className="power-card">
                <span className="power-icon">☀️</span>
                <div>
                  <span className="power-value">{avgSolarPower != null ? avgSolarPower.toFixed(1) : '–'} <small>kW</small></span>
                  <span className="power-label">Ort. Güneş Gücü (24s)</span>
                </div>
              </div>
              <div className="power-card">
                <span className="power-icon">📈</span>
                <div>
                  <span className="power-value">{windCapacityFactor != null ? windCapacityFactor.toFixed(0) : '–'}<small>%</small></span>
                  <span className="power-label">Rüzgar Kapasite Faktörü</span>
                </div>
              </div>
              <div className="power-card">
                <span className="power-icon">🔋</span>
                <div>
                  <span className="power-value">{estDailyKWh != null ? estDailyKWh.toFixed(0) : '–'} <small>kWh</small></span>
                  <span className="power-label">Tahmini Günlük Üretim</span>
                </div>
              </div>
              <div className="power-card">
                <span className="power-icon">🌍</span>
                <div>
                  <span className="power-value">{dailyCO2SavedKg != null ? dailyCO2SavedKg.toFixed(0) : '–'} <small>kg CO₂</small></span>
                  <span className="power-label">Tahmini Günlük Karbon Tasarrufu</span>
                </div>
              </div>
            </div>
            <p className="power-disclaimer">
              Referans sistem: {TURBINE.ratedPowerKW / 1000} MW rüzgar türbini ({TURBINE.hubHeight} m göbek yüksekliği) + {PV.capacityKW} kWp çatı tipi güneş paneli. Karbon tasarrufu, Türkiye şebeke elektriği için yaklaşık ~{GRID_EMISSION_FACTOR} gCO₂/kWh gösterge değeriyle hesaplanmıştır. Gerçek bir santral verisi değildir, örnek/gösterge amaçlıdır.
            </p>

            {compareMode && pointB && (
              <div className="compare-section">
                <h3>🆚 A/B Karşılaştırması</h3>
                {loadingB ? (
                  <SkeletonChart />
                ) : (
                  <>
                    <div className="compare-grid">
                      <div className="compare-col">
                        <span className="compare-label point-a-label">📍 A — {selectedLat}°N, {selectedLon}°E</span>
                        <span className="compare-stat">💨 {avgWindPower != null ? avgWindPower.toFixed(0) : '–'} kW rüzgar</span>
                        <span className="compare-stat">☀️ {avgSolarPower != null ? avgSolarPower.toFixed(1) : '–'} kW güneş</span>
                        <span className="compare-stat">🔋 {estDailyKWh != null ? estDailyKWh.toFixed(0) : '–'} kWh/gün</span>
                      </div>
                      <div className="compare-col">
                        <span className="compare-label point-b-label">📍 B — {pointB.lat}°N, {pointB.lon}°E</span>
                        <span className="compare-stat">💨 {avgWindPowerB != null ? avgWindPowerB.toFixed(0) : '–'} kW rüzgar</span>
                        <span className="compare-stat">☀️ {avgSolarPowerB != null ? avgSolarPowerB.toFixed(1) : '–'} kW güneş</span>
                        <span className="compare-stat">🔋 {estDailyKWhB != null ? estDailyKWhB.toFixed(0) : '–'} kWh/gün</span>
                      </div>
                    </div>
                    {comparisonData.length > 0 && (
                      <div className="chart-box">
                        <h3>⚡ Toplam Güç Üretimi Karşılaştırması (kW)</h3>
                        <ResponsiveContainer width="100%" height={240}>
                          <LineChart data={comparisonData}>
                            <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                            <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                            <YAxis tick={{ fontSize: 11, fill: chartTheme.tick }} />
                            <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                            <Legend />
                            <Line type="monotone" dataKey="totalPowerA" stroke="#3b82f6" name="A noktası" dot={false} strokeWidth={2} />
                            <Line type="monotone" dataKey="totalPowerB" stroke="#ef4444" name="B noktası" dot={false} strokeWidth={2} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {bestDays.length > 0 && (
              <div className="best-days">
                <h3>🏆 Önümüzdeki 10 Günün En Verimli Günleri</h3>
                <div className="best-days-list">
                  {bestDays.map((d, i) => (
                    <div className="best-day-chip" key={d.day}>
                      <span className="rank">#{i + 1}</span>
                      <span className="day">{d.day}</span>
                      <span className="power">~{d.avgPower.toFixed(0)} kW ort.</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="charts">
              <h2>📊 Tahmin Grafikleri</h2>

              <div className="chart-box">
                <h3>⚡ Tahmini Güç Üretimi (kW)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={meteoData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <YAxis tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    <Area type="monotone" dataKey="solarPowerMeteo" stroke="#eab308" fill="#fef08a" fillOpacity={dark ? 0.25 : 1} name="Güneş (kW)" strokeWidth={2} />
                    <Area type="monotone" dataKey="windPowerMeteo" stroke="#3b82f6" fill="#bfdbfe" fillOpacity={dark ? 0.25 : 1} name="Rüzgar (kW)" strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>💨 Rüzgar Hızı (m/s)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={meteoData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <YAxis tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {MODEL_KEYS.map(code => enabledModels[code] && aiAvailableByModel[code] && (
                      <Line key={code} type="monotone" dataKey={`windSpeed${code}`} stroke={MODELS[code].color} name={MODELS[code].label} dot={false} strokeWidth={2} />
                    ))}
                    {ensembleStats && <Line type="monotone" dataKey="ensembleMean" stroke={dark ? '#e5e7eb' : '#111827'} name="Ensemble Ortalama" dot={false} strokeWidth={2.5} strokeDasharray="2 2" />}
                    {showMeteo && <Line type="monotone" dataKey="windSpeedMeteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={anyAiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {ensembleStats && (
                <div className="chart-box">
                  <h3>🧮 Model Ensemble Tutarlılığı</h3>
                  <div className="ensemble-badge-row">
                    <span className="ensemble-badge" style={{ '--badge-color': ensembleStats.color }}>
                      {ensembleStats.label}
                    </span>
                    <span className="ensemble-detail">
                      Ortalama değişim katsayısı (CV): %{(ensembleStats.avgCV * 100).toFixed(1)} · {availableModelCount} model, {ensembleStats.n} zaman noktası üzerinden
                    </span>
                  </div>
                  <p className="section-note">
                    CV = modeller arası standart sapma / ortalama rüzgar hızı. Düşük CV, modellerin birbirine yakın tahmin verdiğini (daha güvenilir bir sinyal); yüksek CV ise modeller arasında belirsizlik/anlaşmazlık olduğunu gösterir. Üstteki "Ensemble Ortalama" çizgisi bu {availableModelCount} modelin basit ortalamasıdır.
                  </p>
                  <table className="corr-table">
                    <thead>
                      <tr>
                        <th></th>
                        {MODEL_KEYS.map(code => <th key={code}>{MODELS[code].label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {MODEL_KEYS.map(a => (
                        <tr key={a}>
                          <th>{MODELS[a].label}</th>
                          {MODEL_KEYS.map(b => {
                            const r = correlationMatrix[a]?.[b];
                            const bg = r == null ? 'transparent' : `rgba(16,185,129,${Math.max(0, r) * 0.5})`;
                            return <td key={b} style={{ background: bg }}>{r == null ? '–' : r.toFixed(2)}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="section-note">Modellerin rüzgar hızı tahminleri arasındaki Pearson korelasyon katsayısı (1.0 = birebir aynı yönde hareket, 0 = ilişkisiz). Ortak veri noktası olmayan çiftler "–" gösterilir.</p>
                </div>
              )}

              <div className="chart-box">
                <h3>🌤️ Güneş Işınımı (W/m²)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={meteoData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <YAxis tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Area type="monotone" dataKey="irradiance" stroke="#eab308" fill="#fef9c3" fillOpacity={dark ? 0.25 : 1} name="Işınım (W/m²)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>🌡️ Sıcaklık (°C)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={meteoData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <YAxis tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {MODEL_KEYS.map(code => enabledModels[code] && aiAvailableByModel[code] && (
                      <Line key={code} type="monotone" dataKey={`t2${code}`} stroke={MODELS[code].color} name={MODELS[code].label} dot={false} strokeWidth={2} />
                    ))}
                    {showMeteo && <Line type="monotone" dataKey="t2Meteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={anyAiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>🔵 Deniz Seviyesi Basıncı (hPa)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={meteoData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <YAxis domain={[950, 1050]} tick={{ fontSize: 11, fill: chartTheme.tick }} />
                    <Tooltip contentStyle={{ background: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {MODEL_KEYS.map(code => enabledModels[code] && aiAvailableByModel[code] && (
                      <Line key={code} type="monotone" dataKey={`msl${code}`} stroke={MODELS[code].color} name={MODELS[code].label} dot={false} strokeWidth={2} />
                    ))}
                    {showMeteo && <Line type="monotone" dataKey="mslMeteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={anyAiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        <div className="heatmap-section">
          <div className="heatmap-header">
            <h2>🗺️ Türkiye Rüzgar Potansiyeli Haritası</h2>
            <div className="control-group heatmap-model-picker">
              <label>Harita Modeli</label>
              <select value={heatmapModel} onChange={e => setHeatmapModel(e.target.value)}>
                {MODEL_KEYS.map(code => <option key={code} value={code}>{MODELS[code].label}</option>)}
              </select>
            </div>
          </div>
          <p className="section-note">{MODELS[heatmapModel].label} modelinin elindeki tüm Türkiye grid noktalarının ortalama rüzgar gücüne göre renklendirilmesi. Kısa vadeli model verisinin ortalamasıdır, uzun dönemli bir rüzgar kaynağı etüdü değildir.</p>
          {heatmapLoading ? (
            <SkeletonChart />
          ) : heatmap.length === 0 ? (
            <p className="section-note">Şu an ısı haritası verisi yok.</p>
          ) : (
            <>
              <div className="map-container">
                <MapContainer center={[39, 35]} zoom={5} style={{ height: '420px', width: '100%' }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='© OpenStreetMap' />
                  <HeatLayer points={heatPoints} dark={dark} />
                  {windFarmsWithOutput.map((f, i) => (
                    <CircleMarker
                      key={`wf-${i}`}
                      center={[f.lat, f.lon]}
                      radius={4}
                      pathOptions={{ color: '#111827', fillColor: '#ffffff', fillOpacity: 1, weight: 1.5 }}
                    >
                      <LeafletTooltip direction="top" offset={[0, -4]} opacity={1}>
                        <div className="turbine-tooltip">
                          <strong>⚙️ {f.name}</strong><br />
                          {f.operator && <>{f.operator}<br /></>}
                          📍 {f.lat.toFixed(2)}°N, {f.lon.toFixed(2)}°E<br />
                          Kurulu güç: {f.capacity_mw != null ? `${f.capacity_mw} MW` : 'bilinmiyor'}<br />
                          {f.estimatedOutputMW != null && <>Tahmini üretim: ~{f.estimatedOutputMW.toFixed(1)} MW ({(f.capacityFactor * 100).toFixed(0)}%)</>}
                        </div>
                      </LeafletTooltip>
                    </CircleMarker>
                  ))}
                </MapContainer>
              </div>
              <p className="section-note">⚫⚪ Beyaz/siyah noktalar: OpenStreetMap'te kayıtlı {WIND_FARMS.length} gerçek rüzgar santrali. Tahmini anlık üretim, santralin en yakın grid hücresindeki rüzgar hızı ve genel referans türbin eğrisiyle hesaplanır (gerçek türbin modelleri bilinmediğinden yaklaşıktır). OSM tabanlı liste eksiksiz değildir.</p>
              <div className="top-locations">
                <h3>🏅 En Yüksek Potansiyelli 10 Lokasyon</h3>
                <table className="top-locations-table">
                  <thead>
                    <tr><th>#</th><th>Konum</th><th>Ort. Rüzgar Hızı</th><th>Ort. Rüzgar Gücü</th></tr>
                  </thead>
                  <tbody>
                    {topLocations.map((c, i) => (
                      <tr key={i} onClick={() => { handleLocationSelect(c.lat, c.lon); setFlyTarget([c.lat, c.lon]); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                        <td>{i + 1}</td>
                        <td>{c.lat.toFixed(2)}°N, {c.lon.toFixed(2)}°E</td>
                        <td>{c.avgSpeed.toFixed(1)} m/s</td>
                        <td>~{c.avgPowerKW.toFixed(0)} kW</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {windFarmsWithOutput.length > 0 && (
                <div className="top-locations">
                  <h3>⚙️ Aktif Rüzgar Santralleri — Tahmini Üretim ({windFarmsWithOutput.length} santral)</h3>
                  <div className="scroll-table-wrap">
                    <table className="top-locations-table">
                      <thead>
                        <tr><th>#</th><th>Santral</th><th>Operatör</th><th>Kurulu Güç</th><th>Tahmini Üretim</th><th>Kap. Faktörü</th></tr>
                      </thead>
                      <tbody>
                        {[...windFarmsWithOutput]
                          .sort((a, b) => (b.estimatedOutputMW || -1) - (a.estimatedOutputMW || -1))
                          .map((f, i) => (
                            <tr key={i} onClick={() => { handleLocationSelect(f.lat, f.lon); setFlyTarget([f.lat, f.lon]); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                              <td>{i + 1}</td>
                              <td>{f.name}</td>
                              <td>{f.operator || '–'}</td>
                              <td>{f.capacity_mw != null ? `${f.capacity_mw} MW` : '–'}</td>
                              <td>{f.estimatedOutputMW != null ? `~${f.estimatedOutputMW.toFixed(1)} MW` : '–'}</td>
                              <td>{f.capacityFactor != null ? `${(f.capacityFactor * 100).toFixed(0)}%` : '–'}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="footer">
        <div className="footer-inner">
          <p className="footer-made">
            Made by <strong>Ahmet Haşim Bilici</strong>
          </p>
          <div className="footer-links">
            <a href="https://github.com/biliciahmeth/ai-energy-forecast" target="_blank" rel="noreferrer">GitHub</a>
            <span className="footer-dot">·</span>
            <span>NOAA MLWP Open Data</span>
            <span className="footer-dot">·</span>
            <span>GraphCast · FourCastNet · Pangu-Weather · Aurora</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

export default App;
