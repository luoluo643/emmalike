#!/usr/bin/env bash
# Runs e2e suites against a throwaway official SillyTavern with only this work copy's tavern-lite installed (and Horae
# when WITH_HORAE=1). Each run uses its own compose project and ports, so several sessions can test side by side and
# nothing touches the production instance.
#
#   PROJECT=tlmine ST_PORT=8095 MOCK_PORT=5065 bash tests/run-isolated.sh e2e-toc e2e-m9
#   PROJECT=tlmine ST_PORT=8095 MOCK_PORT=5065 bash tests/run-isolated.sh down
#
# Suites written for the coordinated instances (8031, 8032, 8035) run from a copy with that address replaced by this
# run's port; their own guards still refuse any other address. Each suite gets the arguments it expects (see ARGS) and
# is killed after TIMEOUT seconds (default 900), so one stuck suite cannot stall the rest.
# Other settings: ST_IMAGE, WITH_HORAE (0), TAVERN_HELPER_REF (empty: none), INSTALL_PANEL_FIXTURE (0),
# LOG_DIR (/tmp/<project>).
set -u
cd "$(dirname "$0")"
: "${PROJECT:?set PROJECT, ST_PORT and MOCK_PORT}" "${ST_PORT:?}" "${MOCK_PORT:?}"
export COMPOSE_PROJECT_NAME=$PROJECT ST_PORT MOCK_PORT ST_IMAGE=${ST_IMAGE:-ghcr.io/sillytavern/sillytavern:1.19.0}
LOG_DIR=${LOG_DIR:-/tmp/$PROJECT}
if [ "${1:-}" = down ]; then docker compose down --remove-orphans; rm -rf config data plugins extensions installation.json e2e-*-p"$ST_PORT".mjs; echo DOWN; exit; fi
mkdir -p "$LOG_DIR"
export TAVERN_HELPER_REF="${TAVERN_HELPER_REF-}" INSTALL_PANEL_FIXTURE="${INSTALL_PANEL_FIXTURE:-0}"
bash ./prepare.sh > "$LOG_DIR/prepare.log" 2>&1 || { echo PREPARE-FAILED; tail -5 "$LOG_DIR/prepare.log"; }
if [ "${WITH_HORAE:-0}" = 1 ]; then
    cp -r "${HORAE_DIR:-/home/ubuntu/sillytavern/third-party/SillyTavern-Horae}" extensions/ && echo "with Horae $(md5sum extensions/SillyTavern-Horae/index.js | cut -c1-8)"
fi
tr -d '\n ' < installation.json; echo; echo "image $ST_IMAGE"
export CHROME_PATH=${CHROME_PATH:-$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/*/ | head -1)chrome-headless-shell}
export PLAYWRIGHT_CORE=${PLAYWRIGHT_CORE:-$PWD/../node_modules/playwright-core}
export ST_URL=http://127.0.0.1:$ST_PORT MOCK_URL=http://127.0.0.1:$MOCK_PORT
export MOCK_COUNT_URL=$MOCK_URL/count MOCK_LAST_URL=$MOCK_URL/last

# The arguments each suite takes. Suites that check for "--cases=" take none; evidence suites take a folder.
args_for() {
    case "$1" in
        e2e-personal) echo "$ST_URL ${PERSONAL_MODE:-device}" ;;
        e2e-install-scope) echo "$ST_URL $PWD" ;;
        e2e-onboarding|e2e-ui-world-editor|e2e-ui-preset-editor|e2e-ui-preset-boundaries|e2e-ui-episodes|e2e-ui-workspace) echo "" ;;
        e2e-ui-appearance|e2e-ui-performance) echo "$LOG_DIR/$1-evidence" ;;
        e2e-share) echo "$ST_URL default-user test1234" ;;
        *) if grep -q "startsWith('--cases=')" "$1.mjs"; then echo ""; else echo "$ST_URL default-user test1234 200 5000"; fi ;;
    esac
}
for s in "$@"; do
    f=$s.mjs
    if grep -qE '127\.0\.0\.1:80(31|32|35)' "$f"; then
        sed -E "s#127\.0\.0\.1:80(31|32|35)#127.0.0.1:$ST_PORT#g" "$f" > "$s-p$ST_PORT.mjs"; f=$s-p$ST_PORT.mjs
    fi
    echo "=== $s"
    # shellcheck disable=SC2046
    timeout -s KILL "${TIMEOUT:-900}" node "$f" $(args_for "$s") > "$LOG_DIR/$s.log" 2>&1; rc=$?
    grep -E '^(FAIL|PASS|FAILURE|PROBLEMS|ALL PASS)|"FAIL|"passed"' "$LOG_DIR/$s.log" | grep -v '^PASS' | tail -15
    [ $rc = 137 ] && echo "killed after ${TIMEOUT:-900}s"
    echo "exit $rc"
done
echo RUN-DONE
