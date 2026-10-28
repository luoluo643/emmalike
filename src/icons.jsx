// Line icons drawn with currentColor, so they follow every theme. Buttons that use them carry an aria-label.
const PATHS = {
    back: 'M15 5l-7 7 7 7',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    plus: 'M12 5v14M5 12h14',
    send: 'M12 19V6M6 11l6-6 6 6',
    stop: 'M8 8h8v8H8z',
    chevronDown: 'M7 10l5 5 5-5',
    left: 'M14 6l-6 6 6 6',
    right: 'M10 6l6 6-6 6',
    pen: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    regen: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
    toc: 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11',
    branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
};

export function Icon({ name, size = 22 }) {
    const round = name === 'more';
    return (
        <svg class="tl-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
            fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={round ? 3.2 : 1.9}
            stroke-linecap="round" stroke-linejoin="round">
            <path d={PATHS[name]} />
        </svg>
    );
}
