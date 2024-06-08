FROM python:3.12-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV GUNICORN_WORKERS=2

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gettext \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements.txt and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . /app

# Create a non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
RUN chown -R appuser:appgroup /app
USER appuser

# Expose the application port
EXPOSE 8000

# Create the Gunicorn configuration file template
RUN echo "\
import gunicorn\n\
bind = '0.0.0.0:8000'\n\
workers = \$GUNICORN_WORKERS\n\
worker_class = 'eventlet'\n\
secure_scheme_headers = {'X-FORWARDED-PROTOCOL': 'ssl', 'X-FORWARDED-PROTO': 'https', 'X-FORWARDED-SSL': 'on'}\n\
forwarded_allow_ips = '*'\n\
keepalive = 65\n\
timeout = 300\n\
proc_name = 'stratum-work'\n\
loglevel = 'info'\n\
accesslog = '-'\n\
errorlog = '-'\n\
gunicorn.SERVER = 'undisclosed'\n\
" > gunicorn.conf.py.template

# Run the application with Gunicorn
CMD envsubst < gunicorn.conf.py.template > gunicorn.conf.py && gunicorn --config gunicorn.conf.py main:app