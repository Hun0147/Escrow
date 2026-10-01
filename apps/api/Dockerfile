# The API is a long-lived process: it holds Socket.io connections and runs the
# OCR, deadline and renewal workers on timers. That is why it is a container
# and not a serverless function — see DEPLOY.md.
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# apps/web is a workspace member; its manifest has to exist for the lockfile to
# install, but nothing from it is copied or built into this image.
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=packages/shared --workspace=apps/api --include-workspace-root

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace=packages/shared && npm run build --workspace=apps/api

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist

# Evidence lives here by default. A container filesystem is ephemeral, so this
# must be a mounted volume or, better, S3 before any dispute depends on it.
ENV EVIDENCE_DIR=/data/evidence
RUN mkdir -p /data/evidence && chown -R node:node /data
USER node

EXPOSE 4000
# Migrations are idempotent and tracked in schema_migrations, so running them
# on boot is safe and keeps a deploy to one step.
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/server.js"]
