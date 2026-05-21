import { createRoot } from 'react-dom/client';
import DeviceIcon from '../components/DeviceIcon';
import maplibregl from 'maplibre-gl';

export function createMarker(dev) {
    const el = document.createElement('div');
    const root = createRoot(el);
    root.render(<DeviceIcon type={dev.type} />);
    
    const marker = new maplibregl.Marker({ element:el, draggable: true })
        .setLngLat([dev.lng, dev.lat])
    const popup = new maplibregl.Popup({ closeButton: false })
    .setText(dev.name)
    marker.setPopup(popup)
    return marker;
}