FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY locales ./locales
VOLUME ["/app/config", "/app/data", "/app/logs", "/app/backups"]
CMD ["npm", "start"]
