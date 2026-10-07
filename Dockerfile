# Air Drift for SoundTouch. Node with no npm dependencies, plus ffmpeg for the
# stations a speaker cannot decode by itself.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg tini \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

ENV NODE_ENV=production \
    PORT=8686 \
    DATA_DIR=/data

USER node
VOLUME /data
EXPOSE 8686

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.mjs"]
