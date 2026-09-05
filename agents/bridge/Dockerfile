FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY agents/requirements.lock /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY agents/sceneatlas /app/sceneatlas
COPY agents/bridge /app/bridge
CMD ["sh", "-c", "uvicorn bridge.main:app --host 0.0.0.0 --port ${PORT}"]
