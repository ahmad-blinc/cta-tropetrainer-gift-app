FROM node:20-alpine
RUN apk add --no-cache openssl chromium nss freetype harfbuzz ca-certificates ttf-freefont

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
# Puppeteer's own downloaded Chromium build doesn't run on Alpine (glibc vs
# musl), so use Alpine's own chromium package instead and skip that download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
