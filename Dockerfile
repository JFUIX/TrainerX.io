FROM node:22-alpine
RUN apk add --no-cache postgresql18-client
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs gym-operations.mjs init-db.mjs reset-once.mjs sheets-backup.mjs schema.sql ./
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
CMD ["node","server.mjs"]
