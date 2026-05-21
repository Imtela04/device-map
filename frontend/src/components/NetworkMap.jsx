import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { DEVICES, LINKS } from '../data/networkData';
import { fetchRoute } from '../utils/fetchRoute';
import Legend from './Legend';
import {toGeoJSON} from '../utils/toGeoJSON';
import { createMarker } from '../utils/createMarker';

export default function NetworkMap() {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);

  useEffect(() => {
    if (mapInstanceRef.current) return;
    
    const map = new maplibregl.Map({
        container: mapRef.current,
        style: `https://api.maptiler.com/maps/streets/style.json?key=B2aWdlpiBBhi0n5jeueG`,
        center: [90.4193, 23.7269], // Dhaka, Bangladesh
        zoom: 11
    });

    mapInstanceRef.current = map;

    map.on('load', async () => {
      const pos = Object.fromEntries(
        DEVICES.map(d => [d.id, { lat: d.lat, lng: d.lng }])
      );

      async function rerouteFor(deviceId) {
        const affected = LINKS.filter(l => l.from === deviceId || l.to === deviceId);
        await Promise.all(affected.map(async link => {
            const coords = await fetchRoute(pos[link.from], pos[link.to]);
            map.getSource(link.id).setData(toGeoJSON(coords));
        }));
      }

      DEVICES.forEach(dev => {
        const marker = createMarker(dev).addTo(map)

        marker.on('drag', async () => {
          const lnglat = marker.getLngLat();
          pos[dev.id] = { lat: lnglat.lat, lng: lnglat.lng };

          LINKS.filter(l => l.from === dev.id || l.to === dev.id).forEach(link => {
            map.getSource(link.id).setData(toGeoJSON([
              [pos[link.from].lat, pos[link.from].lng],
              [pos[link.to].lat,   pos[link.to].lng],
            ]));
          });
        });

        marker.on('dragend', () => rerouteFor(dev.id));
      });

      LINKS.forEach(link => {
        map.addSource(link.id, {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
        });

        const paint = {
          'line-color': link.color,
          'line-width': 3,
        };
        if (link.type === 'copper') paint['line-dasharray'] = [6, 4];
        if (link.type === 'wireless') paint['line-dasharray'] = [3, 6];

        map.addLayer({
            id: link.id,
            type: 'line',
            source: link.id,
            paint
        });

      });

    });    

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    }
        
  }, []);

  return (
    <div className='relative'>
        <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
        <Legend/>
    </div>

  )
}