import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { createMarker } from '../utils/createMarker'; 

export default function NetworkMap() {
  const mapRef                        = useRef(null);
  const mapInstanceRef                = useRef(null);
  const markersRef                    = useRef([]);

  const modifiedRouteIdsRef           = useRef(new Set());
  const liveRoutesRef                 = useRef({ type: 'FeatureCollection', features: [] });
  const focusedDeviceIdRef            = useRef(null);
  const mainDevicesRef                = useRef([]); 

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

      const toGeoJSONFeature = (device) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [device.lng, device.lat] },
        properties: { ...device }
      });

      const [devices, links, dbRoutes] = await Promise.all([
        fetch('http://localhost:8000/api/devices').then(r => r.json()),
        fetch('http://localhost:8000/api/links').then(r => r.json()),
        fetch('http://localhost:8000/api/routes/geojson').then(r => r.json()).catch(() => null)
      ]);

      // --- 1. STRICT STRING TOPOLOGY DICTIONARIES ---
      const devMap = {};
      const linksByDevice = {};
      
      devices.forEach(d => {
        const strId = String(d.id);
        devMap[strId] = d;
        linksByDevice[strId] = [];
      });

      links.forEach(l => {
        const fromId = String(l.from);
        const toId = String(l.to);
        if (!linksByDevice[fromId]) linksByDevice[fromId] = [];
        if (!linksByDevice[toId]) linksByDevice[toId] = [];
        linksByDevice[fromId].push(l);
        linksByDevice[toId].push(l);
      });

      const mainTypes = ['core router', 'edge router', 'olt'];
      const accessDevices = [];
      mainDevicesRef.current = []; 
      
      devices.forEach(d => {
        const normalizedType = (d.type || '').toLowerCase().trim();
        if (mainTypes.includes(normalizedType)) mainDevicesRef.current.push(d);
        else accessDevices.push(d);
      });

      map.addSource('devices', {
        type: 'geojson',
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 50,
        data: { type: 'FeatureCollection', features: accessDevices.map(toGeoJSONFeature) } 
      });

      map.addSource('main-devices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: mainDevicesRef.current.map(toGeoJSONFeature) }
      });

      map.addLayer({
        id: 'unclustered-main-devices',
        type: 'circle',
        source: 'main-devices',
        maxzoom: 12,
        paint: {
          'circle-color': ['match', ['get', 'type'], 'Core Router', '#ef4444', 'Edge Router', '#8b5cf6', 'OLT', '#14b8a6', '#eab308'],
          'circle-radius': 8,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      
      const addRouteLayers = (sourceId, prefix, sourceLayer = null) => {
          const layerId = `${prefix}-generic`;
          const layerConfig = {
            id: layerId, type: 'line', source: sourceId, paint: { 'line-color': '#94a3b8', 'line-width': 4 }
          };
          if (sourceLayer) layerConfig['source-layer'] = sourceLayer;

          map.addLayer(layerConfig);

          map.on('mouseenter', layerId, (e) => {
            map.getCanvas().style.cursor = 'pointer';
            if (e.features.length > 0) {
              const props = e.features[0].properties;
              popup.setLngLat(e.lngLat).setHTML(
                  `<div style="padding: 4px;">
                    <strong>Link Data</strong><br/>
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
      };
      
      if (!map.getSource('links-vector')) {
          map.addSource('links-vector', {
              type: 'vector',
              url: `pmtiles://${window.location.origin}/dummy-network.pmtiles` 
          });
      }
      
      if (!map.getSource('live-routes')) {
          map.addSource('live-routes', {
              type: 'geojson',
              data: liveRoutesRef.current
          });
      }

      // Check your PMTiles file to ensure 'networklinks' is the correct layer name!
      addRouteLayers('links-vector', 'links', 'networklinks');
      map.setFilter('links-generic', ['==', 'HIDDEN', 'DEFAULT']); 
      addRouteLayers('live-routes', 'live');

      // --- CLUSTER RENDERING ---
      map.addLayer({
        id: 'clusters-outer', type: 'circle', source: 'devices', filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], 'rgba(34, 197, 94, 0.15)', 100, 'rgba(245, 158, 11, 0.15)', 1000, 'rgba(239, 68, 68, 0.15)'],
          'circle-radius': ['step', ['get', 'point_count'], 12, 100, 15, 1000, 18],
          'circle-stroke-width': 1,
          'circle-stroke-color': ['step', ['get', 'point_count'], 'rgba(34, 197, 94, 0.4)', 100, 'rgba(245, 158, 11, 0.4)', 1000, 'rgba(239, 68, 68, 0.4)']
        }
      });
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'devices', filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], '#22c55e', 100, '#f59e0b', 1000, '#ef4444'],
          'circle-radius': ['step', ['get', 'point_count'], 9, 100, 12, 1000, 15],
          'circle-stroke-width': 0
        }
      });
      map.addLayer({
        id: 'cluster-count', type: 'symbol', source: 'devices', filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
        paint: { 'text-color': '#ffffff' }
      });

      const updateClusterSource = () => {
        const source = map.getSource('devices');
        if (source) source.setData({ type: 'FeatureCollection', features: accessDevices.map(toGeoJSONFeature) });
      };

      // --- 2. SAFE UPDATE FUNCTION ---
      function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
        const safeId = String(linkId);
        const features = liveRoutesRef.current.features.filter(f => String(f.properties.id) !== safeId);
        features.push({
          type: 'Feature',
          properties: { id: safeId, type: linkType, ...props },
          geometry: { type: 'LineString', coordinates }
        });
        liveRoutesRef.current.features = features;
        map.getSource('live-routes').setData(liveRoutesRef.current);
        modifiedRouteIdsRef.current.add(safeId);
      }

      function refreshFilters() {
        const focusId = focusedDeviceIdRef.current;
        
        // Pass both strings and numbers to MapLibre to avoid type comparison failures inside the WebGL shader
        const strIds = Array.from(modifiedRouteIdsRef.current).map(String);
        const numIds = Array.from(modifiedRouteIdsRef.current).map(Number).filter(n => !isNaN(n));
        const modifiedIdsArray = [...strIds, ...numIds]; 

        let filterExpression;

        if (focusId) {
          const focusStr = String(focusId);
          const focusNum = Number(focusId);
          const focusCheck = [
            'any', 
            ['==', ['get', 'from'], focusStr],
            ['==', ['get', 'from'], focusNum],
            ['==', ['get', 'to'], focusStr],
            ['==', ['get', 'to'], focusNum]
          ];

          filterExpression = modifiedIdsArray.length > 0 
            ? ['all', ['!', ['in', ['get', 'id'], ['literal', modifiedIdsArray]]], focusCheck]
            : focusCheck;
        } else {
          filterExpression = modifiedIdsArray.length > 0 
            ? ['!', ['in', ['get', 'id'], ['literal', modifiedIdsArray]]] 
            : null;
        }

        if (map.getLayer('links-generic')) map.setFilter('links-generic', filterExpression);
      }

      function showMarkers() {
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        const bounds = map.getBounds();
        const focusId = focusedDeviceIdRef.current;
        let devicesToRender = [];

        if (focusId) {
          const connectedLinks = linksByDevice[String(focusId)] || [];
          const neighborIds = connectedLinks.map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from));
          devicesToRender = devices.filter(d => String(d.id) === String(focusId) || neighborIds.includes(String(d.id)));
        } else {
          devicesToRender = devices.filter(dev =>
            dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
            dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
          );
        }

        ['links', 'live'].forEach(prefix => {
          if (map.getLayer(`${prefix}-generic`)) map.setLayoutProperty(`${prefix}-generic`, 'visibility', 'visible');
        });

        refreshFilters();

        devicesToRender.forEach(dev => {
          const marker = createMarker(dev);
          markersRef.current.push(marker);
          marker.addTo(map);

          marker.getElement().addEventListener('click', (e) => {
            e.stopPropagation();
            focusedDeviceIdRef.current = dev.id;
            showMarkers(); 
          });

          // --- 3. BULLETPROOF DRAG LOGIC ---
          marker.on('dragstart', () => {
             const affected = linksByDevice[String(dev.id)] || [];
             affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
             refreshFilters();
          });

          marker.on('drag', () => {
            const coords = marker.getLngLat();
            dev.lng = coords.lng;
            dev.lat = coords.lat;

            const affected = linksByDevice[String(dev.id)] || [];
            affected.forEach(link => {
              const isFrom = String(link.from) === String(dev.id);
              const otherDevId = isFrom ? String(link.to) : String(link.from);
              const otherDev = devMap[otherDevId];

              if (otherDev) {
                const lineCoords = isFrom 
                  ? [[coords.lng, coords.lat], [otherDev.lng, otherDev.lat]]
                  : [[otherDev.lng, otherDev.lat], [coords.lng, coords.lat]];
                
                updateLiveRouteInMap(link.id, 'generic', lineCoords, { from: link.from, to: link.to });
              }
            });
          });

          marker.on('dragend', async () => {
            const coords = marker.getLngLat();
            dev.lng = coords.lng;
            dev.lat = coords.lat;

            const affected = linksByDevice[String(dev.id)] || [];

            await Promise.all(affected.map(async link => {
              const from = devMap[String(link.from)];
              const to = devMap[String(link.to)];
              
              if (!from || !to) return; // Prevent crashes if graph is malformed
              
              try {
                const response = await fetch('http://localhost:8000/api/route', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    a: { lat: from.lat, lng: from.lng },
                    b: { lat: to.lat, lng: to.lng },
                    link_id: `${link.from}-${link.to}`,
                    link_type: 'generic'
                  })
                });

                if (!response.ok) throw new Error(`Backend returned status ${response.status}`);
                const osrmCoords = await response.json();
                const geoJsonCoords = osrmCoords.map(([lat, lng]) => [lng, lat]);
                updateLiveRouteInMap(link.id, 'generic', geoJsonCoords, { from: link.from, to: link.to });
                
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

        ['links', 'live'].forEach(prefix => {
          if (map.getLayer(`${prefix}-generic`)) map.setLayoutProperty(`${prefix}-generic`, 'visibility', 'none');
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
        focusedDeviceIdRef.current = null;
        if (map.getZoom() >= 12) {
          showMarkers(); 
        } else {
          ['links', 'live'].forEach(prefix => {
            if (map.getLayer(`${prefix}-generic`)) map.setFilter(`${prefix}-generic`, ['==', 'HIDDEN', 'DEFAULT']);
          });
        }
      });

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
    </div>
  )
}