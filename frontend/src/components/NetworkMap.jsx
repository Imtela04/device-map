import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import Legend from './Legend';
import { createMarker } from '../utils/createMarker'; 

export default function NetworkMap() {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    if (mapInstanceRef.current) return;

    let protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=B2aWdlpiBBhi0n5jeueG`,
      center: [90.4193, 23.7269], 
      zoom: 11
    });

    mapInstanceRef.current = map;

    map.on('load', async () => {
      const devices = await fetch('http://localhost:8000/api/devices').then(r => r.json());

      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false
      });

    // 1. ADD PMTILES ROUTES SOURCE
      map.addSource('links-vector', {
        type: 'vector',
        // Bump to v=4 to bust the cache one last time
        url: `pmtiles://${window.location.origin}/dummy-network.pmtiles?v=4` 
      });

      // 2. ADD ROUTE LAYERS (HIDDEN BY DEFAULT)
      ['fiber', 'copper', 'wireless'].forEach(type => {
        const layerId = `links-${type}`;
        const paint = {
          'line-color': type === 'fiber' ? '#22d3ee' : type === 'copper' ? '#f59e0b' : '#22c55e',
          'line-width': 4,
        };
        if (type === 'copper') paint['line-dasharray'] = [6, 4];
        if (type === 'wireless') paint['line-dasharray'] = [3, 6];

        map.addLayer({
          id: layerId,
          type: 'line',
          source: 'links-vector',
          // CHANGE THIS LINE: MapLibre now knows exactly what layer to look for
          'source-layer': 'networklinks', 
          filter: ['==', ['get', 'type'], 'HIDDEN_DEFAULT'],
          paint
        });
        
    
        // Hover events for active routes
        map.on('mouseenter', layerId, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          if (e.features.length > 0) {
            const props = e.features[0].properties;
            popup.setLngLat(e.lngLat).setHTML(
                `<div style="padding: 4px;">
                  <strong>${props.type ? props.type.toUpperCase() : 'UNKNOWN'} Link</strong><br/>
                  <span style="font-size: 0.9em; color: #555;">From: ${props.fromName}</span><br/>
                  <span style="font-size: 0.9em; color: #555;">To: ${props.toName}</span>
                </div>`
            ).addTo(map);
          }
        });
        map.on('mouseleave', layerId, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
      });

      // Update cluster source function
      const updateClusterSource = () => {
        const source = map.getSource('devices');
        if (source) {
          source.setData({
            type: 'FeatureCollection',
            features: devices.map(dev => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [dev.lng, dev.lat] },
              properties: { id: dev.id, type: dev.type, name: dev.name }
            }))
          });
        }
      };

      // 3. ADD DEVICE SOURCE
      map.addSource('devices', {
        type: 'geojson',
        cluster: true,
        clusterMaxZoom: 12, 
        clusterRadius: 50,
        data: { type: 'FeatureCollection', features: [] } 
      });
      
      updateClusterSource();

      // 4. CLUSTER LAYERS
      map.addLayer({
        id: 'clusters-outer',
        type: 'circle',
        source: 'devices',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], 'rgba(34, 197, 94, 0.15)', 100, 'rgba(245, 158, 11, 0.15)', 1000, 'rgba(239, 68, 68, 0.15)'],
          'circle-radius': ['step', ['get', 'point_count'], 12, 100, 15, 1000, 18],
          'circle-stroke-width': 1,
          'circle-stroke-color': ['step', ['get', 'point_count'], 'rgba(34, 197, 94, 0.4)', 100, 'rgba(245, 158, 11, 0.4)', 1000, 'rgba(239, 68, 68, 0.4)']
        }
      });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'devices',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#22c55e', 100, '#f59e0b', 1000, '#ef4444'],
          'circle-radius': ['step', ['get', 'point_count'], 9, 100, 12, 1000, 15],
          'circle-stroke-width': 0
        }
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'devices',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-size': 11,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: { 'text-color': '#ffffff' }
      });


      // --- CUSTOM MARKERS & LOGIC ---
      function showMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        const bounds = map.getBounds();
        const visible = devices.filter(dev =>
          dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
          dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
        );

        const visibleIdStrings = visible.map(dev => String(dev.id));
        const visibleIdNumbers = visible.map(dev => Number(dev.id));

        ['fiber', 'copper', 'wireless'].forEach(type => {
          const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
          if (map.getLayer(`links-${type}`)) {
            map.setFilter(`links-${type}`, [
              'all', 
              ['any', ['==', ['get', 'type'], type], ['==', ['get', 'type'], typeCap]],
              ['any', 
                ['in', ['get', 'from'], ['literal', visibleIdStrings]],
                ['in', ['get', 'from'], ['literal', visibleIdNumbers]],
                ['in', ['get', 'to'], ['literal', visibleIdStrings]],
                ['in', ['get', 'to'], ['literal', visibleIdNumbers]]
              ]
            ]);
          }
        });

        visible.forEach(dev => {
          const marker = createMarker(dev);
          markersRef.current.push(marker);
          marker.addTo(map);

          marker.on('dragend', () => {
             const newCoords = marker.getLngLat();
             dev.lng = newCoords.lng;
             dev.lat = newCoords.lat;
             updateClusterSource();
          });
        });

        map.setLayoutProperty('clusters', 'visibility', 'none');
        map.setLayoutProperty('cluster-count', 'visibility', 'none');
        map.setLayoutProperty('clusters-outer', 'visibility', 'none');
      }
      function hideMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];
        
        map.setLayoutProperty('clusters', 'visibility', 'visible');
        map.setLayoutProperty('cluster-count', 'visibility', 'visible');
        map.setLayoutProperty('clusters-outer', 'visibility', 'visible');
      }

      hideMarkers();

      map.on('zoom', () => { map.getZoom() >= 12 ? showMarkers() : hideMarkers(); });
      map.on('moveend', () => { if (map.getZoom() >= 12) showMarkers(); });


      // Map Background Click (Hide routes)
      map.on('click', (e) => {
        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        ['fiber', 'copper', 'wireless'].forEach(type => {
            if (map.getLayer(`links-${type}`)) {
                map.setFilter(`links-${type}`, ['==', ['get', 'type'], 'HIDDEN_DEFAULT']);
            }
        });
      });

      // Cluster clicks
      map.on('click', 'clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        const clusterId = features[0].properties.cluster_id;
        const zoom = await map.getSource('devices').getClusterExpansionZoom(clusterId);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });

      map.on('mouseenter', 'clusters-outer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'clusters-outer', () => { map.getCanvas().style.cursor = ''; });

    });  

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      maplibregl.removeProtocol('pmtiles'); 
    }
  }, []);

  return (
    <div className='relative'>
        <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
        <Legend/>
    </div>
  )
}