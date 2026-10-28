// This extension's folder under scripts/extensions/: the name of the repository it was installed from.
export const OWN_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).pop());
