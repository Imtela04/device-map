import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { DEVICES, LINKS } from '../data/networkData';
import { fetchRoute } from '../utils/fetchRoute';
import Legend from './Legend';

// Fix Leaflet's default icon path issue in bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const nodeIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #888;cursor:grab;box-sizing:border-box;"></div>`,
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export default function NetworkMap() {
  const mapRef = useRef(null);       // holds the DOM div
  const mapInstanceRef = useRef(null); // holds the Leaflet map instance

  useEffect(() => {
    // ── Guard: only initialize once ──────────────────────────────
    if (mapInstanceRef.current) return;

    // ── 1. Create map ─────────────────────────────────────────────
    const map = L.map(mapRef.current).fitBounds(
      DEVICES.map(d => [d.lat, d.lng])
    );
    mapInstanceRef.current = map;

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    // ── 2. Mutable positions (updated on drag) ────────────────────
    const pos = Object.fromEntries(
      DEVICES.map(d => [d.id, { lat: d.lat, lng: d.lng }])
    );

    // ── 3. Create polylines ───────────────────────────────────────
    const lines = {};
    LINKS.forEach(link => {
      const dash =
        link.type === 'copper'   ? '6 4'  :
        link.type === 'wireless' ? '3 6'  : null;

      lines[link.id] = L.polyline([], {
        color: link.color,
        weight: 3,
        dashArray: dash,
      })
        .addTo(map)
        .bindTooltip(`${link.from} → ${link.to} (${link.type})`);
    });

    // ── 4. Re-route affected links after drag ─────────────────────
    async function rerouteFor(deviceId) {
      const affected = LINKS.filter(
        l => l.from === deviceId || l.to === deviceId
      );
      await Promise.all(
        affected.map(async link => {
          const coords = await fetchRoute(pos[link.from], pos[link.to]);
          lines[link.id].setLatLngs(coords);
        })
      );
    }

    // ── 5. Add draggable markers ──────────────────────────────────
    DEVICES.forEach(dev => {
      const marker = L.marker([dev.lat, dev.lng], {
        icon: nodeIcon,
        draggable: true,
      })
        .addTo(map)
        .bindTooltip(dev.name);

      marker.on('drag', e => {
        const { lat, lng } = e.latlng;
        pos[dev.id] = { lat, lng };

        // Instant straight-line feedback while dragging
        LINKS.filter(l => l.from === dev.id || l.to === dev.id).forEach(link => {
          lines[link.id].setLatLngs([
            [pos[link.from].lat, pos[link.from].lng],
            [pos[link.to].lat,   pos[link.to].lng],
          ]);
        });
      });

      marker.on('dragend', () => rerouteFor(dev.id));
    });

    // ── 6. Draw initial routes ────────────────────────────────────
    Promise.all(
      LINKS.map(async link => {
        const coords = await fetchRoute(pos[link.from], pos[link.to]);
        lines[link.id].setLatLngs(coords);
      })
    );

    // ── 7. Cleanup on unmount ─────────────────────────────────────
    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []); // empty dep array = run once on mount

  return (
    <div className='relative'>
        <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
        <Legend/>
    </div>

  )
}