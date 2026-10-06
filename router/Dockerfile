# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /out/router ./cmd/router && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /out/zmqnotify ./cmd/zmqnotify && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /out/testminer ./cmd/testminer

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/router /router
COPY --from=build /out/zmqnotify /zmqnotify
# Regtest harness only (router/test/regtest); tiny, never used in production
COPY --from=build /out/testminer /testminer
USER nonroot
EXPOSE 3333 9100
ENTRYPOINT ["/router"]
