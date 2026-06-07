import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { createMarker } from '../utils/createMarker'; 
import { loadDeviceIcons } from '../utils/iconSprite';

export default function NetworkMap() {
  const mapRef                        = useRef(null);
  const mapInstanceRef                = useRef(null);
  const activeMarkersRef              = useRef(new Map()); 
  const liveRouteUpdateTimeout        = useRef(null);

  const modifiedRouteIdsRef           = useRef(new Set());
  const liveRoutesRef                 = useRef({ type: 'FeatureCollection', features: [] });
  const focusedDeviceIdRef            = useRef(null);
  const fetchedRouteIdsRef            = useRef(new Set());
  const mainDevicesRef                = useRef([]);

  // Helper Set to identify Infrastructure vs Customers
  const INFRA = new Set(['core-router', 'router', 'edge-router', 'olt', 'server', 'switch']);

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

    map.on('styleimagemissing', (e) => {
        map.addImage(e.id, new ImageData(1, 1));
    });

    map.on('load', async () => {

      await loadDeviceIcons(map);

      const toGeoJSONFeature = (device) => {
        let renderType = 'Access';
        const t = (device.type || '').toLowerCase();
        if (t.includes('core')) renderType = 'Core Router';
        else if (t.includes('edge')) renderType = 'Edge Router';
        else if (t.includes('olt')) renderType = 'OLT';

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [device.lng, device.lat] },
          properties: { ...device, renderType, id: String(device.id) } 
        };
      };

      const [apiDevices, links, dbRoutes] = await Promise.all([
        fetch('http://localhost:8000/api/devices').then(r => r.json()),
        fetch('http://localhost:8000/api/links').then(r => r.json()),
        fetch('http://localhost:8000/api/routes/geojson').then(r => r.json()).catch(() => null)
      ]);

      const devices = apiDevices.map(d => {
        const t = (d.type || '').toLowerCase();
        let safeType = 'access';
        if (t.includes('core')) safeType = 'core-router';
        else if (t.includes('edge')) safeType = 'edge-router';
        else if (t.includes('olt')) safeType = 'olt';
        else if (t.includes('server')) safeType = 'server';
        else if (t.includes('switch')) safeType = 'switch';
        else if (t === 'router') safeType = 'router';
        return { ...d, safeType }; 
      });

      if (dbRoutes?.features?.length) {
        liveRoutesRef.current.features = dbRoutes.features.map(f => ({
          type: 'Feature',
          properties: {
            id: String(f.properties.id),
            type: f.properties.type || 'generic',
            from: String(f.properties.from),
            to: String(f.properties.to),
            fromName: f.properties.fromName,
            toName: f.properties.toName,
          },
          geometry: f.geometry,
        }));
        dbRoutes.features.forEach(f => {
          const id = String(f.properties.id);
          fetchedRouteIdsRef.current.add(id);
          modifiedRouteIdsRef.current.add(id); 
        });
      }

      const devMap = {};
      const linkMap = {};
      const linksByDevice = {};
      
      devices.forEach(d => {
        const strId = String(d.id);
        devMap[strId] = d;
        linksByDevice[strId] = [];
      });

      links.forEach(l => {
        linkMap[String(l.id)] = l;
        const fromId = String(l.from);
        const toId = String(l.to);
        if (!linksByDevice[fromId]) linksByDevice[fromId] = [];
        if (!linksByDevice[toId]) linksByDevice[toId] = [];
        linksByDevice[fromId].push(l);
        linksByDevice[toId].push(l);
      });

      const accessDevices = [];
      mainDevicesRef.current = []; 
      
      devices.forEach(d => {
        if (INFRA.has(d.safeType)) {
          mainDevicesRef.current.push(d);
        } else {
          accessDevices.push(d);
        }
      });
      
      map.addSource('devices', {
        type: 'geojson', cluster: true, clusterMaxZoom: 12, clusterRadius: 50,
        data: { type: 'FeatureCollection', features: accessDevices.map(toGeoJSONFeature) } 
      });

      map.addSource('main-devices', {
        type: 'geojson', cluster: true, clusterMaxZoom: 9, clusterRadius: 35,
        data: { type: 'FeatureCollection', features: mainDevicesRef.current.map(toGeoJSONFeature) }
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      
      const addRouteLayers = (sourceId, prefix, sourceLayer = null) => {
        const layerId = `${prefix}-generic`;
        const layerConfig = {
          id: layerId, 
          type: 'line', 
          source: sourceId, 
          minzoom: 11.5, 
          paint: { 'line-color': '#f804bb3f', 'line-width': 4 }
        };
        if (sourceLayer) layerConfig['source-layer'] = sourceLayer;

        map.addLayer(layerConfig);

        map.on('mouseenter', layerId, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          if (e.features.length > 0) {
            const props = e.features[0].properties;
            let fromName = props.fromName;
            let toName = props.toName;
            
            const actualLink = linkMap[String(props.id)];
            if (actualLink) {
              const fDev = devMap[String(actualLink.from)];
              const tDev = devMap[String(actualLink.to)];
              if (fDev) fromName = fDev.name;
              if (tDev) toName = tDev.name;
            }

            fromName = fromName || props.from || (actualLink ? actualLink.from : 'Unknown');
            toName = toName || props.to || (actualLink ? actualLink.to : 'Unknown');

            popup.setLngLat(e.lngLat).setHTML(
              `<div style="padding: 4px;">
                <strong>Link Data</strong><br/>
                <span style="font-size: 0.9em; color: #555;">From: ${fromName}</span><br/>
                <span style="font-size: 0.9em; color: #555;">To: ${toName}</span>
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
          map.addSource('links-vector', { type: 'vector', url: `pmtiles://${window.location.origin}/dummy-network.pmtiles` });
      }
      if (!map.getSource('live-routes')) {
          map.addSource('live-routes', { type: 'geojson', data: liveRoutesRef.current });
      }
      if (!map.getSource('drag-routes')) {
          map.addSource('drag-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({
            id: 'drag-routes-line', type: 'line', source: 'drag-routes',
            paint: { 'line-color': '#f43f5e', 'line-width': 1.5, 'line-opacity': 0.4 } 
          });
      }

      addRouteLayers('links-vector', 'links', 'networklinks');
      addRouteLayers('live-routes', 'live');

      // --- CLUSTER RENDERING ---
      map.addLayer({
        id: 'clusters-outer', type: 'circle', source: 'devices', filter: ['has', 'point_count'],
        paint: {
          'circle-color': ['step', ['get', 'point_count'], 'rgba(85, 74, 82, 0.07)', 100, 'rgba(85, 74, 82, 0.07)', 1000, 'rgba(85, 74, 82, 0.07)'],
          'circle-radius': ['step', ['get', 'point_count'], 12, 100, 15, 1000, 18],
          'circle-stroke-width': 1, 'circle-stroke-color': ['step', ['get', 'point_count'], 'rgba(143, 138, 143, 0.4)', 100, 'rgba(143, 138, 143, 0.4)', 1000, 'rgba(143, 138, 143, 0.4)']
        }
      });
      map.addLayer({
        id: 'clusters', type: 'circle', source: 'devices', filter: ['has', 'point_count'],
        paint: { 'circle-color': ['step', ['get', 'point_count'], '#80607650', 100, '#80607648', 1000, '#80607648'], 'circle-radius': ['step', ['get', 'point_count'], 9, 100, 12, 1000, 15], 'circle-stroke-width': 0 }
      });
      map.addLayer({
        id: 'cluster-count', type: 'symbol', source: 'devices', filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
        paint: { 'text-color': '#ffffff' }
      });

      // --- VISUAL HIERARCHY FOR CUSTOMER DOTS ---
      map.addLayer({
        id: 'unclustered-devices', type: 'circle', source: 'devices', filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#f63bbe', 
          'circle-radius': 4.5,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9
        }
      });
      
      map.on('click', 'unclustered-devices', (e) => {
          // 1. Correctly extract the id from the feature properties
          const featureId = e.features[0].properties.id; 
          
          popup.remove();
          
          // 2. Use the extracted featureId variable
          focusedDeviceIdRef.current = featureId;
          showMarkers(); 
          
          // 3. Find the full device object using devMap
          const dev = devMap[String(featureId)];
          if (dev) showStatsPopup(dev);
      });      

      map.on('click', 'unclustered-main-devices', (e) => {
        const featureId = e.features[0].properties.id;
        const coords = e.features[0].geometry.coordinates.slice();
        const dev = devMap[String(featureId)];

        popup.remove();
        focusedDeviceIdRef.current = featureId;

        // Zoom to the device first — zoomend will call showMarkers() to
        // spawn the HTML marker, then moveend fires after so we show the popup.
        map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 13) });

        map.once('moveend', () => {
          showMarkers();               // ensures marker exists at new zoom
          if (dev) showStatsPopup(dev);
        });
      });
      map.on('mouseenter', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = ''; });
  
      
      map.addLayer({
        id: 'main-clusters', type: 'circle', source: 'main-devices', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#7c3aed', 'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 21], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
      });
      map.addLayer({
        id: 'main-cluster-count', type: 'symbol', source: 'main-devices', filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
        paint: { 'text-color': '#ffffff' },
      });
      
      map.addLayer({
        id: 'unclustered-main-devices', type: 'symbol', source: 'main-devices', filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['get', 'safeType'],
          'icon-size': 1.0, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'text-field': ['get', 'name'], 'text-offset': [0, 1.6], 'text-size': 10, 'text-optional': true, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        },
        paint: { 'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      });

      // --- CENTRALIZED STATS POPUP ---
      function showStatsPopup(dev) {
        let statsHtml = '';
        const connectedLinks = linksByDevice[String(dev.id)] || [];

        if (dev.safeType === 'olt') {
          const customerCount = Math.max(0, connectedLinks.length - 1);
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Downstream ONTs:</span>
              <strong style="color:#10b981;">${customerCount} Units</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Uplink Port:</span>
              <strong style="color:#3b82f6;">10G SFP+</strong>
            </div>`;
        } else if (dev.safeType === 'edge-router') {
          const oltCount = connectedLinks.filter(l => devMap[String(l.to)]?.safeType === 'olt' || devMap[String(l.from)]?.safeType === 'olt').length;
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Subtended OLTs:</span>
              <strong style="color:#2563eb;">${oltCount} Active Hubs</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Core Link:</span>
              <strong style="color:#10b981;">100G Primary</strong>
            </div>`;
        } else if (dev.safeType === 'core-router') {
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Mesh Topology:</span>
              <strong style="color:#9333ea;">Active Backbone</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Path Redundancy:</span>
              <strong style="color:#10b981;">Active / Active</strong>
            </div>`;
        } else {
          // CUSTOMER ROUTER STATS
          statsHtml = `
            <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:12px;">
              <span style="color:#64748b;">Connection:</span>
              <strong style="color:#10b981;">Online</strong>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:12px;">
              <span style="color:#64748b;">Plan:</span>
              <strong style="color:#3b82f6;">1 Gbps Fiber</strong>
            </div>`;
        }

        new maplibregl.Popup({ offset: 25, closeButton: true, closeOnClick: true })
          .setLngLat([dev.lng, dev.lat])
          .setHTML(`
            <div style="font-family: system-ui, sans-serif; padding: 4px; min-width: 180px;">
              <h4 style="margin: 0; font-size: 14px; color: #1e293b;">${dev.name}</h4>
              <p style="margin: 2px 0 8px 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em;">
                ${(dev.type || '').replace('-', ' ')}
              </p>
              <div style="padding-top: 6px; border-top: 1px solid #e2e8f0;">
                ${statsHtml}
              </div>
            </div>
          `)
          .addTo(map);
      }

      // --- STATE & ROUTE MANAGEMENT ---

      function queueLiveRouteUpdate() {
        if (liveRouteUpdateTimeout.current) return;
        liveRouteUpdateTimeout.current = setTimeout(() => {
            if (mapInstanceRef.current && mapInstanceRef.current.getSource('live-routes')) {
                mapInstanceRef.current.getSource('live-routes').setData(liveRoutesRef.current);
            }
            liveRouteUpdateTimeout.current = null;
        }, 32); 
      }

      function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
        const safeId = String(linkId);
        fetchedRouteIdsRef.current.add(safeId); 
        const features = liveRoutesRef.current.features.filter(f => String(f.properties.id) !== safeId);
        features.push({
          type: 'Feature', properties: { id: safeId, type: linkType, ...props, from: String(props.from), to: String(props.to) },
          geometry: { type: 'LineString', coordinates }
        });
        liveRoutesRef.current.features = features;
        queueLiveRouteUpdate();
        modifiedRouteIdsRef.current.add(safeId);
      }

      function updateClusterSource() {
        if (map.getSource('main-devices')) {
          map.getSource('main-devices').setData({
            type: 'FeatureCollection',
            features: mainDevicesRef.current.map(toGeoJSONFeature),
          });
        }
      }

      function refreshFilters() {
        const focusId = focusedDeviceIdRef.current;
        const modifiedIdsArray = Array.from(modifiedRouteIdsRef.current).map(String);
        
        const excludeModified = modifiedIdsArray.length > 0 
          ? ['!', ['match', ['to-string', ['get', 'id']], modifiedIdsArray, true, false]] 
          : null;

        let staticFilter, liveFilter;

        if (focusId) {
          const focusStr = String(focusId);
          const focusCheck = [ 
            'any', 
            ['==', ['to-string', ['get', 'from']], focusStr], 
            ['==', ['to-string', ['get', 'to']], focusStr] 
          ];
          
          staticFilter = excludeModified ? ['all', excludeModified, focusCheck] : focusCheck;
          liveFilter = focusCheck; 
        } else {
          staticFilter = excludeModified ?? null;
          liveFilter = null; 
        }

        if (map.getLayer('links-generic')) map.setFilter('links-generic', staticFilter);
        if (map.getLayer('live-generic'))  map.setFilter('live-generic',  liveFilter);

        if (focusId) {
          const neighbourIds = (linksByDevice[String(focusId)] || []).map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from));
          const focusedSet = [String(focusId), ...neighbourIds];
          
          if (map.getLayer('unclustered-main-devices')) {
            map.setFilter('unclustered-main-devices', ['match', ['to-string', ['get', 'id']], focusedSet, true, false]);
          }
          if (map.getLayer('unclustered-devices')) {
            map.setFilter('unclustered-devices', ['all', ['!', ['has', 'point_count']], ['match', ['to-string', ['get', 'id']], focusedSet, true, false]]);
          }
          ['main-clusters', 'main-cluster-count'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
        } else {
          if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
          if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', ['!', ['has', 'point_count']]);
          ['main-clusters', 'main-cluster-count'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        }
      }

      function showMarkers() {
        const bounds = map.getBounds();
        const focusId = focusedDeviceIdRef.current;
        let devicesToRender = [];

        if (focusId) {
          const connectedLinks = linksByDevice[String(focusId)] || [];
          const neighborIds = connectedLinks.map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from));
          devicesToRender = devices.filter(d => String(d.id) === String(focusId) || neighborIds.includes(String(d.id)));
        } else {
          devicesToRender = devices.filter(dev => dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() && dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth());
        }

        ['links', 'live'].forEach(prefix => { if (map.getLayer(`${prefix}-generic`)) map.setLayoutProperty(`${prefix}-generic`, 'visibility', 'visible'); });
        refreshFilters();

        const visibleIds = new Set(devicesToRender.map(d => String(d.id)));
        const candidates = links.filter(l => (visibleIds.has(String(l.from)) || visibleIds.has(String(l.to))) && !fetchedRouteIdsRef.current.has(String(l.id)));

        const infraLinks = candidates.filter(l => {
            const fType = (devMap[String(l.from)]?.type || '').toLowerCase();
            const tType = (devMap[String(l.to)]?.type || '').toLowerCase();
            return INFRA.has(fType) || INFRA.has(tType);
        }).slice(0, 20);

        if (infraLinks.length) {
          infraLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));
          Promise.all(infraLinks.map(async (link) => {
            const from = devMap[String(link.from)], to = devMap[String(link.to)];
            if (!from || !to) return;
            try {
              const res = await fetch('http://localhost:8000/api/route', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng }, link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' }),
              });
              if (!res.ok) throw new Error(res.status);
              const coords = await res.json();
              updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]), { from: link.from, to: link.to, fromName: from.name, toName: to.name });
            } catch { updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]], { from: link.from, to: link.to, fromName: from.name, toName: to.name }); }
          })).then(() => refreshFilters());
        }

        for (const [id, marker] of activeMarkersRef.current.entries()) {
            const isFocused = id === String(focusedDeviceIdRef.current);
            if (!visibleIds.has(id) || (!INFRA.has(devMap[id]?.safeType) && !isFocused)) {
                marker.remove();
                activeMarkersRef.current.delete(id);
            }
        }

        devicesToRender.forEach(dev => {
          const id = String(dev.id);
          const isInfra = INFRA.has(dev.safeType);
          const isFocused = id === String(focusedDeviceIdRef.current);

          if (!isInfra && !isFocused) return;          
          
          if (!activeMarkersRef.current.has(id)) {
            const marker = createMarker(dev, map);  
            marker.addTo(map);
            activeMarkersRef.current.set(id, marker);

            marker.getElement().addEventListener('click', (e) => {
              e.stopPropagation();
              focusedDeviceIdRef.current = dev.id;
              showMarkers(); 
              showStatsPopup(dev); // Trigger detailed stats!
            });

            marker.on('dragstart', () => {
              const affected = linksByDevice[String(dev.id)] || [];
              affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
              refreshFilters();
              // Hide only the focused dot; keep neighbor dots visible
              if (!INFRA.has(dev.safeType) && map.getLayer('unclustered-devices')) {
                const neighbourIds = (linksByDevice[String(dev.id)] || []).map(l =>
                  String(l.from) === String(dev.id) ? String(l.to) : String(l.from)
                );
                map.setFilter('unclustered-devices', ['all', ['!', ['has', 'point_count']],
                  ['match', ['to-string', ['get', 'id']], neighbourIds.length ? neighbourIds : ['__none__'], true, false]
                ]);
              }
            });
            marker.on('drag', () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng;
              dev.lat = coords.lat;

              const affected = linksByDevice[String(dev.id)] || [];
              const dragFeatures = [];

              affected.forEach(link => {
                const isFrom = String(link.from) === String(dev.id);
                const otherDevId = isFrom ? String(link.to) : String(link.from);
                const otherDev = devMap[otherDevId];
                
                if (otherDev) {
                  const isOtherDevInfra = INFRA.has(otherDev.safeType);
                  const isThisDevInfra = INFRA.has(dev.safeType);

                  if ((isThisDevInfra && isOtherDevInfra) || affected.length < 15) {
                      dragFeatures.push({
                        type: 'Feature', properties: { id: link.id },
                        geometry: { type: 'LineString', coordinates: isFrom ? [[coords.lng, coords.lat], [otherDev.lng, otherDev.lat]] : [[otherDev.lng, otherDev.lat], [coords.lng, coords.lat]] }
                      });
                  }
                }
              });
              
              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: dragFeatures });
            });

            marker.on('dragend', async () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng;
              dev.lat = coords.lat;

              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: [] });

              const affected = linksByDevice[String(dev.id)] || [];

              await Promise.all(affected.map(async link => {
                const from = devMap[String(link.from)];
                const to = devMap[String(link.to)];
                if (!from || !to) return; 

                const isAccessLink = !INFRA.has((from.type||'').toLowerCase()) && !INFRA.has((to.type||'').toLowerCase());

                if (isAccessLink) {
                  updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]], { from: link.from, to: link.to });
                } else {
                  try {
                    const response = await fetch('http://localhost:8000/api/route', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng }, link_id: `${link.from}-${link.to}`, link_type: 'generic' })
                    });
                    if (!response.ok) throw new Error(response.status);
                    const osrmCoords = await response.json();
                    updateLiveRouteInMap(link.id, 'generic', osrmCoords.map(([lat, lng]) => [lng, lat]), { from: link.from, to: link.to });
                  } catch (err) {
                    updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]], { from: link.from, to: link.to });
                  }
                }
              }));
              // Push updated coords back into the GL source so the dot moves
              if (!INFRA.has(dev.safeType) && map.getSource('devices')) {
                map.getSource('devices').setData({
                  type: 'FeatureCollection',
                  features: devices.filter(d => !INFRA.has(d.safeType)).map(toGeoJSONFeature),
                });
              }
              refreshFilters(); // restores the focusedSet filter — dot reappears at new position
              updateClusterSource();
            });
          }
        });

        ['clusters', 'cluster-count', 'clusters-outer', 'main-clusters', 'main-cluster-count', 'unclustered-main-devices']
          .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
      }

      function hideMarkers() {
        for (const marker of activeMarkersRef.current.values()) {
            marker.remove();
        }
        activeMarkersRef.current.clear();
        focusedDeviceIdRef.current = null; 

        ['links', 'live'].forEach(prefix => { if (map.getLayer(`${prefix}-generic`)) map.setLayoutProperty(`${prefix}-generic`, 'visibility', 'none'); });
        
        ['clusters', 'cluster-count', 'clusters-outer', 'main-clusters', 'main-cluster-count', 'unclustered-main-devices']
          .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
        if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', ['!', ['has', 'point_count']]);
      }      

      hideMarkers();

      map.on('moveend', () => { if (map.getZoom() >= 12) showMarkers(); });
      map.on('zoomend', () => { map.getZoom() >= 12 ? showMarkers() : hideMarkers(); });

      map.on('click', (e) => {
        const interactiveLayers = ['unclustered-main-devices', 'main-clusters', 'clusters', 'clusters-outer', 'unclustered-devices'];
        const activeLayers = interactiveLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
        
        if (activeLayers.length > 0) {
          const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
          if (features.length > 0) return; 
        }

        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        
        focusedDeviceIdRef.current = null;
        if (map.getZoom() >= 12) { showMarkers(); } 
        else { hideMarkers(); }
      });

      map.on('click', 'clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        const clusterId = features[0].properties.cluster_id;
        const zoom = await map.getSource('devices').getClusterExpansionZoom(clusterId);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });

      map.on('click', 'main-clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['main-clusters'] });
        const clusterId = features[0].properties.cluster_id;
        const zoom = await map.getSource('main-devices').getClusterExpansionZoom(clusterId);
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });

      map.on('mouseenter', 'main-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'main-clusters', () => { map.getCanvas().style.cursor = ''; });

      map.on('mouseenter', 'clusters-outer', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'clusters-outer', () => { map.getCanvas().style.cursor = ''; });

    });    

    return () => {
      if (liveRouteUpdateTimeout.current) clearTimeout(liveRouteUpdateTimeout.current);
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