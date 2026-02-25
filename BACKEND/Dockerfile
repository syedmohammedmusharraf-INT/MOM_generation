# Use a slim Python image
FROM python:3.10-slim

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Set working directory
WORKDIR /app

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy dependency files first (layer-cache friendly)
COPY pyproject.toml uv.lock ./

# Install dependencies using uv (everything already in lock)
RUN uv sync --frozen --no-dev --no-cache

# Place the venv's bin directory at the front of PATH
ENV PATH="/app/.venv/bin:$PATH"

# Explicitly install motor + pymongo via pip into the same venv
# This guarantees they are present even if uv.lock on the server is stale
RUN pip install --no-cache-dir "motor>=3.3.0" "pymongo>=4.6.0"

# Copy the rest of the application (respects .dockerignore)
COPY . .

# Expose backend port
EXPOSE 3000

# Run the backend with uvicorn
CMD ["uvicorn", "backend:app", "--host", "0.0.0.0", "--port", "3000"]
