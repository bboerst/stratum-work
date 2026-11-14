# Go collector (stratum-work#148): a static binary on scratch, running as an unprivileged user.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /collector . && /collector -h 2>&1 | head -1

FROM scratch
# CA bundle for https (Bitcoin RPC without a CA file, the BCH confirmation API).
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /collector /collector
USER 65534:65534
ENTRYPOINT ["/collector"]
