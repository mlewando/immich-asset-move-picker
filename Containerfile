# Node 24 runs the TypeScript sources directly. The only build is the page's CSS (Tailwind),
# done in a throwaway stage so its dev dependencies stay out of the image.
# Base image pinned by digest (multi-arch node:24-alpine); bump deliberately.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS css
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY styles ./styles
COPY public ./public
RUN npm run build:css

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY --from=css /app/public ./public

# Runs as root on purpose: Immich writes the library as root, and the hard link replaces files
# in it.
EXPOSE 2284
# node:sqlite (the job queue) is still flagged experimental in Node 24: silence its startup warning.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
