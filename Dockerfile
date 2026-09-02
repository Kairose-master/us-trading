# 레포 루트에서 빌드해도 백엔드가 뜨도록 (Railway에서 Root Directory를
# 안 잡았을 때의 안전망). backend/Dockerfile과 동일 — 경로만 backend/ 접두.

FROM node:22-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
EXPOSE 4000
CMD ["node", "dist/index.js"]
