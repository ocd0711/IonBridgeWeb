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
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY package*.json ./
VOLUME ["/data"]
EXPOSE 18318
CMD ["node", "server/server.mjs"]
