import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { DEVICES, LINKS, DEVICE_COLORS } from '../data/networkData';
import { fetchRoute } from '../utils/fetchRoute';
import Legend from './Legend';
import {toGeoJSON} from '../utils/toGeoJSON';
import { createMarker } from '../utils/createMarker';
import { loadDeviceIcons } from '../utils/iconSprite';

export default function NetworkMap() {
  const mapRef              = useRef(null);
  const mapInstanceRef      = useRef(null);
  const markersRef          = useRef([]);

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
    const [devices, links] = await Promise.all([
      fetch('http://localhost:8000/api/devices').then(r => r.json()),
      fetch('http://localhost:8000/api/links').then(r => r.json()),
    ]);
    console.log(`Fetched ${devices.length} devices and ${links.length} links`);


    if (import.meta.env.DEV) {
      window.__map = map;
      window.__linkIds = links.map(l => l.id);
      window.maplibregl = maplibregl
    }


    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false
    });

    map.on('mouseenter', 'devices-circles', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const { name, type } = e.features[0].properties;
      popup
        .setLngLat(e.lngLat)
        .setHTML(`<strong>${name}</strong><br/><span>${type}</span>`)
        .addTo(map);
    });

    map.on('mouseleave', 'devices-circles', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    });
    const pos = Object.fromEntries(
      devices.map(d => [d.id, { lat: d.lat, lng: d.lng }])
    );

    function showMarkers() {
      if (markersRef.current.length === 0) {
        // get visible bounds
        const bounds = map.getBounds();
        const visible = devices.filter(dev =>
          dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
          dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
        );
        visible.forEach(dev => {
          const marker = createMarker(dev);
          markersRef.current.push(marker);
          marker.addTo(map);
          // drag events here
        });
      } else {
        markersRef.current.forEach(m => m.addTo(map));
      }
      map.setLayoutProperty('devices-circles', 'visibility', 'none');
    }

    function hideMarkers() {
      markersRef.current.forEach(m => m.remove());
      map.setLayoutProperty('devices-circles', 'visibility', 'visible');
    }
    async function rerouteFor(deviceId) {
      const affected = links.filter(l => l.from === deviceId || l.to === deviceId);
      await Promise.all(affected.map(async link => {
        const coords = await fetchRoute(pos[link.from], pos[link.to]);
        map.getSource(link.id).setData(toGeoJSON(coords));
        map.getSource('devices').setData({
          type: 'FeatureCollection',
          features: devices.map(dev => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pos[dev.id].lng, pos[dev.id].lat] },
            properties: { id: dev.id, type: dev.type, name: dev.name }
          }))
        });
      }));
    }

    // single source for all links
    map.addSource('links', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [] // populated after routes are fetched
      }
    });

    // one layer per link type
    ['fiber', 'copper', 'wireless'].forEach(type => {
      const paint = {
        'line-color': type === 'fiber' ? '#22d3ee' : type === 'copper' ? '#f59e0b' : '#22c55e',
        'line-width': 3,
      };
      if (type === 'copper') paint['line-dasharray'] = [6, 4];
      if (type === 'wireless') paint['line-dasharray'] = [3, 6];

      map.addLayer({
        id: `links-${type}`,
        type: 'line',
        source: 'links',
        filter: ['==', ['get', 'type'], type],
        paint
      });
    });
    await loadDeviceIcons(map);
    map.addSource('devices', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: devices.map(dev => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [dev.lng, dev.lat] },
        properties: { id: dev.id, type: dev.type, name: dev.name }
      }))
    }
      
  
    });

    map.addLayer({
      id: 'devices-circles',
      type: 'circle',
      source: 'devices',
      paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'type'],
              'core-router', DEVICE_COLORS['core-router'],
              'router',      DEVICE_COLORS['router'],
              'switch',      DEVICE_COLORS['switch'],
              'edge-router', DEVICE_COLORS['edge-router'],
              'server',      DEVICE_COLORS['server'],
              '#6b7280'
          ],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff'
      }
  });
  hideMarkers();

  function updateLinksSource(updatedLinks) {
  map.getSource('links').setData({
    type: 'FeatureCollection',
    features: updatedLinks.map(link => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: link.coords || [] },
      properties: { id: link.id, from: link.from, to: link.to, type: link.type }
    }))
  });
}

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