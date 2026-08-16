#!/usr/bin/env bash
set -euo pipefail
php -S 0.0.0.0:${PORT:-8080} -t .
