"""
init_s3.py — Run ONCE to:
  Apply a CORS policy so the browser can PUT files directly to S3.
  (Required for the high-speed presigned-URL upload flow)

This script ONLY configures CORS. It assumes folder structures already exist.
Usage: python init_s3.py
"""

import json
import boto3
import os
from dotenv import load_dotenv

load_dotenv()

AWS_REGION     = os.getenv("AWS_REGION")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

def apply_cors():
    """
    Allow browser origins to PUT objects using presigned URLs.
    """
    s3 = boto3.client("s3", region_name=AWS_REGION)

    cors_config = {
        "CORSRules": [
            {
                # AllowedOrigins: The list of websites allowed to talk to S3.
                # ["*"] is used here for maximum compatibility during development.
                "AllowedOrigins": ["*"],
                "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
                "AllowedHeaders": ["*"],
                "ExposeHeaders":  ["ETag"],
                "MaxAgeSeconds":  3600,
            }
        ]
    }

    print(f"\n🌐 Applying CORS policy to bucket '{S3_BUCKET_NAME}'...")
    try:
        s3.put_bucket_cors(
            Bucket=S3_BUCKET_NAME,
            CORSConfiguration=cors_config,
        )
        print(f"   ✅  Success! Browser uploads are now enabled.")
        print(f"   Current Config: {json.dumps(cors_config, indent=2)}")
    except Exception as e:
        print(f"   ❌  Failed: {e}")

if __name__ == "__main__":
    if not S3_BUCKET_NAME:
        print("❌ S3_BUCKET_NAME not found in .env")
    else:
        apply_cors()
