import { Router, Server, Network, GitFork, Radio } from 'lucide-react';

const deviceConfig = {
  'core-router': { icon: Network,     color: '#ef4444' },
  'router':      { icon: Router,      color: '#3b82f6' },
  'switch':      { icon: GitFork,     color: '#f59e0b' },
  'edge-router': { icon: Radio,       color: '#8b5cf6' },
  'server':      { icon: Server,      color: '#22c55e' },
};

export default function DeviceIcon({ type }) {
    const { icon: Icon, color } = deviceConfig[type] || deviceConfig['router'];
    
    return (
        <div style={{ background: color }} className="p-1 rounded-full">
            <Icon size={16} color="white" />
        </div>
    );
}