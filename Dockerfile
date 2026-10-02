# The reference host: the Kapula server over an in-memory store plus the
# phone web app, as one image. Configure with KAPULA_OWNER_TOKEN (the owner's
# login), PORT (default 4310) and the KAPULA_* timing overrides.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/phone/package.json packages/phone/
COPY apps/host/package.json apps/host/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/phone/package.json packages/phone/
COPY --from=build /app/apps/host/package.json apps/host/
RUN npm ci --omit=dev
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/phone/dist packages/phone/dist
COPY --from=build /app/apps/host/dist apps/host/dist
COPY --from=build /app/apps/host/public apps/host/public
EXPOSE 4310
CMD ["node", "apps/host/dist/server/main.js"]
