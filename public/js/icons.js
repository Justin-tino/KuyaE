// Inline SVG icon set (24x24, stroke style). No emojis anywhere in the app.

const ICONS = {
  dashboard:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  chart:
    '<path d="M4 20.5h16"/><rect x="6" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="7" width="3" height="10.5" rx="1"/><rect x="15" y="13" width="3" height="4.5" rx="1"/>',
  receipt:
    '<path d="M6 3.5h12v17.5l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5V3.5z"/><path d="M9 8.5h6"/><path d="M9 12h6"/><path d="M9 15.5h3.5"/>',
  cash:
    '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.2 9.5h.01"/><path d="M17.8 14.5h.01"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.8 20c.4-3.2 3-5.5 6.2-5.5s5.8 2.3 6.2 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.8c2.1.5 3.7 2.4 4 5.2"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c.5-3.7 3.5-6.3 7.5-6.3s7 2.6 7.5 6.3"/>',
  userPlus:
    '<circle cx="10" cy="8" r="3.6"/><path d="M3.5 20c.4-3.3 3-5.6 6.5-5.6 1 0 2 .2 2.8.6"/><path d="M17 14v6"/><path d="M14 17h6"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.8"/><path d="M10.3 12.7L20 3"/><path d="M17 6l2.4 2.4"/><path d="M14.6 8.4l2.4 2.4"/>',
  pencil: '<path d="M16.4 3.9a2 2 0 0 1 2.8 2.8L7.5 18.4l-4 1.1 1.1-4z"/><path d="M14.5 5.8l3.7 3.7"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  check: '<path d="M5 13l4.5 4.5L19 7"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7l1.4-2.5h4.2L15.5 7"/><circle cx="12" cy="13.5" r="3.4"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.8" cy="9.8" r="1.6"/><path d="M4.5 17.5l4.3-4.3 3.2 3.2 3.2-3.2 4.3 4.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  logout: '<path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9"/><path d="M15.5 8.5L19 12l-3.5 3.5"/><path d="M19 12H9.5"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  fire: '<path d="M12 2.8s5.5 4.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-1.8.8-3.4 2-4.6 0 1.2.7 2 1.6 2 1.1 0 1.7-1 1.4-2.6-.2-1.4-.5-3.2.5-5z"/>',
  clipboard:
    '<rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5V3.8A1.8 1.8 0 0 1 10.8 2h2.4A1.8 1.8 0 0 1 15 3.8v.7"/><path d="M9 10h6"/><path d="M9 13.5h6"/><path d="M9 17h4"/>',
  shield: '<path d="M12 3l7.5 2.8v6.4c0 4.4-3.1 7.6-7.5 9.2-4.4-1.6-7.5-4.8-7.5-9.2V5.8z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  settings: '<path d="M4 7h9"/><path d="M19 7h1"/><path d="M4 17h3"/><path d="M13 17h7"/><circle cx="16" cy="7" r="2.4"/><circle cx="10" cy="17" r="2.4"/>',
  printer:
    '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M7 14h10v6H7z"/><path d="M16.5 11.5h.01"/>',
  refresh:
    '<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3l2.2 2.1"/><path d="M19.5 4.5V9h-4.5"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3l-2.2-2.1"/><path d="M4.5 19.5V15h4.5"/>',
  download: '<path d="M12 4.5V16"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 16V4.5"/><path d="M7.5 9L12 4.5 16.5 9"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  cart: '<path d="M3 4.5h2.2l2.2 11h10.8l2-8.5H6.1"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="16.5" cy="19.5" r="1.4"/>',
  bowl: '<path d="M4 11.5h16a8 8 0 0 1-16 0z"/><path d="M3 11.5h18"/><path d="M8.2 8c0-1.4 1.7-1.4 1.7-2.8"/><path d="M12.2 8c0-1.4 1.7-1.4 1.7-2.8"/><path d="M16.2 8c0-1.4 1.7-1.4 1.7-2.8"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 8.5l7 7"/><path d="M15.5 8.5l-7 7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  alert: '<path d="M12 4.5L21 19.5H3z"/><path d="M12 10v4.5"/><path d="M12 17h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.3v5.5l-3.6 2v-7.5z"/>',
  chevronLeft: '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  chevronRight: '<path d="M9.5 6.5L15 12l-5.5 5.5"/>',
  chevronDown: '<path d="M6.5 9.5L12 15l5.5-5.5"/>',
  arrowRight: '<path d="M4.5 12h14"/><path d="M12.5 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19.5 12h-14"/><path d="M11.5 6l-6 6 6 6"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  doc: '<path d="M13.5 3.5h-7A1.5 1.5 0 0 0 5 5v14A1.5 1.5 0 0 0 6.5 20.5h11A1.5 1.5 0 0 0 19 19V9z"/><path d="M13.5 3.5V9H19"/><path d="M9 13h6"/><path d="M9 16.5h6"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};

export function icon(name, cls = 'w-6 h-6') {
  const body = ICONS[name] || ICONS.dot;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
