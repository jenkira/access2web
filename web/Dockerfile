# The Access2Web web front end, served by nginx. Build with the web directory as the context: docker build -t access2web-frontend web
FROM node:22-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build

# A generic nginx that runs as a non-root user and listens on 8080. It serves the built files, and proxies /api/ to the backend.
# The image's entrypoint fills ${BACKEND_URL} into the template when the container starts.
FROM nginxinc/nginx-unprivileged:1.27-alpine
# The base image can lag behind Alpine's security fixes, and CI fails the build on a fixable critical finding, so upgrade the
# packages here. The image still runs as the unprivileged user.
USER root
RUN apk upgrade --no-cache
USER 101
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /web/dist /usr/share/nginx/html
ENV BACKEND_URL=http://backend:8000
# Development only, see the template. Empty means the client's own headers pass through. They must be defined, or the entrypoint
# leaves them in the template and nginx refuses to start.
ENV A2W_DEV_USER="" A2W_DEV_ROLES="" A2W_DEV_GROUPS=""
USER 101
EXPOSE 8080
