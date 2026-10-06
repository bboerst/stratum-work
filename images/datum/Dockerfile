# syntax=docker/dockerfile:1
# DATUM Gateway (OCEAN) built from a pinned upstream tag. Build steps mirror
# the upstream Dockerfile at that tag; the runtime runs as a fixed numeric
# non-root UID so Kubernetes runAsNonRoot can verify it.
ARG DATUM_VERSION=v0.4.1beta

FROM debian:bookworm-slim AS src
ARG DATUM_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${DATUM_VERSION}" https://github.com/OCEAN-xyz/datum_gateway /src

FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        gcc \
        pkg-config \
        libjansson-dev \
        libmicrohttpd-dev \
        libsodium-dev \
        libcurl4-openssl-dev \
        git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Includes .git so the build embeds the upstream version string
COPY --from=src /src/ ./
RUN cmake -DCMAKE_BUILD_TYPE=Release . && make -j"$(nproc)"

FROM debian:bookworm-slim AS runtime
ARG DATUM_VERSION
LABEL org.opencontainers.image.source="https://github.com/OCEAN-xyz/datum_gateway" \
      org.opencontainers.image.version="${DATUM_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjansson4 \
        libmicrohttpd12 \
        libsodium23 \
        libcurl4 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man \
    && find /var/cache -type f -delete
WORKDIR /app
COPY --from=builder /build/datum_gateway /app/datum_gateway
COPY --from=builder /build/doc/example_datum_gateway_config.json /app/config/example_config.json
RUN ldd /app/datum_gateway \
    && groupadd --system --gid 10001 datum \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin datum
USER 10001:10001
EXPOSE 23334/tcp 7152/tcp
ENTRYPOINT ["/app/datum_gateway", "--config", "/app/config/config.json"]
