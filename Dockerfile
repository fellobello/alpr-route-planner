# Production image: no npm dependencies, so this is Node plus the source.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data/sample-cameras.json ./data/
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
# Overpass tiles survive restarts when this is a volume.
RUN mkdir -p data/cache && chown node:node data/cache
VOLUME /app/data/cache
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server/main.js"]
