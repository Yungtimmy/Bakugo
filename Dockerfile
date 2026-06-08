FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production image
FROM node:20-alpine

# Use Google DNS to avoid Fly.io DNS resolution failures
RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf && \
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
