# Node 24, the current LTS and what development uses; its npm 11 matches the one that writes package-lock.json
FROM node:24-alpine

WORKDIR /app

# Prisma's migration engine links against OpenSSL
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Generates the Prisma client, then builds the site (see "build" in package.json). No database is needed for this.
RUN npm run build

EXPOSE 3000

# Applies any new database migrations before starting, so deploying stays git pull and docker compose up -d --build
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
