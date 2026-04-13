import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, useMapEvents } from 'react-leaflet';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import axios from 'axios';
import 'leaflet/dist/leaflet.css';
import './App.css';

const API = 'https://ai-energy-forecast.onrender.com';

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
  const [loading, setLoading] = useState(false);

  const handleLocationSelect = (lat, lon) => {
    setSelectedLat(lat.toFixed(2));
    setSelectedLon(lon.toFixed(2));
  };

  const fetchForecast = async () => {
    if (!selectedLat || !selectedLon) return;
    setLoading(true);
    try {
      const res = await axios.get(`${API}/forecast`, {
        params: { model, region, lat: selectedLat, lon: selectedLon }
      });
      const data = res.data.data.map(d => ({
        time: new Date(d.timestamp).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric', hour: '2-digit' }),
        u10: d.u10?.toFixed(2),
        v10: d.v10?.toFixed(2),
        t2: (d.t2 - 273.15)?.toFixed(1),
        msl: (d.msl / 100)?.toFixed(1),
        windSpeed: Math.sqrt(d.u10 ** 2 + d.v10 ** 2).toFixed(2),
      }));
      setForecastData(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (selectedLat && selectedLon) fetchForecast();
  }, [selectedLat, selectedLon, model, region]);

  const regionCenters = {
    turkey: [39, 35],
    europe: [54, 10],
    america: [40, -100],
    africa: [0, 20],
  };

  return (
    <div className="app">

      {/* HEADER */}
      <header className="header">
        <div className="header-inner">
          <div className="header-logo">
            <span className="logo-icon">⚡</span>
            <h1>AI Energy Forecast</h1>
          </div>
          <p className="header-sub">GraphCast & FourCastNet ile Rüzgar ve Güneş Enerji Tahmini</p>
        </div>
      </header>

      {/* HERO / ABOUT */}
      <section className="hero">
        <div className="hero-cards">
          <div className="hero-card">
            <span className="hero-card-icon">🌍</span>
            <h3>Ne Yapar?</h3>
            <p>Dünya genelinde herhangi bir noktanın rüzgar hızı, sıcaklık ve atmosfer basıncı tahminini AI modelleriyle sunar.</p>
          </div>
          <div className="hero-card">
            <span className="hero-card-icon">🤖</span>
            <h3>Hangi Modeller?</h3>
            <p>Google DeepMind'ın <strong>GraphCast</strong> ve NVIDIA'nın <strong>FourCastNet</strong> modelleri — NOAA MLWP açık verisiyle beslenir.</p>
          </div>
          <div className="hero-card">
            <span className="hero-card-icon">🗺️</span>
            <h3>Nasıl Kullanılır?</h3>
            <p>Model ve bölge seçin, haritadan istediğiniz noktaya tıklayın — tahmin grafikleri anında yüklensin.</p>
          </div>
        </div>
      </section>

      {/* CONTROLS */}
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
      </div>

      {/* MAP */}
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
          </MapContainer>
          <p className="map-hint">🖱️ Haritada bir noktaya tıklayın</p>
        </div>

        {loading && (
          <div className="loading">
            <div className="loading-spinner"></div>
            <span>Veri yükleniyor...</span>
          </div>
        )}

        {/* CHARTS */}
        {forecastData.length > 0 && (
          <div className="charts">
            <h2>📊 {model === 'GRAP' ? 'GraphCast' : 'FourCastNet'} Tahmini</h2>

            <div className="chart-box">
              <h3>💨 Rüzgar Hızı (m/s)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #3a3a4a', borderRadius: '8px' }} />
                  <Legend />
                  <Line type="monotone" dataKey="windSpeed" stroke="#2196F3" name="Rüzgar Hızı" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-box">
              <h3>🌡️ Sıcaklık (°C)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #3a3a4a', borderRadius: '8px' }} />
                  <Legend />
                  <Line type="monotone" dataKey="t2" stroke="#F44336" name="Sıcaklık (°C)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-box">
              <h3>🔵 Deniz Seviyesi Basıncı (hPa)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <YAxis domain={[950, 1050]} tick={{ fontSize: 11, fill: '#9e9e9e' }} />
                  <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #3a3a4a', borderRadius: '8px' }} />
                  <Legend />
                  <Line type="monotone" dataKey="msl" stroke="#4CAF50" name="Basınç (hPa)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-inner">
          <p className="footer-made">
            Made by <strong>Ahmet Haşim Bilici</strong>
          </p>
          <div className="footer-links">
            <a href="https://github.com/biliciahmeth/ai-energy-forecast" target="_blank" rel="noreferrer">
              GitHub
            </a>
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