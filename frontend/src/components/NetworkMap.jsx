import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { createMarker } from '../utils/createMarker'; 
import { loadDeviceIcons } from '../utils/iconSprite';
import { fetchRoute } from '../utils/fetchRoute';
import { toGeoJSON } from '../utils/toGeoJSON';


const INFRA = new Set(['core-router', 'router', 'edge-router', 'olt', 'server', 'switch']);
const STATUS_COLOR = { online: '#22c55e', degraded: '#f59e0b', down: '#ef4444' };
const DEVICE_LEVEL = {
  'core-router': 4, 'router': 4, 'switch': 4, 'server': 4,
  'edge-router': 3, 'olt': 2, 'access': 1
};

const TIER = { access: 0, olt: 1, 'edge-router': 2, 'core-router': 3 };
const TIER_COLOR = {
  core:   '#4f46e5',  // indigo     – national backbone
  edge:   '#0891b2',  // cyan       – regional gateways
  olt:    '#7c3aed',  // violet     – neighbourhood aggregators
  access: '#c4b5fd',  // violet-300 – last-mile access / customers
};


export default function NetworkMap() {
  const mapRef                        = useRef(null);
  const linkMapRef                    = useRef({});
  const ObjectLinksByDeviceRef        = useRef({});
  const mapInstanceRef                = useRef(null);
  const activeMarkersRef              = useRef(new Map()); 
  const liveRouteUpdateTimeout        = useRef(null);
  const liveRouteMapRef               = useRef(new Map());
  const modifiedRouteIdsRef           = useRef(new Set());
  const focusedCustomerRouteIdsRef    = useRef(new Set());
  const liveRoutesRef                 = useRef({ type: 'FeatureCollection', features: [] });
  const focusedDeviceIdRef            = useRef(null);
  const fetchedRouteIdsRef            = useRef(new Set());
  const mainDevicesRef                = useRef([]);
  const accessDevicesRef              = useRef([]);
  const showMarkersRef                = useRef(null);  
  const devMapRef                     = useRef({});    
  const [stats, setStats]             = useState({ total: 0, online: 0, degraded: 0, down: 0 });


  useEffect(() => {
    if (mapInstanceRef.current) return;

    // 1. Prevent Protocol Collision
    try {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    } catch (err) {
      // Safely ignore if already registered
    }

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/streets/style.json?key=B2aWdlpiBBhi0n5jeueG`,
      center: [90.4193, 23.7269], 
      zoom: 11
    });

    mapInstanceRef.current = map;
    
    if (import.meta.env.DEV) {
      window.__map = map;
      window.maplibregl = maplibregl;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    
    map.on('styleimagemissing', (e) => {
        map.addImage(e.id, new ImageData(1, 1));
    });

    // 2. Track component mount state for async safety
    let isMounted = true;
    map.on('load', async () => {
      try {
        function mockStatus(id) { 
          const n = String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
          return ['online','online','online','online','online','online','degraded','degraded','down','down'][n % 10];
        }

      await loadDeviceIcons(map).catch(e => console.error('❌ loadDeviceIcons failed:', e));


        // 3. Halt execution if component unmounted during the fetch
      if (!isMounted) return;

      const devMap = devMapRef.current;


      const toGeoJSONFeature = (device) => {
        let renderType = 'Access';
        const t = (device.type || '').toLowerCase();
        if (t.includes('core')) renderType = 'Core Router';
        else if (t.includes('edge')) renderType = 'Edge Router';
        else if (t.includes('olt')) renderType = 'OLT';

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [device.lng, device.lat] },
          properties: { 
            id: String(device.id), 
            name: device.name || 'Unknown',
            type: device.type,
            safeType: device.safeType,
            renderType
          } 
        };
      };

      // Initialize global maps as empty properties attached to refs,
      // or just make them global within the load block since they are accessed by closures later.
      const linkMap = {};
      const ObjectLinksByDevice = {};
      linkMapRef.current = linkMap;
      ObjectLinksByDeviceRef.current = ObjectLinksByDevice;
      const fetchedViewportRef = new Set(); // Prevent fetching the same area twice

      async function fetchViewportData() {
        const bounds = map.getBounds();
        const zoom = map.getZoom();

        // 1. Determine Tier based on Zoom Level
        let maxTier = 'core'; 
        if (zoom >= 6 && zoom < 10) maxTier = 'olt';    // Regional: Core + Edge + OLT
        if (zoom >= 10) maxTier = 'access';             // District: Everything

        // 2. Create a grid key that INCLUDES the tier, so zooming in forces a refetch
        const G = zoom >= 10 ? 0.05 : 0.25; 
        const key = [
          Math.floor(bounds.getWest()  / G),
          Math.floor(bounds.getSouth() / G),
          Math.ceil(bounds.getEast()   / G),
          Math.ceil(bounds.getNorth()  / G),
          maxTier
        ].join(',');

        if (fetchedViewportRef.has(key)) return;
        fetchedViewportRef.add(key);

        const q = `west=${bounds.getWest()}&south=${bounds.getSouth()}&east=${bounds.getEast()}&north=${bounds.getNorth()}&tier=${maxTier}`;

        try {
          // 3. Fetch ONLY what is in the viewport at the required tier
          const [viewDevices, viewLinks] = await Promise.all([
            fetch(`http://localhost:8000/api/devices/viewport?${q}`).then(r => r.ok ? r.json() : []).catch(() => []),
            fetch(`http://localhost:8000/api/links/viewport?${q}`).then(r => r.ok ? r.json() : []).catch(() => []),
          ]);

          // Hydrate devMap with safeType so INFRA.has() checks work throughout
          viewDevices.forEach(d => {
            const strId = String(d.id);
            if (!devMapRef.current[strId]) {
              devMapRef.current[strId] = { ...d, safeType: d.type };
            }
          });
          // Keep accessDevicesRef in sync — used by showMarkers for viewport filtering
          accessDevicesRef.current = Object.values(devMapRef.current)
            .filter(d => !INFRA.has(d.safeType));

          // Populate linkMap + ObjectLinksByDevice so topology traversal works
          viewLinks.forEach(l => {
            const lid = String(l.id);
            linkMap[lid] = l;
            [String(l.from), String(l.to)].forEach(devId => {
              if (!ObjectLinksByDevice[devId]) ObjectLinksByDevice[devId] = [];
              if (!ObjectLinksByDevice[devId].some(x => String(x.id) === lid))
                ObjectLinksByDevice[devId].push(l);
            });
          });


          updateAllDeviceSources(); // Push new data to MapLibre
          queueLiveRouteUpdate();
          showMarkers();

        } catch (error) {
          console.error("Viewport fetch failed:", error);
        }
      }

      // Trigger this immediately on load, and then on map movement
      fetchViewportData();
      map.on('moveend', fetchViewportData);
      map.on('zoomend', fetchViewportData);

      map.addSource('main-devices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addSource('devices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      
      const addRouteLayers = (sourceId, prefix, sourceLayer = null) => {
        const layerId = `${prefix}-generic`;
        const layerConfig = {
          id: layerId, 
          type: 'line', 
          source: sourceId, 
          paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 4 }
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
    
      // Calculate Tiers and Colors FOR ALL ROUTES before handing them to MapLibre
      if (liveRoutesRef.current.features.length) {
        liveRoutesRef.current.features = liveRoutesRef.current.features.map(f => {
          const fromType = devMap[String(f.properties.from)]?.safeType || '';
          const toType   = devMap[String(f.properties.to)]?.safeType   || '';
          const linkLevel = Math.min(
            DEVICE_LEVEL[fromType] || 1,
            DEVICE_LEVEL[toType]   || 1
          );

          const tier = linkLevel >= 4 ? 'core'
           : linkLevel === 3 ? 'edge'
           : linkLevel === 2 ? 'olt'
           : 'access';

          return {
            ...f,
            properties: {
              ...f.properties,
              isInfra: INFRA.has(fromType) || INFRA.has(toType),
              statusColor: STATUS_COLOR[mockStatus(f.properties.id)],
              tier: tier,
            }
          };
        });
      }

      if (!map.getSource('live-routes')) {
          map.addSource('live-routes', { type: 'geojson', data: liveRoutesRef.current });
      }

      if (!map.getSource('drag-routes')) {
        map.addSource('drag-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
          id: 'drag-routes-line', type: 'line', source: 'drag-routes',
          paint: { 'line-color': '#94a3b8', 'line-width': 1.5, 'line-opacity': 0.5 } 
        });
      }

      if (!map.getSource('customer-route')) {
        map.addSource('customer-route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
          id: 'customer-route-line',
          type: 'line',
          source: 'customer-route',
          paint: {
            'line-color': ['coalesce', ['get', 'statusColor'], '#c4b5fd'],
            'line-width': 2,
            'line-opacity': 0.9
          }
        });
      }

      addRouteLayers('live-routes', 'live');

      map.setPaintProperty('live-generic', 'line-color',
        ['coalesce', ['get', 'statusColor'], ['get', 'tierColor'], '#4f46e5']
      );

      // line-width
      map.setPaintProperty('live-generic', 'line-width', [
        'step', ['zoom'],
        ['case', ['==', ['get', 'tier'], 'core'], 1.5, 0],
        4,  ['case', ['==', ['get', 'tier'], 'core'], 3.0, 0],
        6,  ['case', ['==', ['get', 'tier'], 'core'], 4.0, ['==', ['get', 'tier'], 'edge'], 2.0, 0],
        8,  ['case', ['==', ['get', 'tier'], 'core'], 5.0, ['==', ['get', 'tier'], 'edge'], 3.0, ['==', ['get', 'tier'], 'olt'], 1.5, 0],
        10, ['case', ['==', ['get', 'tier'], 'core'], 6.0, ['==', ['get', 'tier'], 'edge'], 4.0, ['==', ['get', 'tier'], 'olt'], 3.0, 2.0],
      ]);

      // line-opacity
      map.setPaintProperty('live-generic', 'line-opacity', [
        'step', ['zoom'],
        // Zoom < 6: Show only Core
        ['case', ['==', ['get', 'tier'], 'core'], 0.8, 0.0],
        // Zoom 6-8: Show Core + Edge
        6, ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, 0.0],
        // Zoom 8-10: Show Core + Edge + OLT
        8, ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, ['==', ['get', 'tier'], 'olt'],  0.8, 0.0],
        // Zoom 10+: Show everything (Add Access)
        10, ['case', ['==', ['get', 'tier'], 'core'], 1.0, ['==', ['get', 'tier'], 'edge'], 0.9, ['==', ['get', 'tier'], 'olt'],  0.8, 0.0]
      ]);
      
      // Inline the glow opacity so it doesn't crash from being called early
      map.addLayer({
        id: 'live-generic-glow',
        type: 'line',
        source: 'live-routes',
        paint: {
          'line-color': ['coalesce', ['get', 'statusColor'], '#22c55e'],
          'line-width': 12,
          'line-blur': 8,
          'line-opacity': [
            'step', ['zoom'],
            ['case', ['==', ['get', 'tier'], 'core'], 0.18, 0.0],
            6, ['case', ['==', ['get', 'tier'], 'core'], 0.18, ['==', ['get', 'tier'], 'edge'], 0.18, 0.0],
            8, ['case', ['==', ['get', 'tier'], 'core'], 0.18, ['==', ['get', 'tier'], 'edge'], 0.18, ['==', ['get', 'tier'], 'olt'], 0.15, 0.0],
            10, ['case', ['==', ['get', 'tier'], 'core'], 0.18, ['==', ['get', 'tier'], 'edge'], 0.18, ['==', ['get', 'tier'], 'olt'], 0.15, 0.0]
          ]
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
        paint: { 'line-color': ['coalesce', ['get', 'statusColor'], '#4f46e5'], 'line-width': 3.5, 'line-opacity': 1 }
      });


      map.on('click', 'unclustered-main-devices', (e) => {
        const featureId = e.features[0].properties.id;
        const coords = e.features[0].geometry.coordinates.slice();
        const dev = devMap[String(featureId)];

        popup.remove();
        clearCustomerRoute();
        focusedDeviceIdRef.current = featureId;

        map.easeTo({ center: coords, zoom: Math.max(map.getZoom(), 13) });

        map.once('moveend', () => {
          showMarkers();               
          showUpstreamPath(featureId);   
          if (dev) showStatsPopup(dev);
        });
      });
      map.on('mouseenter', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'unclustered-main-devices', () => { map.getCanvas().style.cursor = ''; });
       
      
      map.addLayer({
        id: 'unclustered-main-devices', 
        type: 'symbol', 
        source: 'main-devices', 
        layout: {
          'icon-image': ['get', 'safeType'],
          'icon-size': 1.0, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          'text-field': ['get', 'name'], 'text-offset': [0, 1.6], 'text-size': 10, 'text-optional': true, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        },
        paint: { 
          'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5,
          'icon-opacity': [
            'step', ['zoom'],
            // Zoom < 5: Only Core Routers
            ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, 0.0],
            // Zoom 5-7: Core + Edge Routers
            5, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, ['==', ['get', 'safeType'], 'edge-router'], 1.0, 0.0],
            // Zoom 7+: Show all remaining infra (OLTs, etc)
            7, 1.0
          ],
          'text-opacity': [
            'step', ['zoom'],
            ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, 0.0],
            5, ['case', ['==', ['get', 'safeType'], 'core-router'], 1.0, ['==', ['get', 'safeType'], 'edge-router'], 1.0, 0.0],
            7, 1.0
          ]
        },
      });

      function showStatsPopup(dev) {
        let statsHtml = '';
        const connectedLinks = ObjectLinksByDevice[String(dev.id)] || [];

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
  

      function getUpstreamPath(startId) {
        const linkIds = [], deviceIds = [];
        let cur = String(startId);
        for (let i = 0; i < 10; i++) {
          const dev = devMap[cur];
          if (!dev) break;
          const tier = TIER[dev.safeType] ?? -1;
          deviceIds.push(cur);
          if (tier >= 3 || tier < 0) break;
          const upLink = (ObjectLinksByDevice[cur] || []).find(l => {
            const otherId = String(l.from) === cur ? String(l.to) : String(l.from);
            return (TIER[devMap[otherId]?.safeType] ?? -1) > tier;
          });
          if (!upLink) break;
          linkIds.push(String(upLink.id));
          cur = String(upLink.from) === cur ? String(upLink.to) : String(upLink.from);
        }
        return { linkIds, deviceIds };
      }

      function showUpstreamPath(deviceId) {
        const { linkIds } = getUpstreamPath(deviceId);
        const features = linkIds.map(lid => {
          const color = STATUS_COLOR[mockStatus(lid)];
          const existing = liveRouteMapRef.current.get(lid);
          if (existing) {
            const safeColor = STATUS_COLOR[mockStatus(lid)] ?? (existing.properties.tierColor || '#4f46e5');
            return { ...existing, properties: { ...existing.properties, statusColor: safeColor } };
          }

          const link = linkMap[lid];
          if (!link) return null;
          const from = devMap[String(link.from)], to = devMap[String(link.to)];
          if (!from || !to) return null;
          const fType  = devMap[String(link.from)]?.safeType || '';
          const tType  = devMap[String(link.to)]?.safeType   || '';

          const linkLevel = Math.min(
            DEVICE_LEVEL[fType] || 1,
            DEVICE_LEVEL[tType]   || 1
          );
          const tier = linkLevel >= 4 ? 'core'
                    : linkLevel === 3 ? 'edge'
                    : linkLevel === 2 ? 'olt'
                    : 'access';

          const tColor = TIER_COLOR[tier];
          return {
            type: 'Feature',
            properties: {
              id: lid,
              tier,
              tierColor:   tColor,
              statusColor: STATUS_COLOR[mockStatus(lid)] ?? tColor,
            },
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
          const m = mapInstanceRef.current;
          if (!m?.getSource('live-routes')) { liveRouteUpdateTimeout.current = null; return; }
          const zoom = m.getZoom();
          // Mirror the line-opacity zoom steps: only pass features MapLibre would
          // render at this zoom. Keeps the setData payload proportional to what's
          // actually visible regardless of how large liveRouteMapRef grows.
          const features = [];
          for (const f of liveRouteMapRef.current.values()) {
            const tier = f.properties?.tier;
            if (zoom <  6 && tier !== 'core')                                        continue;
            if (zoom <  8 && tier !== 'core' && tier !== 'edge')                     continue;
            if (zoom < 10 && tier !== 'core' && tier !== 'edge' && tier !== 'olt')   continue;
            features.push(f);
          }
          liveRoutesRef.current.features = features;
          m.getSource('live-routes').setData(liveRoutesRef.current);
          liveRouteUpdateTimeout.current = null;
        }, 100);
      }

      function updateLiveRouteInMap(linkId, linkType, coordinates, props = {}) {
        const safeId = String(linkId);
        fetchedRouteIdsRef.current.add(safeId); 
        const newFeature ={
          type: 'Feature',
          properties: (() => {
            const fType = devMap[String(props.from)]?.safeType || '';
            const tType = devMap[String(props.to)]?.safeType   || '';
            const linkLevel = Math.min(
              DEVICE_LEVEL[fType] || 1,
              DEVICE_LEVEL[tType]   || 1
            );
            const tier = linkLevel >= 4 ? 'core'
                      : linkLevel === 3 ? 'edge'
                      : linkLevel === 2 ? 'olt'
                      : 'access';

            return {
              id: safeId, type: linkType, ...props,
              from: String(props.from), to: String(props.to),
              tier,
              tierColor:   TIER_COLOR[tier],
              statusColor: STATUS_COLOR[mockStatus(safeId)] ?? TIER_COLOR[tier],
            };
          })(),
          geometry: { type: 'LineString', coordinates }
        };
        liveRouteMapRef.current.set(safeId, newFeature);
        queueLiveRouteUpdate();
        modifiedRouteIdsRef.current.add(safeId);
      }

      function updateAllDeviceSources() {
        const accessFeatures = [];
        const mainFeatures = [];
        Object.values(devMapRef.current).forEach(d => {
          if (INFRA.has(d.safeType)) {
            mainFeatures.push(toGeoJSONFeature(d));
          } else {
            accessFeatures.push(toGeoJSONFeature(d));
          }
        });
        if (map.getSource('devices')) {
          map.getSource('devices').setData({ type: 'FeatureCollection', features: accessFeatures });
        }
        if (map.getSource('main-devices')) {
          map.getSource('main-devices').setData({ type: 'FeatureCollection', features: mainFeatures });
        }
      }

      function refreshFilters() {
        const focusId = focusedDeviceIdRef.current;

        if (focusId) {
          // USER CLICKED A DEVICE: Show ONLY the routes connected to this specific device
          const connectedLinkIds = (ObjectLinksByDevice[String(focusId)] || []).map(l => String(l.id));
          const focusFilter = ['in', ['to-string', ['get', 'id']], ['literal', connectedLinkIds]];

          if (map.getLayer('live-generic')) map.setFilter('live-generic', focusFilter);
          if (map.getLayer('live-generic-glow')) map.setFilter('live-generic-glow', focusFilter);

          // Hide the focused device's WebGL dot so the popup HTML marker doesn't look messy
          if (map.getLayer('unclustered-main-devices')) {
            map.setFilter('unclustered-main-devices', ['!=', ['to-string', ['get', 'id']], String(focusId)]);
          }
        } else {
          // NO DEVICE FOCUSED: Show ALL routes natively. 
          // (Our line-opacity zoom steps will naturally hide the customer routes at country-level)
          if (map.getLayer('live-generic')) map.setFilter('live-generic', null);
          if (map.getLayer('live-generic-glow')) map.setFilter('live-generic-glow', null);

          // Restore all device dots
          if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
          if (map.getLayer('unclustered-devices')) map.setFilter('unclustered-devices', null);
        }
      }

      async function fetchFocusedCustomerRoutes(deviceId) {
        const strId = String(deviceId);
        const links = ObjectLinksByDevice[strId] || [];

        const features = await Promise.all(links.map(async (link) => {
          const lid  = String(link.id);
          const from = devMap[String(link.from)];
          const to   = devMap[String(link.to)];
          if (!from || !to) return null;

          focusedCustomerRouteIdsRef.current.add(lid);

          // Re-use an already-fetched geometry if the OLT side was loaded as infra
          const existing = liveRouteMapRef.current.get(lid);
          let coordinates;
          if (existing) {
            coordinates = existing.geometry.coordinates;
          } else {
            try {
              const res = await fetch('http://localhost:8000/api/route', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  a: { lat: from.lat, lng: from.lng },
                  b: { lat: to.lat,   lng: to.lng   },
                  link_id:   `${link.from}-${link.to}`,
                  link_type: link.type || 'generic'
                }),
              });
              if (!res.ok) throw new Error(res.status);
              const coords = await res.json();
              coordinates = coords.map(([lat, lng]) => [lng, lat]);
            } catch {
              coordinates = [[from.lng, from.lat], [to.lng, to.lat]];
            }
          }

          return {
            type: 'Feature',
            properties: {
              id: lid,
              from: String(link.from),
              to:   String(link.to),
              tier: 'access',
              statusColor: STATUS_COLOR[mockStatus(lid)] ?? '#c4b5fd',
            },
            geometry: { type: 'LineString', coordinates }
          };
        }));

        map.getSource('customer-route')?.setData({
          type: 'FeatureCollection',
          features: features.filter(Boolean)
        });
      }

      function clearCustomerRoute() {
        map.getSource('customer-route')?.setData({ type: 'FeatureCollection', features: [] });
        focusedCustomerRouteIdsRef.current.clear();
      }

      function showMarkers() {
        const bounds = map.getBounds();
        const focusId = focusedDeviceIdRef.current;
        let devicesToRender = [];

        if (focusId) {
          const connectedLinks = ObjectLinksByDevice[String(focusId)] || [];
          const neighborIds = new Set(
            connectedLinks.map(l => String(l.from) === String(focusId) ? String(l.to) : String(l.from))
          );
          neighborIds.add(String(focusId));
          // Cap access neighbors — OLTs can have 600+ customer downlinks and
          // creating that many Marker instances in one frame causes severe lag.
          const infraNeighbors  = [];

          const accessNeighbors = [];
          for (const nid of neighborIds) {
            const d = devMapRef.current[nid];
            if (!d) continue;
            if (INFRA.has(d.safeType)) infraNeighbors.push(d);
            else if (accessNeighbors.length < 50) accessNeighbors.push(d);
          }

          devicesToRender = [...infraNeighbors, ...accessNeighbors];
        } else {
          const w = bounds.getWest(), e = bounds.getEast();
          const s = bounds.getSouth(), n = bounds.getNorth();
          const infraInView = mainDevicesRef.current.filter(
            dev => dev.lng >= w && dev.lng <= e && dev.lat >= s && dev.lat <= n
          );
          // Access devices are invisible below zoom 12 — only load them when
          // DOM markers are active, capped to keep DOM node count manageable.
          const accessInView = map.getZoom() >= 12
            ? accessDevicesRef.current.filter(
                dev => dev.lng >= w && dev.lng <= e && dev.lat >= s && dev.lat <= n
              ).slice(0, 400)
            : [];
          devicesToRender = [...infraInView, ...accessInView];
        }        

        ['links-generic', 'live-generic', 'live-generic-glow'].forEach(id => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
        });

        if (map.getLayer('unclustered-main-devices')) {
          map.setLayoutProperty('unclustered-main-devices', 'visibility', 'none');
        }


        const visibleIds = new Set(devicesToRender.map(d => String(d.id)));

        for (const [id, marker] of activeMarkersRef.current.entries()) {
            if (!visibleIds.has(id)) {
                marker.remove();
                activeMarkersRef.current.delete(id);
            }
        }

        devicesToRender.forEach(dev => {
          const strId = String(dev.id);
          const isInfra = INFRA.has(dev.safeType);

          if (!activeMarkersRef.current.has(strId)) {
            const marker = createMarker(dev, map);  
            const status = mockStatus(dev.id);
            const el = marker.getElement();
            
            el.classList.remove('marker-status-down', 'marker-status-degraded');
            if (status === 'down')     el.classList.add('marker-status-down');
            if (status === 'degraded') el.classList.add('marker-status-degraded');
            
            marker.addTo(map);
            activeMarkersRef.current.set(strId, marker);

            marker.getElement().addEventListener('click', (e) => {
              e.stopPropagation();
              clearCustomerRoute();
              focusedDeviceIdRef.current = String(dev.id);
              showMarkers(); 
              showStatsPopup(dev); 
              if (!INFRA.has(dev.safeType)) {
                fetchFocusedCustomerRoutes(String(dev.id));
              }
            });

            marker.on('dragstart', () => {
               const affected = ObjectLinksByDevice[strId] || [];
               affected.forEach(l => modifiedRouteIdsRef.current.add(String(l.id)));
               refreshFilters(); 
            });

            let _dragRaf = null;

          marker.on('drag', () => {
            if (_dragRaf) cancelAnimationFrame(_dragRaf);
            _dragRaf = requestAnimationFrame(() => {
              _dragRaf = null;
              const coords = marker.getLngLat();

              dev.lng = coords.lng; dev.lat = coords.lat;

              const affected = ObjectLinksByDevice[strId] || [];
              const dragFeatures = [];

              affected.forEach(link => {
                const isFrom = String(link.from) === strId;
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
              })

              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: dragFeatures });

              });
              
            });

            marker.on('dragend', async () => {
              const coords = marker.getLngLat();
              dev.lng = coords.lng; dev.lat = coords.lat;

              const allConnections = ObjectLinksByDevice[strId] || [];

              // Clear the temporary red dragging line
              map.getSource('drag-routes').setData({ type: 'FeatureCollection', features: [] });

              // Only process infra↔infra connections. Adding access links (customer→OLT)
              // to liveRouteMapRef floods it with hundreds of entries and causes cascading
              // setData calls that lock the browser. The drag-routes layer already handles
              // customer link visuals during the drag gesture — they need nothing more.
              const infraConnections = allConnections.filter(l => {
                const otherId = String(l.from) === strId ? String(l.to) : String(l.from);
                return INFRA.has(devMap[otherId]?.safeType);
              });

              const BATCH = 6;
              for (let i = 0; i < infraConnections.length; i += BATCH) {
                await Promise.all(
                  infraConnections.slice(i, i + BATCH).map(async (link) => {
                    try {
                      const isFrom      = String(link.from) === strId;
                      const otherDevId  = isFrom ? String(link.to) : String(link.from);
                      const otherDev    = devMap[otherDevId];
                      if (!otherDev) return;

                      const hyphenatedId = `${link.from}-${link.to}`;

                      // Snap to straight line immediately, then overwrite with OSRM road route
                      updateLiveRouteInMap(link.id, link.type || 'generic',
                        isFrom
                          ? [[dev.lng, dev.lat], [otherDev.lng, otherDev.lat]]
                          : [[otherDev.lng, otherDev.lat], [dev.lng, dev.lat]],
                        { from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: true }
                      );

                      const routeResponse = await fetchRoute(
                        { lat: dev.lat, lng: dev.lng },
                        { lat: otherDev.lat, lng: otherDev.lng },
                        { link_id: hyphenatedId, link_type: link.type || 'generic' }
                      );
                      updateLiveRouteInMap(link.id, link.type || 'generic',
                        toGeoJSON(routeResponse).geometry.coordinates,
                        { from: link.from, to: link.to, fromName: dev.name, toName: otherDev.name, isInfra: true }
                      );
                    } catch (err) {
                      console.error('Failed routing link:', link.id, err);
                    }
                  })
                );
              }
              updateAllDeviceSources();
              refreshFilters();

              fetch(`http://localhost:8000/api/devices/${dev.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lng: coords.lng, lat: coords.lat })
              }).catch(console.error);
            });
          }
        });

        const seenLinkIds = new Set();
        const candidates = [];
        for (const id of visibleIds) {
          for (const link of (ObjectLinksByDevice[id] || [])) {
            const lid = String(link.id);
            if (!seenLinkIds.has(lid) && !fetchedRouteIdsRef.current.has(lid)) {
              seenLinkIds.add(lid);
              candidates.push(link);
            }
          }
        }

        const infraLinks = candidates.filter(l => {
          const fType = devMap[String(l.from)]?.safeType || '';
          const tType = devMap[String(l.to)]?.safeType   || '';
          return INFRA.has(fType) && INFRA.has(tType);
        });



        if (infraLinks.length) {
          infraLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));
          Promise.all(infraLinks.map(async (link) => {
            const from = devMap[String(link.from)], to = devMap[String(link.to)];
            if (!from || !to) return;
            try {
              const res = await fetch('http://localhost:8000/api/route', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                // Use the correct hyphenated format for initialization too
                body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng }, link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' }),
              });
              if (!res.ok) throw new Error(res.status);
              const coords = await res.json();
              updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]),
                { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
            } catch { 
              updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
                    { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true }); 
            }
          })).then(() => refreshFilters());
        }
        
      }

      showMarkersRef.current = showMarkers;

      function hideMarkers() {
        clearCustomerRoute();
        for (const marker of activeMarkersRef.current.values()) {
            marker.remove();
        }
        activeMarkersRef.current.clear();
        focusedDeviceIdRef.current = null; 

      ['unclustered-main-devices']
        .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        if (map.getLayer('unclustered-main-devices')) map.setFilter('unclustered-main-devices', null);
      }      

      hideMarkers();
      clearUpstreamPath();
      refreshFilters();

      // ── STARTUP DATA LOAD ────────────────────────────────────────────────────
      // Infra (core / edge / olt) is always visible, so fetch it eagerly.
      // Customer devices are fetched on-demand by the viewport system below.
      const [infraDevices, infraLinkData] = await Promise.all([
        fetch('http://localhost:8000/api/devices/infra').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('http://localhost:8000/api/links/infra').then(r => r.ok ? r.json() : []).catch(() => []),
      ]);

      if (!isMounted) return;

      // Populate the shared device + link maps so every downstream closure works
      infraDevices.forEach(d => {
        devMap[String(d.id)] = { ...d, safeType: d.type };
      });
      mainDevicesRef.current = infraDevices.map(d => ({ ...d, safeType: d.type }));

      infraLinkData.forEach(l => {
        const lid = String(l.id);
        linkMap[lid] = l;
        [String(l.from), String(l.to)].forEach(devId => {
          if (!ObjectLinksByDevice[devId]) ObjectLinksByDevice[devId] = [];
          if (!ObjectLinksByDevice[devId].some(x => String(x.id) === lid))
            ObjectLinksByDevice[devId].push(l);
        });
      });
      updateAllDeviceSources();

      // Straight-line placeholders — visible instantly; OSRM overwrites them below
      const backboneLinks = infraLinkData.filter(l => {
        const fType = devMap[String(l.from)]?.safeType || '';
        const tType = devMap[String(l.to)]?.safeType   || '';
        return (fType === 'core-router' || tType === 'core-router' ||
                fType === 'edge-router' || tType === 'edge-router') &&
               !fetchedRouteIdsRef.current.has(String(l.id));
      });
      backboneLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));

      const oltInfraLinks = infraLinkData.filter(l => {
        const fType = devMap[String(l.from)]?.safeType || '';
        const tType = devMap[String(l.to)]?.safeType   || '';
        return (fType === 'olt' || tType === 'olt') &&
               INFRA.has(fType) && INFRA.has(tType) &&
               !fetchedRouteIdsRef.current.has(String(l.id));
      });
      oltInfraLinks.forEach(l => fetchedRouteIdsRef.current.add(String(l.id)));

      [...backboneLinks, ...oltInfraLinks].forEach(link => {
        const from = devMap[String(link.from)];
        const to   = devMap[String(link.to)];
        if (!from || !to) return;
        const fType = from.safeType || '';
        const tType = to.safeType   || '';
        const tier  =
          fType === 'core-router' || tType === 'core-router' ? 'core'
          : fType === 'edge-router' || tType === 'edge-router' ? 'edge'
          : 'olt';
        liveRouteMapRef.current.set(String(link.id), {
          type: 'Feature',
          properties: {
            id: String(link.id), type: link.type || 'generic',
            from: String(link.from), to: String(link.to),
            fromName: from.name, toName: to.name,
            isInfra: true, tier,
            tierColor:   TIER_COLOR[tier],
            statusColor: STATUS_COLOR[mockStatus(link.id)] ?? TIER_COLOR[tier],
          },
          geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] }
        });
      });
      liveRoutesRef.current.features = Array.from(liveRouteMapRef.current.values());
      map.getSource('live-routes').setData(liveRoutesRef.current);
      refreshFilters();
      // ─────────────────────────────────────────────────────────────────────────

      // Fetch road-snapped routes for backbone links in parallel batches
      const BB_BATCH = 25;
      for (let i = 0; i < backboneLinks.length; i += BB_BATCH) {
        await Promise.all(
          backboneLinks.slice(i, i + BB_BATCH).map(async (link) => {
            const from = devMap[String(link.from)], to = devMap[String(link.to)];
            if (!from || !to) return;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            try {
              const res = await fetch('http://localhost:8000/api/route', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ a: { lat: from.lat, lng: from.lng }, b: { lat: to.lat, lng: to.lng },
                  link_id: `${link.from}-${link.to}`, link_type: link.type || 'generic' }),
                signal: ctrl.signal,
              });
              if (!res.ok) throw new Error(res.status);
              const coords = await res.json();
              updateLiveRouteInMap(link.id, link.type || 'generic', coords.map(([lat, lng]) => [lng, lat]),
                { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
            } catch {
              updateLiveRouteInMap(link.id, 'generic', [[from.lng, from.lat], [to.lng, to.lat]],
                { from: link.from, to: link.to, fromName: from.name, toName: to.name, isInfra: true });
            } finally {
              clearTimeout(timer);
            }
          })
        );
      }
      refreshFilters();


      let _showMarkersTimer = null;

      map.on('zoomend', () => {
        clearTimeout(_showMarkersTimer);
        const zoom = map.getZoom();
        if (zoom < 12) { hideMarkers(); return; }
        // fetchViewportData is already registered as a moveend/zoomend listener above
        // for data; this handler is solely responsible for DOM marker visibility.
        _showMarkersTimer = setTimeout(showMarkers, 50);
      });

      map.on('moveend', () => {
        if (map.getZoom() < 12) return;
        clearTimeout(_showMarkersTimer);
        _showMarkersTimer = setTimeout(showMarkers, 80);
      });


      map.on('click', (e) => {
        const interactiveLayers = ['unclustered-main-devices', 'unclustered-devices'];
        const activeLayers = interactiveLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
        
        if (activeLayers.length > 0) {
          const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
          if (features.length > 0) return; 
        }

        if (e.originalEvent.target.tagName.toLowerCase() !== 'canvas') return;
        
        clearCustomerRoute();
        focusedDeviceIdRef.current = null;
        clearUpstreamPath();
        if (map.getZoom() >= 12) { showMarkers(); } 
        else { hideMarkers(); }
        refreshFilters();
      });

    } catch (err) {
      console.error('🔴 Map load failed at:', err);
    }
  });
  return () => {
    isMounted = false;
    
    if (liveRouteUpdateTimeout.current) {
      clearTimeout(liveRouteUpdateTimeout.current);
    }

    // Safely remove HTML markers from DOM
    for (const marker of activeMarkersRef.current.values()) {
      marker.remove();
    }
    activeMarkersRef.current.clear();

    // Destroy MapLibre context
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }
  };
}, []);

  return (
    <div className='relative'>
      <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
    </div>
  );
}
