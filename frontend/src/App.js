import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet';
import {
  LineChart, Line, ComposedChart, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

const API = 'https://ai-energy-forecast.onrender.com';

// ── Referans sistem varsayımları (gerçek bir santral/kurulum değil, örnek göstergedir) ──
const TURBINE = { cutIn: 3, rated: 12, cutOut: 25, ratedPowerKW: 2000, hubHeight: 80, measureHeight: 10, shearExp: 0.14 };
const PV = { capacityKW: 5, performanceRatio: 0.8 }; // 5 kWp çatı tipi kurulum

const pinIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
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

function LocationPicker({ onSelect }) {
  useMapEvents({
    click(e) {
      onSelect(e.latlng.lat, e.latlng.lng);
    }
  });
  return null;
}

function App() {
  const [selectedLat, setSelectedLat] = useState(null);
  const [selectedLon, setSelectedLon] = useState(null);
  const [model, setModel] = useState('GRAP');
  const [region, setRegion] = useState('turkey');
  const [forecastData, setForecastData] = useState([]);
  const [meteoData, setMeteoData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showMeteo, setShowMeteo] = useState(true);

  const handleLocationSelect = (lat, lon) => {
    setSelectedLat(lat.toFixed(2));
    setSelectedLon(lon.toFixed(2));
  };

  const fetchForecast = async () => {
    if (!selectedLat || !selectedLon) return;
    setLoading(true);
    try {
      const [aiRes, meteoRes] = await Promise.all([
        axios.get(`${API}/forecast`, {
          params: { model, region, lat: selectedLat, lon: selectedLon }
        }).catch(() => ({ data: { data: [] } })),
        axios.get('https://api.open-meteo.com/v1/forecast', {
          params: {
            latitude: selectedLat,
            longitude: selectedLon,
            hourly: 'temperature_2m,windspeed_10m,pressure_msl,shortwave_radiation',
            forecast_days: 10,
            timezone: 'auto',
            windspeed_unit: 'ms',
          }
        })
      ]);

      const aiRows = aiRes.data.data || [];

      // Aynı zaman damgasında birden fazla grid noktası dönebiliyor (bbox içindeki
      // komşu hücreler) — her timestamp için seçilen konuma en yakın hücreyi al.
      const byTimestamp = new Map();
      for (const d of aiRows) {
        const dist = (d.lat - parseFloat(selectedLat)) ** 2 + (d.lon - parseFloat(selectedLon)) ** 2;
        const existing = byTimestamp.get(d.timestamp);
        if (!existing || dist < existing.dist) byTimestamp.set(d.timestamp, { row: d, dist });
      }

      const aiData = Array.from(byTimestamp.values()).map(({ row: d }) => {
        const windSpeed = parseFloat(Math.sqrt(d.u10 ** 2 + d.v10 ** 2).toFixed(2));
        return {
          tsMs: new Date(d.timestamp).getTime(),
          windSpeed,
          t2: parseFloat((d.t2 - 273.15).toFixed(1)),
          msl: parseFloat((d.msl / 100).toFixed(1)),
          windPowerAI: round(windPowerKW(windSpeed), 0),
        };
      }).sort((a, b) => a.tsMs - b.tsMs);

      // 6 saatlik filtre (her 6. index)
      const hourly = meteoRes.data.hourly;
      const meteo = hourly.time
        .filter((_, i) => i % 6 === 0)
        .map((ts, i) => {
          const idx = i * 6;
          const windSpeedMeteo = parseFloat(hourly.windspeed_10m[idx]?.toFixed(2));
          const irradiance = hourly.shortwave_radiation[idx] ?? 0;
          return {
            tsMs: new Date(ts).getTime(),
            time: new Date(ts).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric', hour: '2-digit' }),
            windSpeedMeteo,
            t2Meteo: parseFloat(hourly.temperature_2m[idx]?.toFixed(1)),
            mslMeteo: parseFloat(hourly.pressure_msl[idx]?.toFixed(1)),
            irradiance: round(irradiance, 0),
            windPowerMeteo: round(windPowerKW(windSpeedMeteo), 0),
            solarPowerMeteo: round(solarPowerKW(irradiance), 1),
          };
        });

      setForecastData(aiData);
      setMeteoData(meteo);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (selectedLat && selectedLon) fetchForecast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLat, selectedLon, model, region]);

  // AI tahmini (model çalıştığı anın verisi) ile canlı meteoroloji tahmini (her
  // zaman "şu an"dan başlar) farklı zaman pencerelerinden gelebilir. Aynı saatte
  // birebir eşleşme yerine, 3 saatlik tolerans içinde en yakın AI noktasını eşle.
  const TOLERANCE_MS = 3 * 60 * 60 * 1000;
  const mergedData = meteoData.map(m => {
    let closest = null;
    let closestDiff = Infinity;
    for (const d of forecastData) {
      const diff = Math.abs(d.tsMs - m.tsMs);
      if (diff < closestDiff) { closestDiff = diff; closest = d; }
    }
    const match = closest && closestDiff <= TOLERANCE_MS ? closest : null;
    return { ...m, ...(match || {}) };
  });
  const aiAvailable = mergedData.some(d => d.windSpeed != null);

  const regionCenters = {
    turkey: [39, 35],
    europe: [54, 10],
    america: [40, -100],
    africa: [0, 20],
  };

  // Önümüzdeki 24 saatlik (4 nokta, 6'şar saat) ortalamalara göre özet üretim göstergeleri
  const next24 = mergedData.slice(0, 4);
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

  return (
    <div className="app">

      <header className="header">
        <div className="header-inner">
          <div className="header-logo">
            <span className="logo-icon">⚡</span>
            <h1>AI Energy Forecast</h1>
          </div>
          <span className="header-sub">NOAA MLWP · GraphCast · FourCastNet</span>
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
          <span className="stat-value">2</span>
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

      <div className="controls">
        <div className="control-group">
          <label>Model</label>
          <select value={model} onChange={e => setModel(e.target.value)}>
            <option value="GRAP">GraphCast</option>
            <option value="FOUR">FourCastNet</option>
          </select>
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
            📍 {selectedLat}°N, {selectedLon}°E
          </div>
        )}
        {mergedData.length > 0 && (
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
      </div>

      {!aiAvailable && selectedLat && (
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
            {selectedLat && selectedLon && (
              <Marker position={[parseFloat(selectedLat), parseFloat(selectedLon)]} icon={pinIcon}>
                <Popup>
                  📍 {selectedLat}°N, {selectedLon}°E<br />
                  {avgWindPower != null && <>💨 ~{avgWindPower.toFixed(0)} kW rüzgar<br /></>}
                  {avgSolarPower != null && <>☀️ ~{avgSolarPower.toFixed(1)} kW güneş</>}
                </Popup>
              </Marker>
            )}
          </MapContainer>
          <p className="map-hint">🖱️ Haritada bir noktaya tıklayın</p>
        </div>

        {loading && (
          <div className="loading">
            <div className="loading-spinner"></div>
            <span>Veri yükleniyor...</span>
          </div>
        )}

        {mergedData.length > 0 && (
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
            </div>
            <p className="power-disclaimer">
              Referans sistem: {TURBINE.ratedPowerKW / 1000} MW rüzgar türbini ({TURBINE.hubHeight} m göbek yüksekliği) + {PV.capacityKW} kWp çatı tipi güneş paneli. Gerçek bir santral verisi değildir, örnek/gösterge amaçlıdır.
            </p>

            <div className="charts">
              <h2>📊 {model === 'GRAP' ? 'GraphCast' : 'FourCastNet'} Tahmini</h2>

              <div className="chart-box">
                <h3>⚡ Tahmini Güç Üretimi (kW)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={mergedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    <Area type="monotone" dataKey="solarPowerMeteo" stroke="#eab308" fill="#fef08a" name="Güneş (kW)" strokeWidth={2} />
                    <Area type="monotone" dataKey="windPowerMeteo" stroke="#3b82f6" fill="#bfdbfe" name="Rüzgar (kW)" strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>💨 Rüzgar Hızı (m/s)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={mergedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {aiAvailable && <Line type="monotone" dataKey="windSpeed" stroke="#f97316" name="AI Tahmini" dot={false} strokeWidth={2} />}
                    {showMeteo && <Line type="monotone" dataKey="windSpeedMeteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={aiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>🌤️ Güneş Işınımı (W/m²)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={mergedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Area type="monotone" dataKey="irradiance" stroke="#eab308" fill="#fef9c3" name="Işınım (W/m²)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>🌡️ Sıcaklık (°C)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={mergedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {aiAvailable && <Line type="monotone" dataKey="t2" stroke="#f97316" name="AI Tahmini" dot={false} strokeWidth={2} />}
                    {showMeteo && <Line type="monotone" dataKey="t2Meteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={aiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="chart-box">
                <h3>🔵 Deniz Seviyesi Basıncı (hPa)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={mergedData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis domain={[950, 1050]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '0.85rem' }} />
                    <Legend />
                    {aiAvailable && <Line type="monotone" dataKey="msl" stroke="#f97316" name="AI Tahmini" dot={false} strokeWidth={2} />}
                    {showMeteo && <Line type="monotone" dataKey="mslMeteo" stroke="#3b82f6" name="Meteoroloji" dot={false} strokeWidth={2} strokeDasharray={aiAvailable ? "5 3" : ""} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
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
            <span>GraphCast · FourCastNet</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

export default App;
