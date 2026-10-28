// Which of the full app's quick buttons (Quick Replies, Tavern Helper script buttons) the reader leaves out of the
// row above the input. Chosen per account and kept in the account's settings (tavernLite.hiddenInputButtons), so
// every device of the account shows the same row. Buttons are named by their label: the full app gives them no
// stable id, and a renamed button shows again.

export function hiddenInputButtons(bridge) {
    const list = bridge?.extensionSettings?.()?.tavernLite?.hiddenInputButtons;
    return Array.isArray(list) ? list.filter(label => typeof label === 'string') : [];
}

export function setInputButtonHidden(bridge, label, hidden) {
    const settings = bridge?.extensionSettings?.();
    if (!settings || typeof label !== 'string' || !label) return false;
    const current = new Set(hiddenInputButtons(bridge));
    if (hidden) current.add(label); else current.delete(label);
    settings.tavernLite = { ...(settings.tavernLite ?? {}), hiddenInputButtons: [...current] };
    bridge.saveSettings?.();
    return true;
}
