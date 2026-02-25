from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from app.core.config import MONGODB_URI, MONGODB_DB

# Single client shared across the app lifetime
client: AsyncIOMotorClient = AsyncIOMotorClient(MONGODB_URI)
db: AsyncIOMotorDatabase   = client[MONGODB_DB]


def get_db() -> AsyncIOMotorDatabase:
    """Return the active database instance."""
    return db