FROM python:3.12-slim

WORKDIR /app
COPY . /app

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8000

ENV GUNICORN_WORKERS=2

CMD gunicorn --log-level info --access-logfile - --error-logfile - --worker-class eventlet -w $GUNICORN_WORKERS --bind 0.0.0.0:8000 main:app