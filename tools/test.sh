#!/bin/sh
# Every test in the project. No network, no credentials, no Google runtime —
# so there is never a reason not to run it before pasting Code.gs somewhere.
#
#   sh tools/test.sh
set -e
cd "$(dirname "$0")/.."
node tools/test_code_gs.js
echo
python3 tools/test_console.py
