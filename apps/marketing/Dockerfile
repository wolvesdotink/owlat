# syntax=docker/dockerfile:1.7-labs

# ── Stage 1: Install dependencies ──
FROM oven/bun:1.3-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root files (catalogs live in root package.json)
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/

# Copy all workspace package.json files for dependency resolution
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./

RUN bun install --frozen-lockfile

# ── Stage 2: Build ──
FROM node:26-alpine AS build

WORKDIR /app/apps/marketing

COPY --from=deps /app/node_modules ../../node_modules
COPY apps/marketing/ ./
COPY packages/ui/ ../../packages/ui/

# Generate packages/ui/.nuxt/tsconfig.json (excluded from Docker context by
# .dockerignore) so Vite's Vue plugin can resolve the layer's tsconfig when
# transforming layer components like ThemeToggle.vue.
RUN cd ../../packages/ui && npx nuxi prepare

RUN npx nuxt generate

# ── Stage 3: Runtime ──
FROM nginx:alpine AS runtime

RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    location / {\n\
        try_files $uri $uri/ $uri.html /index.html;\n\
    }\n\
\n\
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {\n\
        expires 1y;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
\n\
    gzip on;\n\
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/apps/marketing/.output/public /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
