# us-trading backend — Railway용 (Root Directory를 backend로 지정하면 자동 감지)
# 페이퍼 장부(/app/data)는 컨테이너 재시작에 날아가므로 Railway Volume을
# /app/data 에 마운트할 것 — docs/deploy-railway.md 참고.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 페이퍼 장부 디렉터리 (볼륨 마운트 지점)
RUN mkdir -p /app/data
EXPOSE 4000
CMD ["node", "dist/index.js"]
