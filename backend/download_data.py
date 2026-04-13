import boto3
from botocore import UNSIGNED
from botocore.config import Config
from datetime import datetime, timedelta
import os

# Ayarlar
BUCKET = "noaa-oar-mlwp-data"
MODELS = ["GRAP", "FOUR"]
BASE_DIR = "data"

# S3 bağlantısı (anonim)
s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))

def download_latest():
    # Bugünün tarihini al
    today = datetime.utcnow()
    yyyy = today.strftime("%Y")
    mmdd = today.strftime("%m%d")

    for model in MODELS:
        prefix = f"{model}_v100_GFS/{yyyy}/{mmdd}/"
        print(f"\n{model} için dosyalar aranıyor: {prefix}")

        try:
            response = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
            if "Contents" not in response:
                print(f"Bugün için veri bulunamadı, dün deneniyor...")
                yesterday = today - timedelta(days=1)
                mmdd = yesterday.strftime("%m%d")
                prefix = f"{model}_v100_GFS/{yyyy}/{mmdd}/"
                response = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)

            if "Contents" in response:
                files = [obj["Key"] for obj in response["Contents"]]
                print(f"{len(files)} dosya bulundu:")
                for f in files[:5]:
                    print(f"  {f}")
            else:
                print("Veri bulunamadı.")

        except Exception as e:
            print(f"Hata: {e}")

if __name__ == "__main__":
    download_latest()