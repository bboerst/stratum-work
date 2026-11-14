# The backfill tool as an image, for running next to a restored MongoDB in a cluster. Build context: the repository
# root, because the tool loads three modules from collector/ and backend/ (m2p/shared.py) so that conversion and
# routing are the collector's and backend's own code. Only those files are in the context
# (Dockerfile.dockerignore).
#
#   docker build -f tools/mongo-to-postgres/Dockerfile .
#   docker run --rm -e MONGO_URI=... -e PGHOST=... -e PGPASSWORD=... <image> migrate --until <T0> --workers 4
FROM python:3.13.18-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    M2P_REPO_ROOT=/app
WORKDIR /app/tools/mongo-to-postgres

COPY tools/mongo-to-postgres/requirements.txt ./
RUN pip install --root-user-action=ignore -r requirements.txt

COPY collector/coinbase.py collector/pgsink.py /app/collector/
COPY backend/integrations/store.py /app/backend/integrations/
COPY tools/mongo-to-postgres/m2p ./m2p

# Unprivileged; the tool writes nothing locally except --out files, so mount a writable directory for those.
USER 65534:65534
ENTRYPOINT ["python", "-m", "m2p"]
