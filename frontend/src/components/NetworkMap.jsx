import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import Legend from './Legend';
import { createMarker } from '../utils/createMarker'; 

export default function NetworkMap() {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);
  // Keep track of modified route IDs so we can hide them in the static PMTiles layer
  const modifiedRouteIdsRef = useRef(new Set());
  // Keep a running reference of our live GeoJSON features
  const liveRoutesRef = useRef({ type: 'FeatureCollection', features: [] });

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
      const [devices, links, dbRoutes] = await Promise.all([
        fetch('http://localhost:8000/api/devices').then(r => r.json()),
        fetch('http://localhost:8000/api/links').then(r => r.json()),
        fetch('http://localhost:8000/api/routes/geojson').then(r => r.json()).catch(() => null)
      ]);

      const devMap = Object.fromEntries(devices.map(d => [d.id, d]));

      const linksByDevice = {};
      devices.forEach(d => linksByDevice[d.id] = []);
      links.forEach(l => {
        if (!linksByDevice[l.from]) linksByDevice[l.from] = [];
        if (!linksByDevice[l.to]) linksByDevice[l.to] = [];
        linksByDevice[l.from].push(l);
        linksByDevice[l.to].push(l);
      });

      if (dbRoutes?.features?.length > 0) {
        liveRoutesRef.current = dbRoutes;
        dbRoutes.features.forEach(f => modifiedRouteIdsRef.current.add(f.properties.id));
      }

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

      map.addSource('links-vector', {
        type: 'vector',
        url: `pmtiles://${window.location.origin}/dummy-network.pmtiles?v=4` 
      });

      map.addSource('live-routes', { 
        type: 'geojson', 
        data: liveRoutesRef.current 
      });

      map.addSource('devices', {
        type: 'geojson',
        cluster: true,
        clusterMaxZoom: 12, 
        clusterRadius: 50,
        data: { type: 'FeatureCollection', features: [] } 
      });

      const addRouteLayers = (sourceId, prefix, sourceLayer = null) => {
        ['fiber', 'copper', 'wireless'].forEach(type => {
          const layerId = `${prefix}-${type}`;
          const paint = {
            'line-color': type === 'fiber' ? '#22d3ee' : type === 'copper' ? '#f59e0b' : '#22c55e',
            'line-width': 4,
          };
          if (type === 'copper') paint['line-dasharray'] = [6, 4];
          if (type === 'wireless') paint['line-dasharray'] = [3, 6];

          const layerConfig = {
            id: layerId,
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'type'], type], 
            paint
          };
          if (sourceLayer) layerConfig['source-layer'] = sourceLayer;

          map.addLayer(layerConfig);

          map.on('mouseenter', layerId, (e) => {
            map.getCanvas().style.cursor = 'pointer';
            if (e.features.length > 0) {
              const props = e.features[0].properties;
              popup.setLngLat(e.lngLat).setHTML(
                  `<div style="padding: 4px;">
                    <strong>${props.type ? props.type.toUpperCase() : 'UNKNOWN'} Link</strong><br/>
                    <span style="font-size: 0.9em; color: #555;">From: ${props.fromName || props.from}</span><br/>
                    <span style="font-size: 0.9em; color: #555;">To: ${props.toName || props.to}</span>
                  </div>`
              ).addTo(map);
            }
          });
          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
          });
        });
      };

      addRouteLayers('links-vector', 'links', 'networklinks');
      ['fiber', 'copper', 'wireless'].forEach(type => map.setFilter(`links-${type}`, ['==', ['get', 'type'], 'HIDDEN_DEFAULT']));
      addRouteLayers('live-routes', 'live');

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
      updateClusterSource();

      function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
        const features = liveRoutesRef.current.features.filter(f => f.properties.id !== linkId);
        features.push({
          type: 'Feature',
          properties: { id: linkId, type: linkType, ...props },
          geometry: { type: 'LineString', coordinates }
        });
        liveRoutesRef.current.features = features;
        map.getSource('live-routes').setData(liveRoutesRef.current);
        modifiedRouteIdsRef.current.add(linkId);
      }

      // --- NEW: EXTRACTED FILTER LOGIC ---
      function refreshFilters() {
        const bounds = map.getBounds();
        const visible = devices.filter(dev =>
          dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
          dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
        );

        const visibleIdStrings = visible.map(dev => String(dev.id));
        const visibleIdNumbers = visible.map(dev => Number(dev.id));
        const modifiedIdsArray = Array.from(modifiedRouteIdsRef.current);

        ['fiber', 'copper', 'wireless'].forEach(type => {
          const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
          if (map.getLayer(`links-${type}`)) {
            map.setFilter(`links-${type}`, [
              'all', 
              ['any', ['==', ['get', 'type'], type], ['==', ['get', 'type'], typeCap]],
              ['!', ['in', ['get', 'id'], ['literal', modifiedIdsArray]]],
              ['any', 
                ['in', ['get', 'from'], ['literal', visibleIdStrings]],
                ['in', ['get', 'from'], ['literal', visibleIdNumbers]],
                ['in', ['get', 'to'], ['literal', visibleIdStrings]],
                ['in', ['get', 'to'], ['literal', visibleIdNumbers]]
              ]
            ]);
          }
        });
        return visible;
      }

      function showMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        // Apply filters to figure out what should be drawn
        const visible = refreshFilters();

        //Turn visibility back on for ALL route lines
        ['fiber', 'copper', 'wireless'].forEach(type => {
          if (map.getLayer(`links-${type}`)) {
            map.setLayoutProperty(`links-${type}`, 'visibility', 'visible');
          }
          if (map.getLayer(`live-${type}`)) {
            map.setLayoutProperty(`live-${type}`, 'visibility', 'visible');
          }
        });

        visible.forEach(dev => {
          const marker = createMarker(dev);
          markersRef.current.push(marker);
          marker.addTo(map);

          // WHEN DRAG STARTS: Tell PMTiles to hide this specific route
          marker.on('dragstart', () => {
             const affected = linksByDevice[dev.id] || [];
             affected.forEach(l => modifiedRouteIdsRef.current.add(l.id));
             refreshFilters();
          });

          // WHILE DRAGGING: Update GeoJSON only! (No showMarkers loop)
          marker.on('drag', () => {
            const coords = marker.getLngLat();
            dev.lng = coords.lng;
            dev.lat = coords.lat;

            const affected = linksByDevice[dev.id] || [];
            affected.forEach(link => {
              const isFrom = link.from === dev.id;
              const otherDevId = isFrom ? link.to : link.from;
              const otherDev = devMap[otherDevId];
              
              if (otherDev) {
                const lineCoords = isFrom 
                  ? [[coords.lng, coords.lat], [otherDev.lng, otherDev.lat]]
                  : [[otherDev.lng, otherDev.lat], [coords.lng, coords.lat]];
                
                updateLiveRouteInMap(link.id, link.type, lineCoords, { from: link.from, to: link.to });
              }
            });
          });

          // WHEN DRAG FINISHES: Call Backend
          marker.on('dragend', async () => {
            const coords = marker.getLngLat();
            dev.lng = coords.lng;
            dev.lat = coords.lat;

            const affected = linksByDevice[dev.id] || [];

            await Promise.all(affected.map(async link => {
              const from = devMap[link.from];
              const to = devMap[link.to];
              
              try {
                //console.log(`Fetching real route for ${link.id}...`);
                const response = await fetch('http://localhost:8000/api/route', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    a: { lat: from.lat, lng: from.lng },
                    b: { lat: to.lat, lng: to.lng },
                    link_id: `${link.from}-${link.to}`,
                    link_type: link.type
                  })
                });

                if (!response.ok) throw new Error(`Backend returned status ${response.status}`);

                const osrmCoords = await response.json();
                //console.log("Backend Response:", osrmCoords);
                
                // If it's a straight line, your backend returned [[lat,lng], [lat,lng]]!
                const geoJsonCoords = osrmCoords.map(([lat, lng]) => [lng, lat]);
                updateLiveRouteInMap(link.id, link.type, geoJsonCoords, { from: link.from, to: link.to });
                
              } catch (err) {
                console.error(`OSRM Fetch Failed for link ${link.id}:`, err);
              }
            }));

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

        // --- NEW: Hide ALL route lines (Both PMTiles and Live OSRM routes) ---
        ['fiber', 'copper', 'wireless'].forEach(type => {
          if (map.getLayer(`links-${type}`)) {
            map.setLayoutProperty(`links-${type}`, 'visibility', 'none');
          }
          if (map.getLayer(`live-${type}`)) {
            map.setLayoutProperty(`live-${type}`, 'visibility', 'none');
          }
        });

        map.setLayoutProperty('clusters', 'visibility', 'visible');
        map.setLayoutProperty('cluster-count', 'visibility', 'visible');
        map.setLayoutProperty('clusters-outer', 'visibility', 'visible');
      }
      hideMarkers();

      map.on('moveend', () => { if (map.getZoom() >= 12) showMarkers(); });
      map.on('zoomend', () => { map.getZoom() >= 12 ? showMarkers() : hideMarkers(); });

      map.on('click', (e) => {
        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        ['fiber', 'copper', 'wireless'].forEach(type => {
            if (map.getLayer(`links-${type}`)) {
                map.setFilter(`links-${type}`, ['==', ['get', 'type'], 'HIDDEN_DEFAULT']);
            }
        });
      });

      map.on('click', 'clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        const clusterId = features[0].properties.cluster_id;
        const zoom = await map.getSource('devices').getClusterExpansionZoom(clusterId);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });

      map.on('mouseenter', 'clusters-outer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'clusters-outer', () => { map.getCanvas().style.cursor = ''; });

    });    return () => {
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