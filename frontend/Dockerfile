# syntax=docker/dockerfile:1

# --- build stage: compile the React app to static files --------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Same layering trick as the backend: lockfile first, source second.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite bakes env vars in at BUILD time, not run time -- there is no server to
# read them later, just static files. So the API URL has to be known here.
ARG VITE_API_URL=http://localhost:8077
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- runtime stage: nginx serving the built files --------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1
