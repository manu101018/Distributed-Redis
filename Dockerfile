# build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
COPY benchmark ./benchmark
RUN npm run build

# run time stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
RUN apk add --no-cache redis
COPY --from=build /app/dist ./dist

EXPOSE 6380
ENV PORT=6380
ENV CLUSTER_MODE=false

CMD ["node", "dist/src/server.js"]