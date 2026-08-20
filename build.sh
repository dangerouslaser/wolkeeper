#!/bin/bash
# Build the WoL Keeper ipk. Requires ares-package (@webos-tools/cli).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('src/appinfo.json'))['version'])")
rm -rf build && mkdir -p build/app
cp -r src/* build/app/
mkdir -p build/app/assets
cp daemon/wolkeeper.sh daemon/98-wolkeeper build/app/assets/
ares-package build/app -o build
echo "Built: $(ls build/*.ipk)"
