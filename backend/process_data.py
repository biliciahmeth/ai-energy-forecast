import boto3
from botocore import UNSIGNED
from botocore.config import Config
import xarray as xr
import tempfile
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

BUCKET = "noaa-oar-mlwp-data"
MODELS = {
    "GRAP": "GRAP_v100_GFS",
    "FOUR": "FOUR_v100_GFS"
}

REGION = {"lat": (36, 42), "lon": (26, 45)}
VARIABLES = ["u10", "v10", "t2", "msl"]

s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))

def get_all_keys(model_prefix):
    today = datetime.utcnow()
    for delta in range(3):
        date = today - timedelta(days=delta)
        prefix = f"{model_prefix}/{date.strftime('%Y')}/{date.strftime('%m%d')}/"
        paginator = s3.get_paginator("list_objects_v2")
        keys = []
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"])
        if keys:
            print(f"  {len(keys)} dosya bulundu: {prefix}")
            return keys
    return []

def save_to_supabase(ds, lat_name, lon_name, model_name):
    lat_vals = ds[lat_name].values
    lat_slice = slice(REGION["lat"][1], REGION["lat"][0]) if lat_vals[0] > lat_vals[-1] else slice(REGION["lat"][0], REGION["lat"][1])

    ds_tr = ds.sel({lat_name: lat_slice, lon_name: slice(*REGION["lon"])})

    records = []
    for t in ds_tr["time"].values:
        for lat in ds_tr[lat_name].values:
            for lon in ds_tr[lon_name].values:
                p = ds_tr.sel({lat_name: lat, lon_name: lon, "time": t})
                records.append({
                    "model": model_name,
                    "region": "turkey",
                    "timestamp": str(t),
                    "lat": float(lat),
                    "lon": float(lon),
                    "u10": float(p["u10"].values) if "u10" in p else None,
                    "v10": float(p["v10"].values) if "v10" in p else None,
                    "t2": float(p["t2"].values) if "t2" in p else None,
                    "msl": float(p["msl"].values) if "msl" in p else None,
                })
                if len(records) >= 1000:
                    supabase.table("forecasts").insert(records).execute()
                    print(f"    {len(records)} kayıt gönderildi...")
                    records = []

    if records:
        supabase.table("forecasts").insert(records).execute()
        print(f"    {len(records)} kayıt gönderildi.")

    ds_tr.close()

if __name__ == "__main__":
    print("Eski veriler siliniyor...")
    supabase.table("forecasts").delete().neq("id", 0).execute()
    print("✓ Silindi.\n")

    for model_name, model_prefix in MODELS.items():
        print(f"{'='*50}")
        print(f"Model: {model_name}")
        keys = get_all_keys(model_prefix)

        if not keys:
            print("✗ Veri bulunamadı.")
            continue

        for key in keys:
            print(f"\n  Dosya: {key.split('/')[-1]}")
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
                    tmp_path = tmp.name
                s3.download_file(BUCKET, key, tmp_path)
                ds = xr.open_dataset(tmp_path, engine="netcdf4")
                available = [v for v in VARIABLES if v in ds.data_vars]
                ds = ds[available]
                lat_name = "latitude" if "latitude" in ds.coords else "lat"
                lon_name = "longitude" if "longitude" in ds.coords else "lon"
                print(f"  Zaman adımları: {len(ds['time'].values)} | Boyut: {ds.nbytes/1e6:.1f} MB")
                save_to_supabase(ds, lat_name, lon_name, model_name)
                ds.close()
            except Exception as e:
                print(f"  Hata: {e}")
            finally:
                if tmp_path:
                    try: os.unlink(tmp_path)
                    except: pass

    print("\n✓ Tamamlandı!")