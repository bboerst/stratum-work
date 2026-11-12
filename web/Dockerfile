# Stage 1: Build the Next.js app
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the application source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the application if production
ARG ENVIRONMENT=production
# (development: no build; create an empty .next so the runner stage's COPY succeeds and `next dev` takes over)
RUN if [ "$ENVIRONMENT" = "production" ]; then npm run build; else mkdir -p .next; fi

# Stage 2: Run the application
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runner

WORKDIR /app

# Copy necessary files from the builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/prisma ./prisma

# Install production dependencies only if in production
ARG ENVIRONMENT=production
RUN if [ "$ENVIRONMENT" = "production" ]; then npm ci --production; else npm ci; fi

EXPOSE 3000

# Set the environment variable
ENV ENVIRONMENT=${ENVIRONMENT}

# Command to run based on the environment
CMD ["sh", "-c", "if [ \"$ENVIRONMENT\" = \"production\" ]; then npm start; else npm run dev; fi"]