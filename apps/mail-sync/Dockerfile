# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/mail-sync/package.json ./

RUN cd apps/mail-sync && bun install

COPY apps/mail-sync/tsconfig.json apps/mail-sync/
COPY apps/mail-sync/src/ apps/mail-sync/src/

RUN cd apps/mail-sync && bun run build

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/mail-sync/dist ./dist
COPY --from=builder /app/apps/mail-sync/node_modules ./node_modules
COPY apps/mail-sync/package.json ./

ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-mail-sync" \
      org.opencontainers.image.description="Owlat mail-sync worker (external IMAP/SMTP accounts)" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 3200

CMD ["node", "dist/index.js"]
