# Build the web front end, then the runtime image. Build from the repository root.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.11-slim
RUN useradd --uid 10001 --no-create-home a2w
WORKDIR /srv
COPY backend/ ./backend/
RUN pip install --no-cache-dir ./backend
COPY --from=web /web/dist /srv/web
ENV A2W_WEB_DIR=/srv/web
USER 10001
EXPOSE 8000
CMD ["uvicorn", "a2w.api:app", "--host", "0.0.0.0", "--port", "8000"]
