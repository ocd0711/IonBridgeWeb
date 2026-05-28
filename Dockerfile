FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=18318
ENV IONBRIDGE_DATA_DIR=/data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --chown=node:node package*.json ./
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
EXPOSE 18318
USER node
CMD ["node", "server/server.mjs"]
