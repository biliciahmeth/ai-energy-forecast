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
      <header className="header">
        <h1>🌬️ AI Energy Forecast</h1>
        <p>GraphCast & FourCastNet ile Rüzgar ve Güneş Enerji Tahmini</p>
      </header>

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
          <p className="map-hint">Haritada bir noktaya tıklayın</p>
        </div>

        {loading && <div className="loading">Veri yükleniyor...</div>}

        {forecastData.length > 0 && (
          <div className="charts">
            <h2>📊 {model === 'GRAP' ? 'GraphCast' : 'FourCastNet'} Tahmini</h2>

            <div className="chart-box">
              <h3>💨 Rüzgar Hızı (m/s)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="windSpeed" stroke="#2196F3" name="Rüzgar Hızı" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-box">
              <h3>🌡️ Sıcaklık (°C)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="t2" stroke="#F44336" name="Sıcaklık (°C)" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-box">
              <h3>🔵 Deniz Seviyesi Basıncı (hPa)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="msl" stroke="#4CAF50" name="Basınç (hPa)" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;