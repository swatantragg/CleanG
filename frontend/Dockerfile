# Stage 1 — build static assets
FROM node:20-alpine AS build

WORKDIR /app

# Lockfile first -> dependency layer cache.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2 — serve via nginx, proxy /api to backend
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Where this container answers, echoed on boot so `docker compose logs frontend`
# tells you the URL outright. Compose overrides it per environment.
ENV SERVICE_URL=http://localhost

# `exec` hands PID 1 to nginx so SIGTERM/SIGQUIT still stop it cleanly.
CMD ["sh", "-c", "echo \"[CleanG] Frontend UI -> ${SERVICE_URL}  (SPA + /api proxied to the backend)\"; exec nginx -g 'daemon off;'"]
