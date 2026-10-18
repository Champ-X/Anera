#!/bin/bash
set -euo pipefail
ANERA_ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec /bin/bash "$ANERA_ROOT/start.sh" "$@"
