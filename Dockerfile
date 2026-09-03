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
# PyGAD(진화 연산자) + arch(SPA 다중비교 검정) (backend/evolution/pygad_step.py). 없으면 내장 연산자로 대체되고 결과에 engine이 적힌다
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && pip3 install --no-cache-dir --break-system-packages pygad numpy arch && rm -rf /var/lib/apt/lists/*
COPY backend/evolution ./evolution
# 검증 사이드카 — SPA(Hansen 데이터 스누핑 검정). 없으면 engine:"unavailable"로 답하고 p값을 지어내지 않는다
COPY backend/quant ./quant
RUN mkdir -p /app/data
EXPOSE 4000
CMD ["node", "dist/index.js"]
