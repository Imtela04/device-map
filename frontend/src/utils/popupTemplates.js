import { INFRA, TIER_SPEED } from './mapConstants';

export function buildLinkPopupHTML({ fromName, toName, tier, tierColor, tierLabel, linkStatus, linkColor, linkId }) {
  return `
    <div style="font-family:system-ui,sans-serif;padding:6px 8px;min-width:210px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <strong style="font-size:13px;color:#1e293b;">Infrastructure Link</strong>
        <span style="font-size:10px;padding:2px 7px;border-radius:10px;
              background:${tierColor}22;color:${tierColor};font-weight:700;text-transform:uppercase;">
          ${tierLabel}
        </span>
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        <span style="width:7px;height:7px;border-radius:50%;background:${linkColor};flex-shrink:0;"></span>
        ${linkStatus[0].toUpperCase() + linkStatus.slice(1)}
        &nbsp;·&nbsp; ${TIER_SPEED[tier] || '100G Backbone'}
      </div>
      <div style="border-top:1px solid #f1f5f9;padding-top:6px;display:grid;gap:4px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">From</span><strong style="color:#1e293b;">${fromName}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">To</span><strong style="color:#1e293b;">${toName}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">Link ID</span>
          <strong style="color:#475569;font-family:monospace;font-size:10px;">#${linkId}</strong>
        </div>
      </div>
    </div>`;
}

export function buildCustomerPopupHTML({ customerDev, upstreamDev, statusColor, statusLabel, p }) {
  return `
    <div style="font-family:system-ui,sans-serif;padding:6px 8px;min-width:210px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <strong style="font-size:13px;color:#1e293b;">${customerDev?.name || p.toName || 'Customer'}</strong>
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:${statusColor};">
          <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
          ${statusLabel}
        </span>
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">
        Access Link &nbsp;·&nbsp; ${TIER_SPEED['access']}
      </div>
      <div style="border-top:1px solid #f1f5f9;padding-top:6px;display:grid;gap:4px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">Upstream OLT</span>
          <strong style="color:#1e293b;">${upstreamDev?.name || p.fromName || '—'}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">Link ID</span>
          <strong style="color:#475569;font-family:monospace;font-size:10px;">#${p.id}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;">
          <span style="color:#94a3b8;">Port Type</span>
          <strong style="color:#475569;">${(p.fromType || p.toType || 'fiber').replace(/-/g,' ')}</strong>
        </div>
      </div>
    </div>`;
}

export function buildDevicePopupHTML(dev, connectedLinks, devMap) {
  let statsHtml = '';

  if (dev.safeType === 'olt') {
    const customerCount = connectedLinks.filter(l => {
      const otherId = String(l.from) === String(dev.id) ? String(l.to) : String(l.from);
      return !INFRA.has(devMap[otherId]?.safeType);
    }).length;
    statsHtml = `
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;">
        <span style="color:#64748b;">Downstream ONTs:</span>
        <strong style="color:#10b981;">${customerCount} Units</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px;">
        <span style="color:#64748b;">Uplink Port:</span>
        <strong style="color:#3b82f6;">10G SFP+</strong>
      </div>`;
  } else if (dev.safeType === 'edge-router') {
    const oltCount = connectedLinks.filter(
      l => devMap[String(l.to)]?.safeType === 'olt' || devMap[String(l.from)]?.safeType === 'olt'
    ).length;
    statsHtml = `
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;">
        <span style="color:#64748b;">Subtended OLTs:</span>
        <strong style="color:#2563eb;">${oltCount} Active Hubs</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px;">
        <span style="color:#64748b;">Core Link:</span>
        <strong style="color:#10b981;">100G Primary</strong>
      </div>`;
  } else if (dev.safeType === 'core-router') {
    statsHtml = `
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:12px;">
        <span style="color:#64748b;">Mesh Topology:</span>
        <strong style="color:#9333ea;">Active Backbone</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px;">
        <span style="color:#64748b;">Path Redundancy:</span>
        <strong style="color:#10b981;">Active / Active</strong>
      </div>`;
  }

  return `
    <div style="font-family:system-ui,sans-serif;padding:4px;min-width:180px;">
      <h4 style="margin:0;font-size:14px;color:#1e293b;">${dev.name}</h4>
      <p style="margin:2px 0 8px 0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">
        ${(dev.type || '').replace('-', ' ')}
      </p>
      <div style="padding-top:6px;border-top:1px solid #e2e8f0;">
        ${statsHtml}
      </div>
    </div>`;
}