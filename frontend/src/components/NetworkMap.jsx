import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { fetchRoute } from '../utils/fetchRoute';
import Legend from './Legend';
import {toGeoJSON} from '../utils/toGeoJSON';
import { createMarker } from '../utils/createMarker';
import { DEVICE_COLORS } from '../data/networkData';


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
    // console.log(`Fetched ${devices.length} devices and ${links.length} links`);


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
    const linkCoords = {};
    links.forEach(link => { linkCoords[link.id] = []; });

    function showMarkers() {
      // always clear and recreate based on current bounds
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];

      const bounds = map.getBounds();
      const visible = devices.filter(dev =>
        dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
        dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
      );

      visible.forEach(dev => {
        const marker = createMarker(dev);
        markersRef.current.push(marker);
        marker.addTo(map);

        marker.on('drag', () => {
          const lnglat = marker.getLngLat();
          pos[dev.id] = { lat: lnglat.lat, lng: lnglat.lng };
          links.filter(l => l.from === dev.id || l.to === dev.id).forEach(link => {
            linkCoords[link.id] = [
              [pos[link.from].lng, pos[link.from].lat],
              [pos[link.to].lng,   pos[link.to].lat],
            ];
          });
          updateLinksSource();
        });

        marker.on('dragend', () => rerouteFor(dev.id));
      });

      map.setLayoutProperty('clusters', 'visibility', 'none');
      map.setLayoutProperty('cluster-count', 'visibility', 'none');
      map.setLayoutProperty('devices-circles', 'visibility', 'none');
      map.setLayoutProperty('clusters-outer', 'visibility', 'none');
    }

    function hideMarkers() {
        markersRef.current.forEach(m => m.remove());
        map.setLayoutProperty('clusters', 'visibility', 'visible');
        map.setLayoutProperty('cluster-count', 'visibility', 'visible');
        map.setLayoutProperty('devices-circles', 'visibility', 'visible');
        map.setLayoutProperty('clusters-outer', 'visibility', 'visible');
    }


    async function rerouteFor(deviceId) {
        const affected = links.filter(l => l.from === deviceId || l.to === deviceId);
        await Promise.all(affected.map(async link => {
            const coords = await fetchRoute(pos[link.from], pos[link.to]);
            linkCoords[link.id] = coords.map(([lat, lng]) => [lng, lat]);
        }));
        updateLinksSource();
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

    // source with clustering enabled
    map.addSource('devices', {
      type: 'geojson',
      cluster: true,
      clusterMaxZoom: 12,
      clusterRadius: 50,
      data: {
        type: 'FeatureCollection',
        features: devices.map(dev => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [dev.lng, dev.lat] },
          properties: { id: dev.id, type: dev.type, name: dev.name }
        }))
      }
    });

    // cluster circles
    // outer ring
    map.addLayer({
      id: 'clusters-outer',
      type: 'circle',
      source: 'devices',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step', ['get', 'point_count'],
          'rgba(34, 197, 94, 0.15)',
          100, 'rgba(245, 158, 11, 0.15)',
          1000, 'rgba(239, 68, 68, 0.15)'
        ],
        'circle-radius': [
          'step', ['get', 'point_count'],
          12, 100, 15, 1000, 18
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': [
          'step', ['get', 'point_count'],
          'rgba(34, 197, 94, 0.4)',
          100, 'rgba(245, 158, 11, 0.4)',
          1000, 'rgba(239, 68, 68, 0.4)'
        ]
      }
    });

    // inner filled circle
    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'devices',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': [
          'step', ['get', 'point_count'],
          '#22c55e',
          100, '#f59e0b',
          1000, '#ef4444'
        ],
        'circle-radius': [
          'step', ['get', 'point_count'],
          9, 100, 12, 1000, 15
        ],
        'circle-stroke-width': 0
      }
    });

    // count label
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'devices',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-size': 11,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true
      },
      paint: { 'text-color': '#ffffff' }
    });
    hideMarkers();

    map.on('zoom', () => {
      map.getZoom() >= 12 ? showMarkers() : hideMarkers();
    });

    map.on('moveend', () => {
      if (map.getZoom() >= 13) showMarkers();
    });

    map.on('click', 'clusters', async (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
      const clusterId = features[0].properties.cluster_id;
      const zoom = await map.getSource('devices').getClusterExpansionZoom(clusterId);
      map.easeTo({ center: features[0].geometry.coordinates, zoom });
    });

    map.on('mouseenter', 'clusters-outer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'clusters-outer', () => { map.getCanvas().style.cursor = ''; });


    function updateLinksSource() {
        map.getSource('links').setData({
            type: 'FeatureCollection',
            features: links.map(link => ({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: linkCoords[link.id] || [] },
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