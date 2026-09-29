# One image: the web app is built, then served by the API process.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
COPY backend/ ./backend/
RUN pip install --no-cache-dir "./backend[llm,docs,monitoring]"
COPY --from=web /web/dist ./web/dist
ENV NIRNAYA_WEB=/app/web/dist NIRNAYA_DB=/data/nirnaya.db NIRNAYA_HOST=0.0.0.0
VOLUME /data
EXPOSE 8000
CMD ["python", "-m", "nirnaya"]
