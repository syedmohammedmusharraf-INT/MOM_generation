import boto3
import os
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError

# Configuration
BUCKET_NAME = "vyom-backend-1"
REGION = "ap-south-1"
TEST_FILE_NAME = "test_connection.txt"
S3_FOLDER = "new_audio_files/"

def test_upload():
    print(f"Testing connection to bucket: {BUCKET_NAME} in {REGION}...")
    
    # Create a dummy file
    with open(TEST_FILE_NAME, "w") as f:
        f.write("This is a test file to verify S3 upload permissions.")

    try:
        # Initialize S3 client without credentials (UNSIGNED)
        s3 = boto3.client('s3', region_name=REGION, config=Config(signature_version=UNSIGNED))
        
        object_key = f"{S3_FOLDER}{TEST_FILE_NAME}"
        
        print(f"Attempting to upload '{TEST_FILE_NAME}' to '{object_key}'...")
        s3.upload_file(TEST_FILE_NAME, BUCKET_NAME, object_key)
        
        print("\n✅ SUCCESS! File uploaded successfully.")
        print(f"File URL: https://{BUCKET_NAME}.s3.{REGION}.amazonaws.com/{object_key}")
        print("\nYour backend is ready to use.")
        
    except ClientError as e:
        print("\n❌ ERROR: Upload failed.")
        print(f"Details: {e}")
        print("\nTroubleshooting:")
        print("1. Check your Bucket Policy in AWS Console.")
        print("2. Ensure 'Block Public Access' is turned OFF for the bucket.")
        print("3. Ensure the policy allows 's3:PutObject' for 'Principal': '*'.")
    except Exception as e:
        print(f"\n❌ An unexpected error occurred: {e}")
    finally:
        # Cleanup local file
        if os.path.exists(TEST_FILE_NAME):
            os.remove(TEST_FILE_NAME)

if __name__ == "__main__":
    test_upload()
