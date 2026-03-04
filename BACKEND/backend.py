from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import os
import boto3
from dotenv import load_dotenv
from datetime import datetime, timezone

# ── MongoDB ──────────────────────────────────────────────
from app.core.database import get_db
from bson import ObjectId

load_dotenv()

app = FastAPI(title="MOM api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- AWS CONFIGURATION (credentials come from EC2 IAM Role automatically) ---
AWS_REGION     = os.getenv("AWS_REGION")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

# Folder Structure
S3_ROOT_FOLDER      = "mom_audio_files/"
S3_INPUT_FOLDER     = f"{S3_ROOT_FOLDER}new_audio_files/"
S3_PROCESSED_FOLDER = f"{S3_ROOT_FOLDER}processed_audio_files/"

BASE_DIR            = os.path.dirname(os.path.abspath(__file__))
FOLDERS_INITIALIZED = False


def make_s3_client():
    """Return a boto3 S3 client. Credentials are picked up automatically from the EC2 IAM role."""
    return boto3.client("s3", region_name=AWS_REGION)


def ensure_s3_folders_exist(s3):
    """Create 0-byte folder placeholders in S3 if they don't exist."""
    if not S3_BUCKET_NAME:
        return
    for folder in [S3_ROOT_FOLDER, S3_INPUT_FOLDER, S3_PROCESSED_FOLDER]:
        try:
            s3.head_object(Bucket=S3_BUCKET_NAME, Key=folder)
        except Exception:
            try:
                s3.put_object(Bucket=S3_BUCKET_NAME, Key=folder)
                print(f"[S3] Created folder placeholder: {folder}")
            except Exception as e:
                print(f"[S3] Warning: Could not create folder {folder}: {e}")


def lazy_init_folders():
    global FOLDERS_INITIALIZED
    if not FOLDERS_INITIALIZED:
        try:
            ensure_s3_folders_exist(make_s3_client())
            FOLDERS_INITIALIZED = True
            print("[S3] Folder structure verified.")
        except Exception as e:
            print(f"[S3] Warning: Folder init failed: {e}")


# ═══════════════════════════════════════════════════════════
# UPLOAD — Browser → Backend → S3 (Middleware Flow)
# ═══════════════════════════════════════════════════════════

@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    """
    Standard upload: Browser sends file to backend, backend uploads to S3.
    Avoids CORS issues because the backend-to-S3 connection is not checked by the browser.
    """
    print(f"[UPLOAD] Received: '{file.filename}', type: {file.content_type}")
    lazy_init_folders()

    temp_path = os.path.join(BASE_DIR, f"temp_{file.filename}")
    try:
        # Read the file from the request
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        print(f"[UPLOAD] Read {len(contents):,} bytes.")

        # Save temporarily
        with open(temp_path, "wb") as f:
            f.write(contents)

        # Upload to S3
        s3       = make_s3_client()
        s3_key   = f"{S3_INPUT_FOLDER}{file.filename}"
        file_url = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"

        print(f"[UPLOAD] Uploading to S3: {s3_key}")
        s3.upload_file(temp_path, S3_BUCKET_NAME, s3_key)
        print(f"[UPLOAD] S3 upload success.")

        # Save to MongoDB
        db = get_db()
        result = await db["meetings"].insert_one({
            "filename":     file.filename,
            "s3_key":       s3_key,
            "s3_url":       file_url,
            "status":       "uploaded",
            "uploaded_at":  datetime.now(timezone.utc),
            "attendees":    None,
            "context":      None,
            "meeting_date": None,
        })
        mongo_id = str(result.inserted_id)
        print(f"[UPLOAD] MongoDB doc created: {mongo_id}")

        return {"status": "success", "file_url": file_url, "s3_key": s3_key, "mongo_id": mongo_id}

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"[UPLOAD] Error ({type(e).__name__}): {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


# ═══════════════════════════════════════════════════════════
# MEETINGS ENDPOINTS (Static routes first!)
# ═══════════════════════════════════════════════════════════

class RegisterMeeting(BaseModel):
    filename:     str
    s3_key:       str
    file_url:     str
    content_type: Optional[str] = None


@app.post("/api/meetings/register")
async def register_meeting(body: RegisterMeeting):
    """Fallback for presigned URL flow (kept for compatibility)"""
    db = get_db()
    meeting_doc = {
        "filename":     body.filename,
        "s3_key":       body.s3_key,
        "s3_url":       body.file_url,
        "status":       "uploaded",
        "uploaded_at":  datetime.now(timezone.utc),
        "attendees":    None,
        "context":      None,
        "meeting_date": None,
    }
    result   = await db["meetings"].insert_one(meeting_doc)
    mongo_id = str(result.inserted_id)
    return {"status": "success", "mongo_id": mongo_id}


@app.get("/api/meetings/{mongo_id}")
async def get_meeting(mongo_id: str):
    if not ObjectId.is_valid(mongo_id):
        raise HTTPException(status_code=400, detail="Invalid meeting ID")
    db  = get_db()
    doc = await db["meetings"].find_one({"_id": ObjectId(mongo_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")
    doc["_id"] = str(doc["_id"])
    for field in ("uploaded_at", "updated_at"):
        if field in doc and isinstance(doc[field], datetime):
            doc[field] = doc[field].isoformat()
    return doc


class MeetingDetails(BaseModel):
    attendees:    str
    context:      Optional[str] = None
    meeting_date: Optional[str] = None


@app.patch("/api/meetings/{mongo_id}")
async def update_meeting_details(mongo_id: str, body: MeetingDetails):
    if not ObjectId.is_valid(mongo_id):
        raise HTTPException(status_code=400, detail="Invalid meeting ID")
    db     = get_db()
    result = await db["meetings"].update_one(
        {"_id": ObjectId(mongo_id)},
        {"$set": {
            "attendees":    body.attendees,
            "context":      body.context,
            "meeting_date": body.meeting_date,
            "status":       "details_submitted",
            "updated_at":   datetime.now(timezone.utc),
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"status": "success", "mongo_id": mongo_id}


# ═══════════════════════════════════════════════════════════
# FILES ENDPOINTS (Static routes first!)
# ═══════════════════════════════════════════════════════════

@app.get("/api/files")
async def list_files():
    if not S3_BUCKET_NAME:
        raise HTTPException(status_code=500, detail="Bucket name not configured")
    s3 = make_s3_client()
    def get_files_from_prefix(prefix):
        try:
            response = s3.list_objects_v2(Bucket=S3_BUCKET_NAME, Prefix=prefix)
            if "Contents" not in response:
                return []
            return [os.path.basename(obj["Key"]) for obj in response["Contents"] if not obj["Key"].endswith("/")]
        except Exception as e:
            return []
    return {
        "new_audio_files":       get_files_from_prefix(S3_INPUT_FOLDER),
        "processed_audio_files": get_files_from_prefix(S3_PROCESSED_FOLDER),
    }


@app.get("/api/files/oldest")
async def get_oldest_file():
    if not S3_BUCKET_NAME:
        raise HTTPException(status_code=500, detail="Bucket name not configured")
    s3 = make_s3_client()
    try:
        response = s3.list_objects_v2(Bucket=S3_BUCKET_NAME, Prefix=S3_INPUT_FOLDER)
        if "Contents" not in response:
            return {"status": "empty"}
        files = [obj for obj in response["Contents"] if not obj["Key"].endswith("/")]
        if not files:
            return {"status": "empty"}
        files.sort(key=lambda x: x["LastModified"])
        oldest   = files[0]
        full_key = oldest["Key"]
        filename = os.path.basename(full_key)
        file_url = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{full_key}"
        db  = get_db()
        doc = await db["meetings"].find_one({"s3_key": full_key}, {"_id": 1})
        mongo_id = str(doc["_id"]) if doc else None
        return {
            "status":        "success",
            "filename":      filename,
            "s3_key":        full_key,
            "file_url":      file_url,
            "mongo_id":      mongo_id,
            "last_modified": oldest["LastModified"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/files/all")
async def delete_all_files():
    """
    🔴 Nuclear option: delete ALL audio files from S3 and ALL meeting records from MongoDB.
    Lists every object under the root folder, batch-deletes them, then clears the DB collection.
    """
    if not S3_BUCKET_NAME:
        raise HTTPException(status_code=500, detail="Bucket name not configured")

    s3 = make_s3_client()
    deleted_count = 0

    try:
        # Paginate through all objects under the root folder
        paginator = s3.get_paginator("list_objects_v2")
        objects_to_delete = []

        for page in paginator.paginate(Bucket=S3_BUCKET_NAME, Prefix=S3_ROOT_FOLDER):
            for obj in page.get("Contents", []):
                # Keep folder placeholders (trailing "/"), delete everything else
                if not obj["Key"].endswith("/"):
                    objects_to_delete.append({"Key": obj["Key"]})

        # S3 delete_objects accepts max 1000 keys per call
        if objects_to_delete:
            for i in range(0, len(objects_to_delete), 1000):
                batch = objects_to_delete[i : i + 1000]
                s3.delete_objects(Bucket=S3_BUCKET_NAME, Delete={"Objects": batch})
                deleted_count += len(batch)

        print(f"[CLEANUP] Deleted {deleted_count} files from S3.")

        # Also purge MongoDB meeting documents
        db = get_db()
        mongo_result = await db["meetings"].delete_many({})
        print(f"[CLEANUP] Deleted {mongo_result.deleted_count} records from MongoDB.")

        return {
            "status":       "success",
            "s3_deleted":   deleted_count,
            "db_deleted":   mongo_result.deleted_count,
        }
    except Exception as e:
        print(f"[CLEANUP] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/files/{filename}")
async def delete_file(filename: str):
    if not S3_BUCKET_NAME:
        raise HTTPException(status_code=500, detail="Bucket name not configured")
    s3          = make_s3_client()
    deleted_any = False
    for key in [f"{S3_INPUT_FOLDER}{filename}", f"{S3_PROCESSED_FOLDER}{filename}"]:
        try:
            s3.head_object(Bucket=S3_BUCKET_NAME, Key=key)
            s3.delete_object(Bucket=S3_BUCKET_NAME, Key=key)
            deleted_any = True
        except Exception:
            pass
    if deleted_any:
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="File not found")


# ═══════════════════════════════════════════════════════════
# PRESIGN FALLBACK (In case needed later)
# ═══════════════════════════════════════════════════════════

@app.get("/api/presign")
async def get_presigned_url(filename: str = Query(...), content_type: str = Query("audio/mpeg")):
    if not S3_BUCKET_NAME:
        raise HTTPException(status_code=500, detail="S3_BUCKET_NAME not configured")
    lazy_init_folders()
    s3_key = f"{S3_INPUT_FOLDER}{filename}"
    file_url = f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{s3_key}"
    try:
        s3 = make_s3_client()
        presigned_url = s3.generate_presigned_url("put_object", Params={"Bucket":S3_BUCKET_NAME,"Key":s3_key,"ContentType":content_type}, ExpiresIn=3600)
        return {"presigned_url": presigned_url, "s3_key": s3_key, "file_url": file_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="localhost", port=3000)
