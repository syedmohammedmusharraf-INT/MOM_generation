import os
from dotenv import load_dotenv

load_dotenv()

MONGODB_URI: str = os.getenv("MONGODB_URI", "")
MONGODB_DB: str  = os.getenv("MONGODB_DB", "mom_generation")
