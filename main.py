from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
from dotenv import load_dotenv
import os
import httpx

load_dotenv("backend/.env")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "ok", "message": "AI Energy Forecast API"}

@app.get("/forecast")
def get_forecast(
    model: str = Query(..., description="GRAP veya FOUR"),
    region: str = Query("turkey", description="Bölge adı"),
    lat: float = Query(None, description="Enlem"),
    lon: float = Query(None, description="Boylam"),
):
    query = supabase.table("forecasts").select("*").eq("model", model).eq("region", region)
    if lat is not None and lon is not None:
        query = query.gte("lat", lat - 0.5).lte("lat", lat + 0.5)
        query = query.gte("lon", lon - 0.5).lte("lon", lon + 0.5)
    response = query.order("timestamp").limit(500).execute()
    return {"data": response.data, "count": len(response.data)}

@app.get("/openmeteo")
async def get_openmeteo(
    lat: float = Query(..., description="Enlem"),
    lon: float = Query(..., description="Boylam"),
):
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "temperature_2m,windspeed_10m,surface_pressure",
        "forecast_days": 10,
        "timezone": "auto",
        "windspeed_unit": "ms",
    }
    async with httpx.AsyncClient() as client:
        res = await client.get(url, params=params, timeout=15)
        res.raise_for_status()
        raw = res.json()

    hourly = raw["hourly"]
    data = []
    for i, ts in enumerate(hourly["time"]):
        data.append({
            "timestamp": ts,
            "t2": hourly["temperature_2m"][i],
            "windSpeed": hourly["windspeed_10m"][i],
            "msl": hourly["surface_pressure"][i],
        })
    return {"data": data, "count": len(data)}

@app.get("/models")
def get_models():
    return {"models": ["GRAP", "FOUR"]}

@app.get("/regions")
def get_regions():
    return {"regions": ["turkey", "europe", "america", "africa"]}