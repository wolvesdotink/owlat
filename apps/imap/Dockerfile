# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY --parents apps/imap/package.json ./

RUN cd apps/imap && bun install

COPY apps/imap/tsconfig.json apps/imap/
COPY apps/imap/src/ apps/imap/src/

RUN cd apps/imap && bun run build

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/imap/dist ./dist
COPY --from=builder /app/apps/imap/node_modules ./node_modules
COPY apps/imap/package.json ./

ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="owlat-imap" \
      org.opencontainers.image.description="Owlat IMAP server" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 993

CMD ["node", "dist/index.js"]
