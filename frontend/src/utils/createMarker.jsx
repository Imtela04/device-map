import { createRoot } from 'react-dom/client';
import DeviceIcon from '../components/DeviceIcon';
import maplibregl from 'maplibre-gl';

export function createMarker(dev, map) {
    const el = document.createElement('div');
    const root = createRoot(el);
    
    root.render(<DeviceIcon type={dev.safeType || dev.type} />);

    const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([dev.lng, dev.lat]);

    return marker;
}