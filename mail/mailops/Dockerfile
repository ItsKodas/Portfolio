FROM golang:1.23-alpine AS lego
RUN go install github.com/go-acme/lego/v4/cmd/lego@v4.19.2

FROM node:22-alpine
WORKDIR /app
COPY --from=lego /go/bin/lego /usr/local/bin/lego
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
CMD ["npm", "start"]
