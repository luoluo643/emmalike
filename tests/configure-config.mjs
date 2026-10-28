// Edits a copy of SillyTavern's default config.yaml for the test instance. Usage: node configure-config.mjs <config.yaml>
import fs from 'node:fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n');

function setTop(key, value) {
    const index = lines.findIndex(line => line.startsWith(`${key}:`));
    if (index < 0) throw new Error(`config key not found: ${key}`);
    lines[index] = `${key}: ${value}`;
}

function setNested(section, key, value) {
    const start = lines.findIndex(line => line === `${section}:`);
    if (start < 0) throw new Error(`config section not found: ${section}`);
    for (let i = start + 1; i < lines.length && (lines[i].startsWith(' ') || lines[i] === ''); i++) {
        if (lines[i].trimStart().startsWith(`${key}:`)) {
            lines[i] = `${lines[i].match(/^\s*/)[0]}${key}: ${value}`;
            return;
        }
    }
    throw new Error(`config key not found: ${section}.${key}`);
}

setTop('listen', 'true');
setTop('whitelistMode', 'false');
setTop('enableUserAccounts', 'true');
setNested('browserLaunch', 'enabled', 'false');
// The extension is copied in, not cloned, so the app's git-based auto update would only report failures.
setNested('extensions', 'autoUpdate', 'false');
// Loads the optional tavern-lite server plugin, which the character editor uses for account drafts.
setTop('enableServerPlugins', 'true');
// Like a typical server behind a proxy: chat and settings saves over 256 KB go out gzip-compressed.
if (process.env.TL_REQUEST_COMPRESSION === '1') {
    const start = lines.findIndex(line => line.trim() === 'requestCompression:');
    if (start < 0) throw new Error('config section not found: performance.requestCompression');
    for (let i = start + 1; i < lines.length && /^\s{4}/.test(lines[i]); i++) {
        lines[i] = lines[i].replace(/^(\s+enabled:) false/, '$1 true').replace(/^(\s+maxPayloadSize:) .*/, "$1 '64mb'");
    }
}

fs.writeFileSync(file, lines.join('\n'));
