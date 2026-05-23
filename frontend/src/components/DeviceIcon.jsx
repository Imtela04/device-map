import { Router, Server, Network, GitFork, Radio } from 'lucide-react';
import { DEVICE_COLORS } from '../data/networkData';
const deviceConfig = {
  'core-router': { icon: Network,     color:DEVICE_COLORS['core-router'] },
  'router':      { icon: Router,      color:DEVICE_COLORS['router'] },
  'switch':      { icon: GitFork,     color: DEVICE_COLORS['switch'] },
  'edge-router': { icon: Radio,       color: DEVICE_COLORS['edge-router'] },
  'server':      { icon: Server,      color: DEVICE_COLORS['server'] },
};

export default function DeviceIcon({ type }) {
    const { icon: Icon, color } = deviceConfig[type] || deviceConfig['router'];
    
    return (
        <div style={{ background: color }} className="p-1 rounded-full">
            <Icon size={16} color="white" />
        </div>
    );
}