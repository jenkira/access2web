#!/usr/bin/env bash
# Runs once when the Codespace is created: installs the dependencies and starts a PostgreSQL for the backend tests.
set -euo pipefail

pip install -e "backend[test]"
(cd web && npm ci --no-audit --no-fund)
if [ -f spikes/spike5-form-editor/package-lock.json ]; then
  (cd spikes/spike5-form-editor && npm ci --no-audit --no-fund)
fi

docker compose --profile test up -d --wait test-db
echo "Ready. Run the backend tests with: cd backend && python -m pytest"
echo "Run the whole stack with: docker compose up --build"
