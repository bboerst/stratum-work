FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY main.py chain_detection.py latency.py ./

CMD ["/usr/local/bin/python", "main.py"]
