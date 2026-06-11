export const INFRA = new Set(['core-router', 'router', 'edge-router', 'olt', 'server', 'switch']);

export const STATUS_COLOR = {
  online:   '#22c55e',
  degraded: '#f59e0b',
  down:     '#ef4444',
};

export const DEVICE_LEVEL = {
  'core-router': 4, 'router': 4, 'switch': 4, 'server': 4,
  'edge-router': 3, 'olt': 2, 'access': 1,
};

export const TIER = {
  access: 0, olt: 1, 'edge-router': 2, 'core-router': 3,
};

export const TIER_COLOR = {
  core:   '#4f46e5',
  edge:   '#0891b2',
  olt:    '#7c3aed',
  access: '#c4b5fd',
};

export const TIER_SPEED = {
  core:   '100G Backbone',
  edge:   '10G Uplink',
  olt:    '1G Aggregation',
  access: '1G GPON',
};