import { useEffect, useRef, useState } from 'react';
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
  const [stats, setStats]             = useState({ total: 0, online: 0, degraded: 0, down: 0 });
  const searchRef                     = useRef(null);
  const showMarkersRef                = useRef(null);  // will hold the showMarkers fn
  const devMapRef                     = useRef({});    // mirror of devMap for search access


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
      function mockStatus(id) {
        const n = String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        return ['online','online','online','online','online','online','degraded','degraded','down','down'][n % 10];
      }


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
        devMapRef.current = devMap; // expose to search handler
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
      
      // Compute health stats from all links
      const statuses = links.map(l => mockStatus(l.id));
      setStats({
        total: links.length,
        online:   statuses.filter(s => s === 'online').length,
        degraded: statuses.filter(s => s === 'degraded').length,
        down:     statuses.filter(s => s === 'down').length,
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
          minzoom: 10, 
          paint: { 'line-color': '#f804bb', 'line-width': 4 }
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

      map.setPaintProperty('live-generic', 'line-color',
        ['coalesce', ['get', 'statusColor'], '#ffffff88']
      );

      map.setPaintProperty('live-generic', 'line-width', [
        'match', ['get', 'tier'],
        'core',   6.0,
        'edge',   4.0,
        'olt',    3.0,
        2.0,
        /* access */ 1.2
      ]);

      map.setPaintProperty('live-generic', 'line-opacity', [
        'match', ['get', 'tier'],
        'core', 1,
        'edge', 0.9,
        'olt',  0.7,
        0.8
      ]);

      map.addLayer({
        id: 'live-generic-glow',
        type: 'line',
        source: 'live-routes',
        minzoom: 10,
        paint: {
          'line-color': ['coalesce', ['get', 'statusColor'], '#22c55e'],
          'line-width': 12,
          'line-opacity': 0.18,
          'line-blur': 8,
        }
      }, 'live-generic');


      // path-highlight: two-layer glow + solid status-coloured line
      map.addSource('path-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'path-glow', type: 'line', source: 'path-highlight',
        paint: { 'line-color': '#ffffff', 'line-width': 14, 'line-opacity': 0.18, 'line-blur': 8 }
      });
      map.addLayer({
        id: 'path-line', type: 'line', source: 'path-highlight',
        paint: { 'line-color': ['get', 'statusColor'], 'line-width': 3.5, 'line-opacity': 1 }
      });

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
        id: 'unclustered-devices', type: 'circle', source: 'devices', filter: ['!', ['has', 'point_count']], cursor: 'pointer',
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
          showUpstreamPath(featureId);
          
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
          showUpstreamPath(featureId);   
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

      // Hierarchy tier — used to walk upstream from any device to core
      const TIER = { access: 0, olt: 1, 'edge-router': 2, 'core-router': 3 };
      const STATUS_COLOR = { online: '#22c55e', degraded: '#f59e0b', down: '#ef4444' };

      // Deterministic mock status per link/device id — replace with API field when available

      // Walk linksByDevice upward through the hierarchy from startId → core
      function getUpstreamPath(startId) {
        const linkIds = [], deviceIds = [];
        let cur = String(startId);
        for (let i = 0; i < 10; i++) {
          const dev = devMap[cur];
          if (!dev) break;
          const tier = TIER[dev.safeType] ?? -1;
          deviceIds.push(cur);
          if (tier >= 3 || tier < 0) break;
          const upLink = (linksByDevice[cur] || []).find(l => {
            const otherId = String(l.from) === cur ? String(l.to) : String(l.from);
            return (TIER[devMap[otherId]?.safeType] ?? -1) > tier;
          });
          if (!upLink) break;
          linkIds.push(String(upLink.id));
          cur = String(upLink.from) === cur ? String(upLink.to) : String(upLink.from);
        }
        return { linkIds, deviceIds };
      }

      // Populate the path-highlight source with the upstream chain of a clicked device.
      // Uses road-following geometry from liveRoutesRef if already fetched, straight line otherwise.
      function showUpstreamPath(deviceId) {
        const { linkIds } = getUpstreamPath(deviceId);
        const features = linkIds.map(lid => {
          const color = STATUS_COLOR[mockStatus(lid)];
          const existing = liveRoutesRef.current.features.find(f => String(f.properties.id) === lid);
          if (existing) return { ...existing, properties: { ...existing.properties, statusColor: color } };
          const link = linkMap[lid];
          if (!link) return null;
          const from = devMap[String(link.from)], to = devMap[String(link.to)];
          if (!from || !to) return null;
          return {
            type: 'Feature',
            properties: { id: lid, statusColor: color },
            geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }
          };
        }).filter(Boolean);
        map.getSource('path-highlight')?.setData({ type: 'FeatureCollection', features });
      }

      function clearUpstreamPath() {
        map.getSource('path-highlight')?.setData({ type: 'FeatureCollection', features: [] });
      }
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
          type: 'Feature',
          properties: {
            id: safeId, type: linkType, ...props,
            from: String(props.from), to: String(props.to),
            statusColor: STATUS_COLOR[mockStatus(safeId)],
            tier: (() => {
              const fType = devMap[String(props.from)]?.safeType || '';
              const tType = devMap[String(props.to)]?.safeType   || '';
              if (fType === 'core-router' || tType === 'core-router') return 'core';
              if (fType === 'edge-router' || tType === 'edge-router') return 'edge';
              if (fType === 'olt'         || tType === 'olt')         return 'olt';
              return 'access';
            })(),
          },
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
          const focusedDev = devMap[String(focusId)];
          const suppressCustomers = focusedDev?.safeType === 'olt' && map.getZoom() < 15;

          liveFilter = suppressCustomers
            ? ['all', focusCheck, ['!=', ['get', 'isInfra'], false]]
            : focusCheck;        
        } else {
          staticFilter = excludeModified ?? null;
          liveFilter = ['boolean', ['get', 'isInfra'], true];
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
          const neighborIds = new Set(
            connectedLinks.map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from))
          );
          neighborIds.add(String(focusId));
          // Search main array for the focused device and its neighbors (including customers!)
          devicesToRender = devices.filter(d => neighborIds.has(String(d.id)));
        } else {
          // Only infra devices get HTML markers normally — no need to scan 60k customers
          devicesToRender = mainDevicesRef.current.filter(dev =>
            dev.lng >= bounds.getWest() && dev.lng <= bounds.getEast() &&
            dev.lat >= bounds.getSouth() && dev.lat <= bounds.getNorth()
          );
        }
        
        ['links-generic', 'live-generic', 'live-generic-glow'].forEach(id => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
        });

        const visibleIds = new Set(devicesToRender.map(d => String(d.id)));

        // Walk linksByDevice (already indexed) instead of scanning all 60k+ links
        const seenLinkIds = new Set();
        const candidates = [];
        for (const id of visibleIds) {
          for (const link of (linksByDevice[id] || [])) {
            const lid = String(link.id);
            if (!seenLinkIds.has(lid) && !fetchedRouteIdsRef.current.has(lid)) {
              seenLinkIds.add(lid);
              candidates.push(link);
            }
          }
        }

        const infraLinks = candidates.filter(l => {
            const fType = (devMap[String(l.from)]?.safeType || '');
            const tType = (devMap[String(l.to)]?.safeType || '');
            return INFRA.has(fType) && INFRA.has(tType);
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
            updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]),
              { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
            } catch { updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
                    { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true }); }
          })).then(() => refreshFilters());
        }

        if (focusId) {
          const focusedDev = devMap[String(focusId)];
          const isOlt = focusedDev?.safeType === 'olt';
          const zoom = map.getZoom();
          const bounds = map.getBounds();

          // OLTs have ~600 customers — only draw lines that are actually in viewport
          // and only when zoomed in enough to make individual lines meaningful
          const customerLinksToRender = candidates.filter(l => {
            if (String(l.from) !== String(focusId) && String(l.to) !== String(focusId)) return false;
            if (isOlt && zoom < 15) return false; // suppress starburst at wide zoom

            // only render customers visible in current viewport
            const otherId = String(l.from) === String(focusId) ? String(l.to) : String(l.from);
            const other = devMap[otherId];
            if (!other) return false;
            return (
              other.lng >= bounds.getWest() && other.lng <= bounds.getEast() &&
              other.lat >= bounds.getSouth() && other.lat <= bounds.getNorth()
            );
          });

          customerLinksToRender.slice(0, 40).forEach(l => {
            const from = devMap[String(l.from)], to = devMap[String(l.to)];
            if (from && to) {
              updateLiveRouteInMap(l.id, 'generic',
                [[from.lng, from.lat], [to.lng, to.lat]],
                { from: l.from, to: l.to, fromName: from.name, toName: to.name, isInfra: false }
              );
            }
          });
        }        
        // 1. Cleanup off-screen markers or unfocused customers
        for (const [id, marker] of activeMarkersRef.current.entries()) {
            const isInfra = INFRA.has(devMap[id]?.safeType || '');
            const isFocused = id === String(focusedDeviceIdRef.current);
            if (!visibleIds.has(id) || (!isInfra && !isFocused)) {
                marker.remove();
                activeMarkersRef.current.delete(id);
            }
        }

        // 2. Generate HTML markers
        devicesToRender.forEach(dev => {
          const id = String(dev.id);
          const isInfra = INFRA.has(dev.safeType);
          const isFocused = id === String(focusedDeviceIdRef.current);
          
          // IMPORTANT: Allow the focused customer device to become a marker!
          if (!isInfra && !isFocused) return; 
          
          if (!activeMarkersRef.current.has(id)) {
            const marker = createMarker(dev, map);  
            const status = mockStatus(dev.id);
            const el = marker.getElement();
            el.classList.remove('marker-status-down', 'marker-status-degraded');
            if (status === 'down')     el.classList.add('marker-status-down');
            if (status === 'degraded') el.classList.add('marker-status-degraded');
            marker.addTo(map);
            activeMarkersRef.current.set(id, marker);

            marker.getElement().addEventListener('click', (e) => {
              e.stopPropagation();
              focusedDeviceIdRef.current = dev.id;
              showMarkers(); 
              showStatsPopup(dev); 
            });

            marker.on('dragstart', () => {
               const affected = linksByDevice[String(dev.id)] || [];
               affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
               refreshFilters(); 
            });

            marker.on('drag', () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng; dev.lat = coords.lat;

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
              dev.lng = coords.lng; dev.lat = coords.lat;

              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: [] });

              const affected = linksByDevice[String(dev.id)] || [];
              
              // High-Performance Batching:
              const affectedSet = new Set(affected.map(l => String(l.id)));
              liveRoutesRef.current.features = liveRoutesRef.current.features.filter(
                f => !affectedSet.has(String(f.properties.id))
              );

              const straightLineFeatures = [];
              const osrmPromises = [];

              affected.forEach(link => {
                const from = devMap[String(link.from)];
                const to = devMap[String(link.to)];
                if (!from || !to) return; 
                
                modifiedRouteIdsRef.current.add(String(link.id));
                fetchedRouteIdsRef.current.add(String(link.id));

                const isInfraLink = INFRA.has(from.safeType) && INFRA.has(to.safeType);

                if (isInfraLink) {
                  osrmPromises.push(
                    fetch('http://localhost:8000/api/route', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng }, link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' })
                    }).then(res => res.json())
                      .then(osrmCoords => {
                      updateLiveRouteInMap(link.id, 'generic', osrmCoords.map(c => [c[1], c[0]]),
                        { from: link.from, to: link.to, isInfra: true });
                      })
                      .catch(() => {
                        updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
                          { from: link.from, to: link.to, isInfra: true });
                      })
                  );
                } else {
                  // Instant straight lines for 600+ customers!
                  straightLineFeatures.push({
                    type: 'Feature',
                    properties: {
                      id: String(link.id), type: 'generic',
                      from: String(link.from), to: String(link.to),
                      statusColor: STATUS_COLOR[mockStatus(link.id)],
                      isInfra: false,
                    },
                    geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }
                  });
                }
              });

              if (straightLineFeatures.length > 0) {
                 liveRoutesRef.current.features.push(...straightLineFeatures);
                 queueLiveRouteUpdate();
              }

              await Promise.all(osrmPromises);
              updateClusterSource();
              if (!INFRA.has(dev.safeType) && map.getSource('devices')) {
                map.getSource('devices').setData({
                  type: 'FeatureCollection',
                  features: accessDevices.map(toGeoJSONFeature),
                });
              }
            });
          }
        });

        const layersToHide = ['clusters', 'cluster-count', 'clusters-outer', 'main-clusters', 'main-cluster-count'];
        if (!focusId) layersToHide.push('unclustered-main-devices');
        layersToHide.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });

      }

      showMarkersRef.current = showMarkers;

      function hideMarkers() {
        for (const marker of activeMarkersRef.current.values()) {
            marker.remove();
        }
        activeMarkersRef.current.clear();
        focusedDeviceIdRef.current = null; 

        ['links-generic', 'live-generic', 'live-generic-glow'].forEach(id => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        });
        
        ['clusters', 'cluster-count', 'clusters-outer', 'main-clusters', 'main-cluster-count', 'unclustered-main-devices']
          .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
        if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', ['!', ['has', 'point_count']]);
      }      

      hideMarkers();
      clearUpstreamPath();

      let _showMarkersTimer = null;
      const debouncedShowMarkers = () => {
        clearTimeout(_showMarkersTimer);
        _showMarkersTimer = setTimeout(showMarkers, 120);
      };

      map.on('moveend', () => { if (map.getZoom() >= 12) debouncedShowMarkers(); });
      map.on('zoomend', () => { map.getZoom() >= 12 ? debouncedShowMarkers() : hideMarkers(); });

      map.on('click', (e) => {
        const interactiveLayers = ['unclustered-main-devices', 'main-clusters', 'clusters', 'clusters-outer', 'unclustered-devices'];
        const activeLayers = interactiveLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
        
        if (activeLayers.length > 0) {
          const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
          if (features.length > 0) return; 
        }

        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        
        focusedDeviceIdRef.current = null;
        clearUpstreamPath();
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
    
      const handleSearch = (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim().toLowerCase();
      if (!q) return;
      const match = Object.values(devMapRef.current).find(d =>
        d.name?.toLowerCase().includes(q) || String(d.id).toLowerCase().includes(q)
      );
      if (!match) return;
      const map = mapInstanceRef.current;
      map.flyTo({ center: [match.lng, match.lat], zoom: 15, duration: 900 });
      map.once('moveend', () => {
        focusedDeviceIdRef.current = String(match.id);
        showMarkersRef.current?.();
      });
      if (searchRef.current) searchRef.current.blur();
    };

    searchRef.current?.addEventListener('keydown', handleSearch);
    // cleanup:
    searchRef.current?.removeEventListener('keydown', handleSearch);

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

      {/* ── Search Bar ── */}
      <div style={{
        position:'absolute', top:12, right:16, zIndex:10,
        display:'flex', alignItems:'center', gap:8,
        background:'rgba(15,23,42,0.9)', backdropFilter:'blur(10px)',
        border:'1px solid rgba(255,255,255,0.07)', borderRadius:10,
        padding:'6px 12px', boxShadow:'0 4px 20px rgba(0,0,0,0.4)'
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          ref={searchRef}
          placeholder="Search device…"
          style={{
            background:'transparent', border:'none', outline:'none',
            color:'#e2e8f0', fontSize:13, width:180,
            fontFamily:'system-ui,sans-serif'
          }}
        />
      </div>

      {/* ── Health HUD ── */}
      <div style={{
        position:'absolute', top:12, left:'50%', transform:'translateX(-50%)',
        zIndex:10, background:'rgba(15,23,42,0.9)', backdropFilter:'blur(10px)',
        border:'1px solid rgba(255,255,255,0.07)', borderRadius:12,
        padding:'8px 24px', display:'flex', gap:32, alignItems:'center',
        fontFamily:'system-ui,sans-serif', pointerEvents:'none',
        boxShadow:'0 4px 32px rgba(0,0,0,0.5)'
      }}>

      {/* ── Status Legend ── */}
      <div style={{
        position:'absolute', bottom:32, left:16, zIndex:10,
        background:'rgba(15,23,42,0.88)', backdropFilter:'blur(8px)',
        border:'1px solid rgba(255,255,255,0.07)', borderRadius:10,
        padding:'10px 14px', fontFamily:'system-ui,sans-serif',
        boxShadow:'0 4px 20px rgba(0,0,0,0.4)'
      }}>
        <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8, fontWeight:600 }}>
          Link Status
        </div>
        {[
          { color:'#22c55e', label:'Online' },
          { color:'#f59e0b', label:'Degraded' },
          { color:'#ef4444', label:'Down' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
            <div style={{ width:24, height:3, borderRadius:2, background:color }} />
            <span style={{ fontSize:12, color:'#cbd5e1' }}>{label}</span>
          </div>
        ))}
        <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', marginTop:8, paddingTop:8 }}>
          {[
            { color:'#7c3aed', label:'Core / Edge (infra)' },
            { color:'#f63bbe', label:'Customer access' },
          ].map(({ color, label }) => (
            <div key={label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:color, flexShrink:0 }} />
              <span style={{ fontSize:11, color:'#94a3b8' }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
        <span style={{color:'#475569', fontSize:10, textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:600}}>
          Network Health
        </span>
        {[
          { label:'Total Links', value: stats.total,    color:'#94a3b8' },
          { label:'Online',      value: stats.online,   color:'#22c55e' },
          { label:'Degraded',    value: stats.degraded, color:'#f59e0b' },
          { label:'Down',        value: stats.down,     color:'#ef4444' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ textAlign:'center' }}>
            <div style={{ fontSize:20, fontWeight:700, color, lineHeight:1 }}>{value.toLocaleString()}</div>
            <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}