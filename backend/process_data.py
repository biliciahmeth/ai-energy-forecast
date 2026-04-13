import boto3
from botocore import UNSIGNED
from botocore.config import Config
import xarray as xr
import numpy as np
import tempfile
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client

# .env dosyasını yükle
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Ayarlar
BUCKET = "noaa-oar-mlwp-data"
MODELS = {
    "GRAP": "GRAP_v100_GFS",
    "FOUR": "FOUR_v100_GFS"
}

REGIONS = {
    "turkey":  {"lat": (36, 42),  "lon": (26, 45)},
    "europe":  {"lat": (35, 72),  "lon": (-25, 45)},
    "america": {"lat": (15, 72),  "lon": (-170, -50)},
    "africa":  {"lat": (-35, 38), "lon": (-20, 55)},
}

VARIABLES = ["u10", "v10", "t2", "msl"]

s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))

def get_latest_key(model_prefix):
    today = datetime.utcnow()
    for delta in range(3):
        date = today - timedelta(days=delta)
        yyyy = date.strftime("%Y")
        mmdd = date.strftime("%m%d")
        prefix = f"{model_prefix}/{yyyy}/{mmdd}/"
        response = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
        if "Contents" in response:
            key = response["Contents"][0]["Key"]
            print(f"Bulundu: {key}")
            return key
    return None

def download_and_process(key, region_name):
    region = REGIONS[region_name]
    print(f"\nİndiriliyor: {key}")

    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        s3.download_file(BUCKET, key, tmp_path)
        print("İndirme tamamlandı, işleniyor...")

        ds = xr.open_dataset(tmp_path, engine="netcdf4")
        available = [v for v in VARIABLES if v in ds.data_vars]
        ds = ds[available]

        lat_name = "latitude" if "latitude" in ds.coords else "lat"
        lon_name = "longitude" if "longitude" in ds.coords else "lon"

        lat_vals = ds[lat_name].values
        if lat_vals[0] > lat_vals[-1]:
            lat_slice = slice(region["lat"][1], region["lat"][0])
        else:
            lat_slice = slice(region["lat"][0], region["lat"][1])

        ds = ds.sel(
            {lat_name: lat_slice,
             lon_name: slice(*region["lon"])}
        )

        print(f"Boyutlar: {dict(ds.sizes)}")
        print(f"Değişkenler: {list(ds.data_vars)}")
        print(f"Boyut (MB): {ds.nbytes / 1e6:.1f} MB")

        return ds, lat_name, lon_name

    finally:
        try:
            ds.close()
        except:
            pass
        try:
            os.unlink(tmp_path)
        except:
            pass

def save_to_supabase(ds, lat_name, lon_name, model_name, region_name):
    print(f"\nSupabase'e kaydediliyor...")
    records = []

    times = ds["time"].values
    lats = ds[lat_name].values
    lons = ds[lon_name].values

    for t in times:
        for lat in lats:
            for lon in lons:
                point = ds.sel({lat_name: lat, lon_name: lon, "time": t})
                record = {
                    "model": model_name,
                    "region": region_name,
                    "timestamp": str(t),
                    "lat": float(lat),
                    "lon": float(lon),
                    "u10": float(point["u10"].values) if "u10" in point else None,
                    "v10": float(point["v10"].values) if "v10" in point else None,
                    "t2": float(point["t2"].values) if "t2" in point else None,
                    "msl": float(point["msl"].values) if "msl" in point else None,
                }
                records.append(record)

        if len(records) >= 1000:
            supabase.table("forecasts").insert(records).execute()
            print(f"{len(records)} kayıt gönderildi...")
            records = []

    if records:
        supabase.table("forecasts").insert(records).execute()
        print(f"{len(records)} kayıt gönderildi.")

    print("✓ Supabase kaydı tamamlandı!")

if __name__ == "__main__":
    print("Eski veriler siliniyor...")
    supabase.table("forecasts").delete().neq("id", 0).execute()
    print("✓ Eski veriler silindi.")

    for model_name, model_prefix in MODELS.items():
        print(f"\n{'='*40}")
        print(f"Model: {model_name}")
        key = get_latest_key(model_prefix)
        if key:
            result = download_and_process(key, "turkey")
            if result:
                ds, lat_name, lon_name = result
                save_to_supabase(ds, lat_name, lon_name, model_name, "turkey")
        else:
            print(f"✗ {model_name} için veri bulunamadı.")