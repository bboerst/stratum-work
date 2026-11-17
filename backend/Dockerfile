FROM python:3.13.18-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code: every top-level module (a new one can't be left out, #222's gap_fill.py was), plus packages
COPY *.py ./
COPY analytics ./analytics
COPY integrations ./integrations

CMD ["python", "main.py"] 