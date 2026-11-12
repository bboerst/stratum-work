# PostgreSQL 18 + TimescaleDB for CloudNativePG (design: docs/design/postgres-timescale.md, section 4).
# CloudNativePG needs its own operand image layout, and there is no upstream CNPG + TimescaleDB image, so this extends
# the CNPG "standard" image with Timescale's packages. Built by .github/workflows/images.yml as
# bboerst/stratum-work-postgres:sha-<7>.
#
# The CNPG Cluster must set:  postgresql.shared_preload_libraries: [timescaledb]
#                             postgresql.parameters: { timescaledb.enable_chunk_skipping: "on" }
# Local development uses the official timescale/timescaledb image instead (docker compose --profile postgres).

# 18.6-standard-trixie, pinned by digest (CNPG rebuilds tags for security fixes; bump deliberately)
FROM ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie@sha256:de572898499fab9406f0da51929da562f96f3be40ca79fafea8ec1a8d5b42065

# Timescale packages ship the .so of every past release (~400 MB) so `ALTER EXTENSION timescaledb UPDATE` works from any
# older version. Kept on purpose: pruning would break in-place upgrades when this image is bumped.
ARG TIMESCALEDB_VERSION=2.30.2
USER root
RUN set -eux; \
    apt-get update; \
    BUILD_DEPS=""; for pkg in ca-certificates curl gnupg; do dpkg -s "$pkg" >/dev/null 2>&1 || BUILD_DEPS="$BUILD_DEPS $pkg"; done; \
    if [ -n "$BUILD_DEPS" ]; then apt-get install -y --no-install-recommends $BUILD_DEPS; fi; \
    curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/timescaledb.list; \
    apt-get update; \
    PG_MAJOR=$(pg_config --version | sed -E 's/^PostgreSQL ([0-9]+).*/\1/'); \
    PKG_VERSION=$(apt-cache madison "timescaledb-2-postgresql-${PG_MAJOR}" \
      | awk -v v="${TIMESCALEDB_VERSION}~" 'index($3, v) == 1 {print $3; exit}'); \
    test -n "${PKG_VERSION}"; \
    apt-get install -y --no-install-recommends \
      "timescaledb-2-postgresql-${PG_MAJOR}=${PKG_VERSION}" "timescaledb-2-loader-postgresql-${PG_MAJOR}=${PKG_VERSION}"; \
    if [ -n "$BUILD_DEPS" ]; then apt-get purge -y --auto-remove $BUILD_DEPS; fi; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
USER 26
