import { Router, Server, Network, GitFork, Radio } from 'lucide-react';
import { DEVICE_COLORS } from '../data/networkData';

const deviceConfig = {
  'core-router': { icon: Network,     color: DEVICE_COLORS['core-router'] },
  'router':      { icon: Router,      color: DEVICE_COLORS['router'] },
  'switch':      { icon: GitFork,     color: DEVICE_COLORS['switch'] },
  'edge-router': { icon: Radio,       color: DEVICE_COLORS['edge-router'] },
  'server':      { icon: Server,      color: DEVICE_COLORS['server'] },
  'olt':         { icon: Server,      color: DEVICE_COLORS['olt'] || '#14b8a6' },
};

export default function DeviceIcon({ type }) {
    // If the type is totally unrecognized, it falls back to a standard router
    const { icon: Icon, color } = deviceConfig[type.toLowerCase()] || deviceConfig['router'];
    
    return (
        <div style={{ background: color }} className="p-1 rounded-full shadow-sm border border-white">
            <Icon size={16} color="white" />
        </div>
    );
}