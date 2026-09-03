#!/usr/bin/env bash
# SessionStart probe: prints PLUGIN_ROOT + cwd to prove plugin hooks work.
echo "agento-spike-hook: PLUGIN_ROOT=${PLUGIN_ROOT:-<unset>} cwd=${1:-$(pwd)}"
exit 0
