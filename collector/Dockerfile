FROM python:3.13.18-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY main.py chain_detection.py latency.py coinbase.py pgsink.py rmqsink.py ./

CMD ["/usr/local/bin/python", "main.py"]
