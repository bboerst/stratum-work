# images/postgres/Dockerfile
ARG PG_MAJOR=17
FROM ghcr.io/cloudnative-pg/postgresql:${PG_MAJOR}-bookworm
ARG PG_MAJOR
ARG TIMESCALE_VERSION=2.30.2
USER root
# Pin the loader too: it ships timescaledb.control (default_version). An unpinned loader pulls
# the newest release, and CREATE EXTENSION then fails with "no installation script ... for
# version X" because only the pinned version's SQL scripts are installed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg ca-certificates lsb-release \
 && curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/timescaledb.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "timescaledb-2-postgresql-${PG_MAJOR}=${TIMESCALE_VERSION}*" \
      "timescaledb-2-loader-postgresql-${PG_MAJOR}=${TIMESCALE_VERSION}*" \
 && apt-get purge -y curl gnupg lsb-release && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
USER 26
