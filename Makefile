# Nirnaya: `make install`, then `make run` (build + serve on http://127.0.0.1:8000) or `make dev`.
PY ?= python3
PORT ?= 8000

.PHONY: install build run dev test test-backend test-web e2e clean

install:
	$(PY) -m pip install -e "backend[dev,llm,docs,monitoring]"
	cd web && npm ci

build:
	cd web && npm run build

run: build
	cd backend && $(PY) -m nirnaya --port $(PORT)

# API on :8000 with reload, web on :5173 with hot reload (proxied to the API)
dev:
	(cd backend && $(PY) -m uvicorn "nirnaya.api:create_app" --factory --reload --port $(PORT)) & \
	(cd web && npm run dev)

test: test-backend test-web

test-backend:
	cd backend && $(PY) -m pytest -q

test-web:
	cd web && npx tsc -b --noEmit && npm run build

# needs a running server: `make run` in another terminal
e2e:
	cd web && npm run e2e

clean:
	rm -rf web/dist backend/data
