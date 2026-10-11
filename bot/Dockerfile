FROM python:3.12-slim
# LibreOffice — Word→PDF va namunalar (preview) uchun; DejaVu — kirill shriftlari
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-impress fonts-dejavu fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
VOLUME /app/data
CMD ["python", "main.py"]
