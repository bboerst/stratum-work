# db/Dockerfile
FROM postgres:17-alpine
RUN apk add --no-cache bash
COPY migrations /migrations
COPY migrate.sh /usr/local/bin/migrate.sh
ENV MIGRATIONS_DIR=/migrations
ENTRYPOINT ["/usr/local/bin/migrate.sh"]
