# The Access2Web API. Build with the backend directory as the context: docker build -t access2web-backend backend
FROM python:3.11-slim
RUN useradd --uid 10001 --no-create-home a2w
WORKDIR /srv
COPY . ./backend/
RUN pip install --no-cache-dir ./backend
USER 10001
EXPOSE 8000
CMD ["uvicorn", "a2w.api:app", "--host", "0.0.0.0", "--port", "8000"]
