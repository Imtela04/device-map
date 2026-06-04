import { createRoot } from 'react-dom/client';
import DeviceIcon from '../components/DeviceIcon';
import maplibregl from 'maplibre-gl';

export function createMarker(dev, map) {
    const el = document.createElement('div');
    const root = createRoot(el);
    
    root.render(<DeviceIcon type={dev.safeType || dev.type} />);

    const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([dev.lng, dev.lat]);

    const popup = new maplibregl.Popup({ closeButton: false, offset: 28 })
        .setHTML(`<div style="padding:2px 6px"><strong style="font-size:12px">${dev.name}</strong><br/><span style="font-size:11px;color:#64748b">${dev.type}</span></div>`);

    el.addEventListener('mouseenter', () => popup.setLngLat(marker.getLngLat()).addTo(map));
    el.addEventListener('mouseleave', () => popup.remove());

    return marker;
}