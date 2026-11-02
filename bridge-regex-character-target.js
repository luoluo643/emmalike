// A regex management target is independent of the open chat. All operations are called inside the bridge queue.
export function createRegexCharacterTarget({ current, characters, readCard, writeScripts, assertSession }) {
    let selected = null, card = null, baseline = '';
    const scripts = value => Array.isArray(value?.data?.extensions?.regex_scripts) ? value.data.extensions.regex_scripts : [];
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const stamp = value => JSON.stringify(canonical(scripts(value)));
    const error = (code, message) => Object.assign(new Error(message), { code });
    const indexOf = avatar => characters().findIndex(c => c.avatar === avatar);
    const foreign = () => selected !== null && (current().group || current().character?.avatar !== selected);
    const character = () => selected === null ? current() : { character: card, group: false };
    const read = async avatar => {
        assertSession();
        if (indexOf(avatar) < 0) throw error('REGEX_MISSING', '这个角色已经不在了，请重新选择');
        const fresh = await readCard(avatar);
        assertSession();
        return { ...fresh, avatar };
    };
    return {
        foreign, character,
        list() {
            assertSession();
            return characters().filter(c => c?.avatar).map(c => ({ avatar: c.avatar, name: c.name || '没有名字', current: !current().group && current().character?.avatar === c.avatar }));
        },
        async select(avatar) {
            if (avatar === null) { assertSession(); selected = null; card = null; baseline = ''; return; }
            const fresh = await read(avatar);
            selected = avatar; card = fresh; baseline = stamp(fresh);
        },
        scripts: () => scripts(card),
        async beforeWrite(groups) {
            if (!foreign() || !groups.includes('scoped')) return;
            const fresh = await read(selected);
            if (stamp(fresh) !== baseline) {
                card = fresh; baseline = stamp(fresh);
                throw error('REGEX_CHARACTER_CHANGED', '这个角色的正则在别处改过了，已重新加载，请看过再操作');
            }
        },
        async save(list) {
            const avatar = selected;
            if (!avatar || !foreign()) throw error('REGEX_OWNER_CHANGED', '角色换了，请重新打开后再存');
            const index = indexOf(avatar);
            if (index < 0) throw error('REGEX_MISSING', '这个角色已经不在了，请重新选择');
            const expected = JSON.stringify(canonical(list));
            await writeScripts(index, structuredClone(list));
            const fresh = await read(avatar);
            if (stamp(fresh) !== expected) throw error('REGEX_NOT_SAVED', '没有保存成功，改动还在，请稍后重试');
            card = fresh; baseline = stamp(fresh);
        },
        async saved() { const c = character(); return c.character && !c.group ? scripts(await read(c.character.avatar)) : null; },
    };
}
