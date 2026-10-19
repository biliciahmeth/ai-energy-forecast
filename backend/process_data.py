import boto3
from botocore import UNSIGNED
from botocore.config import Config
import xarray as xr
import numpy as np
import tempfile
import os
import time
import threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# "Server disconnected" hataları, tek bir global client'ın httpx bağlantı
# havuzundaki bayatlamış bir TCP bağlantısından kaynaklanıyordu — aynı bozuk
# bağlantıyla tekrar denemek işe yaramıyordu. Her thread kendi client'ını
# tutar; bir hata sonrası o thread'in client'ı atılır, bir dahaki deneme
# taze bir bağlantıyla kurulur.
_thread_local = threading.local()

def _get_thread_client():
    if not hasattr(_thread_local, "client"):
        _thread_local.client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _thread_local.client

def _reset_thread_client():
    if hasattr(_thread_local, "client"):
        del _thread_local.client

BUCKET = "noaa-oar-mlwp-data"
MODELS = {
    "GRAP": "GRAP_v100_GFS",
    # NOAA, FOUR_v100_GFS'i bir süredir güncellemiyor (bucket'ta son dosya
    # yok oldu) — FOUR_v200_GFS (FourCastNet v2-small) aktif yayınlanan,
    # aynı değişkenlere (u10/v10/t2/msl) sahip güncel sürüm.
    "FOUR": "FOUR_v200_GFS",
    "PANG": "PANG_v100_GFS",
    "AURO": "AURO_v100_GFS",
}

REGION = {"lat": (36, 42), "lon": (26, 45)}
VARIABLES = ["u10", "v10", "t2", "msl"]
BATCH_SIZE = 5000
MAX_PARALLEL_INSERTS = 4

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

def _send_batch(batch, max_attempts=4):
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            client = _get_thread_client()
            client.table("forecasts").insert(batch).execute()
            return len(batch)
        except Exception as e:
            last_err = e
            _reset_thread_client()
            time.sleep(1.5 * attempt)
    raise last_err

def download_with_retry(key, tmp_path, max_attempts=3):
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            s3.download_file(BUCKET, key, tmp_path)
            return
        except Exception as e:
            last_err = e
            print(f"    İndirme denemesi {attempt}/{max_attempts} başarısız ({e}), tekrar deneniyor...")
            time.sleep(3 * attempt)
    raise last_err

def _with_retry(fn, max_attempts=4):
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn(_get_thread_client())
        except Exception as e:
            last_err = e
            _reset_thread_client()
            time.sleep(1.5 * attempt)
    raise last_err

def delete_model_data(model_name, chunk_size=2000):
    # Tek seferde "tüm model" veya "tüm tablo" silmek, satır sayısı arttıkça
    # (4 model ile ~600 bin+ satır) Supabase'in statement timeout'una takılıyordu.
    # ID'leri küçük gruplar halinde çekip silmek her sorguyu hızlı tutar.
    total_deleted = 0
    while True:
        res = _with_retry(lambda c: c.table("forecasts").select("id").eq("model", model_name).limit(chunk_size).execute())
        ids = [row["id"] for row in res.data]
        if not ids:
            break
        _with_retry(lambda c: c.table("forecasts").delete().in_("id", ids).execute())
        total_deleted += len(ids)
    return total_deleted

def save_to_supabase(ds, lat_name, lon_name, model_name):
    lat_vals = ds[lat_name].values
    lat_slice = slice(REGION["lat"][1], REGION["lat"][0]) if lat_vals[0] > lat_vals[-1] else slice(REGION["lat"][0], REGION["lat"][1])

    ds_tr = ds.sel({lat_name: lat_slice, lon_name: slice(*REGION["lon"])})
    # Eski kod her (zaman, enlem, boylam) noktası için ayrı bir xarray .sel()
    # çağrısı yapıyordu (~40 bin kez/dosya) — bu asıl darboğazdı, ağ değil.
    # Tek seferde boyut sırasını sabitleyip numpy dizisi olarak çekmek,
    # .sel() çağrısı başına gelen Python/xarray overhead'ini ortadan kaldırır.
    ds_tr = ds_tr.transpose("time", lat_name, lon_name)

    times = ds_tr["time"].values
    lats = ds_tr[lat_name].values
    lons = ds_tr[lon_name].values

    arrays = {}
    for var in VARIABLES:
        arrays[var] = ds_tr[var].values if var in ds_tr else None

    records = []
    batches = []
    for ti, t in enumerate(times):
        ts_str = str(t)
        slices = {var: (arr[ti] if arr is not None else None) for var, arr in arrays.items()}
        for li, lat in enumerate(lats):
            lat_f = float(lat)
            for lo, lon in enumerate(lons):
                records.append({
                    "model": model_name,
                    "region": "turkey",
                    "timestamp": ts_str,
                    "lat": lat_f,
                    "lon": float(lon),
                    "u10": float(slices["u10"][li, lo]) if slices["u10"] is not None else None,
                    "v10": float(slices["v10"][li, lo]) if slices["v10"] is not None else None,
                    "t2": float(slices["t2"][li, lo]) if slices["t2"] is not None else None,
                    "msl": float(slices["msl"][li, lo]) if slices["msl"] is not None else None,
                })
                if len(records) >= BATCH_SIZE:
                    batches.append(records)
                    records = []

    if records:
        batches.append(records)

    total = 0
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_INSERTS) as executor:
        for n in executor.map(_send_batch, batches):
            total += n
    print(f"    {total} kayıt gönderildi ({len(batches)} batch, paralel).")

    ds_tr.close()

if __name__ == "__main__":
    for model_name, model_prefix in MODELS.items():
        print(f"{'='*50}")
        print(f"Model: {model_name}")
        keys = get_all_keys(model_prefix)

        if not keys:
            print("✗ Veri bulunamadı.")
            continue

        # Eski veriyi, yeni veri gerçekten başarıyla indirilip açılana kadar SİLMİYORUZ.
        # Önceki sırada (hep önce sil) bir ağ kopması tüm dosyaları düşürdüğünde
        # model tablo boş/yarım kalıyordu (FOUR'daki "veri yok" + GRAP/PANG/AURO'nun
        # yarım kalması bu yüzdendi). Şimdi: ilk başarılı dosyadan hemen önce sil.
        deleted_old = False

        for key in keys:
            print(f"\n  Dosya: {key.split('/')[-1]}")
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
                    tmp_path = tmp.name
                download_with_retry(key, tmp_path)
                ds = xr.open_dataset(tmp_path, engine="netcdf4")
                available = [v for v in VARIABLES if v in ds.data_vars]
                ds = ds[available]
                lat_name = "latitude" if "latitude" in ds.coords else "lat"
                lon_name = "longitude" if "longitude" in ds.coords else "lon"
                print(f"  Zaman adımları: {len(ds['time'].values)} | Boyut: {ds.nbytes/1e6:.1f} MB")

                if not deleted_old:
                    print(f"  {model_name} için eski veriler siliniyor...")
                    deleted = delete_model_data(model_name)
                    print(f"  ✓ {deleted} eski kayıt silindi.")
                    deleted_old = True

                save_to_supabase(ds, lat_name, lon_name, model_name)
                ds.close()
            except Exception as e:
                print(f"  Hata: {e}")
            finally:
                if tmp_path:
                    try: os.unlink(tmp_path)
                    except: pass

    print("\n✓ Tamamlandı!")