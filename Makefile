# Nirnaya: `make install`, then `make run` (build + serve on http://127.0.0.1:8000) or `make dev`.
PY ?= python3
PORT ?= 8000

.PHONY: install build run dev test test-all test-backend test-web test-mail mail-server e2e e2e-phone e2e-flows e2e-team e2e-workflow e2e-fields e2e-channels audit exe apk icons clean

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

# everything automated, each browser suite on its own fresh server, then test-results/<target>/report.md
# (about 75 minutes; QUICK=1 skips the two slowest suites). TARGET=exe tests the Windows app's own server
# under wine, TARGET=apk the web files inside the APK.
test-all:
	TARGET=$(or $(TARGET),web) bash tools/test-all.sh

test-backend:
	cd backend && $(PY) -m pytest -q

test-web:
	cd web && npx tsc -b --noEmit && npm run build

# a real SMTP (:3025) and IMAP (:3143) server for the email tests (GreenMail, needs Java 17+); leave it running
GREENMAIL ?= $(HOME)/.cache/nirnaya/greenmail-standalone-2.1.14.jar
mail-server:
	@mkdir -p $(dir $(GREENMAIL))
	@test -f $(GREENMAIL) || curl -fsSL -o $(GREENMAIL) https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/2.1.14/greenmail-standalone-2.1.14.jar
	@echo "0cb7511420b76f63c6ed437088149dc8f7fc3a08  $(GREENMAIL)" | sha1sum -c --quiet
	java -Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=127.0.0.1 \
	  -Dgreenmail.users=support:secret@nirnaya.test,boss:secret@bank.test -jar $(GREENMAIL)

# email through the real mail server (start `make mail-server` in another terminal first)
test-mail:
	cd backend && $(PY) -m pytest -q tests/test_channels.py -k "real_mail_server or email"

# needs a running server: `make run` in another terminal
e2e:
	cd web && npm run e2e

# the Android app's flow at phone size (also needs a running server)
e2e-phone: build
	cd web && node e2e/phone-client.mjs

# flows by drag and drop, and two people on one server (both need a running server)
e2e-flows:
	cd web && node e2e/flows.mjs

e2e-team:
	cd web && node e2e/team.mjs

# workflow.md followed step by step, as a new user would (needs a running server)
e2e-workflow:
	cd web && node e2e/workflow.mjs

# every field, menu option and condition: the office (~25 min under software WebGL), the workspace, Flows
e2e-fields:
	cd web && node e2e/fields-office.mjs && node e2e/fields-workspace.mjs && node e2e/fields-flows.mjs

# Channels in a real browser: every field, real email (needs `make mail-server`), WhatsApp and Twilio stand-ins,
# a flow on a WhatsApp message, approve by email, the call page (needs a running server)
e2e-channels:
	cd web && node e2e/channels.mjs

# a supervisor's walk through every view and button (slow: about ten minutes)
audit:
	cd web && node e2e/audit.mjs

# Windows installer -> exe/dist/ (needs makensis; wine 10+ optional, see exe/README.md)
exe:
	bash exe/build.sh

# Android APK -> apk/dist/ (needs JDK 21 and the Android SDK, see apk/README.md)
apk:
	bash apk/build.sh

icons:
	$(PY) tools/make_icons.py

clean:
	rm -rf web/dist backend/data exe/build exe/bin apk/www
