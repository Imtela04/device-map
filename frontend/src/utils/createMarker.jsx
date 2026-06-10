import maplibregl from 'maplibre-gl';

// SVG paths copied from iconSprite.js — no React/Lucide import needed per marker
const ICON_PATHS = {
  'core-router': `<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>`,
  'router':      `<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>`,
  'switch':      `<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>`,
  'edge-router': `<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>`,
  'server':      `<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  'olt':         `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M2 12h20"/>`,
};

const DEVICE_COLORS = {
  'core-router': '#7c3aed',
  'router':      '#22c55e',
  'switch':      '#10b981',
  'edge-router': '#f97316',
  'server':      '#475569',
  'olt':         '#14b8a6',
};

export function createMarker(dev) {
  const type  = (dev.safeType || dev.type || '').toLowerCase();
  const color = DEVICE_COLORS[type] ?? '#8b5cf6';
  const path  = ICON_PATHS[type]   ?? ICON_PATHS['router'];

  const el = document.createElement('div');
  el.style.cssText =
    `background:${color};border-radius:50%;width:28px;height:28px;` +
    `display:flex;align-items:center;justify-content:center;` +
    `border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);` +
    `cursor:pointer;will-change:transform;`;

  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ` +
    `viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  return new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([dev.lng, dev.lat]);
}