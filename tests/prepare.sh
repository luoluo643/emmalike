#!/usr/bin/env bash
# Prepares a vanilla SillyTavern (ST_IMAGE) with this extension installed for all users, plus the mock model service.
set -euo pipefail
cd "$(dirname "$0")"

export ST_IMAGE="${ST_IMAGE:-ghcr.io/sillytavern/sillytavern:1.19.0}"
export ST_PORT="${ST_PORT:-8031}"
export MOCK_PORT="${MOCK_PORT:-5001}"

docker compose down --remove-orphans >/dev/null 2>&1 || true
rm -rf config data plugins extensions
mkdir -p config data plugins extensions/emmalike

docker run --rm --entrypoint cat "$ST_IMAGE" /home/node/app/default/config.yaml > config/config.yaml
node configure-config.mjs config/config.yaml
(cd .. && tar --exclude=./node_modules --exclude=./.git --exclude=./tests -cf - .) | tar -xf - -C extensions/emmalike
# The optional chat-save plugin (saves only the changed messages).
if [ "${INSTALL_SAVE_PLUGIN:-0}" = 1 ]; then
    mkdir -p plugins/tavern-lite-save && cp ../server-chat-save/*.mjs plugins/tavern-lite-save/
fi
# Extensions the shell has to work with: Tavern Helper (frontend cards), a known-good version unless
# TAVERN_HELPER_REF says otherwise (empty skips it), and a fixture shaped like Horae's status bar.
TAVERN_HELPER_REF="${TAVERN_HELPER_REF-4.11.2}"
if [ -n "$TAVERN_HELPER_REF" ]; then
    git clone -q --depth 1 --branch "$TAVERN_HELPER_REF" https://github.com/N0VI028/JS-Slash-Runner extensions/JS-Slash-Runner
fi
if [ "${INSTALL_PANEL_FIXTURE:-1}" = 1 ]; then cp -r fixtures/tl-test-panel extensions/tl-test-panel; fi
node --input-type=module -e 'import fs from "node:fs"; const inventory={extensions:fs.readdirSync("extensions"),serverPlugins:fs.readdirSync("plugins")}; fs.writeFileSync("installation.json",JSON.stringify(inventory,null,2)); console.log(inventory);'

# The default admin needs a password before the server accepts listening without a whitelist.
docker compose run --rm --entrypoint node st recover.js default-user test1234
docker compose up -d
node configure-mock.mjs "http://127.0.0.1:${ST_PORT}" default-user test1234
