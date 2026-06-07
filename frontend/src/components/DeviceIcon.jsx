import { Router, Server, Network, GitFork, Radio } from 'lucide-react';

// Define Tailwind background classes instead of hex codes
const deviceConfig = {
  'core-router': { icon: Network,  bgClass: 'bg-purple-600' },
  'router':      { icon: Router,   bgClass: 'bg-green-500' },
  'switch':      { icon: GitFork,  bgClass: 'bg-emerald-500' },
  'edge-router': { icon: Radio,    bgClass: 'bg-orange-500' },
  'server':      { icon: Server,   bgClass: 'bg-slate-600' },
  'olt':         { icon: Server,   bgClass: 'bg-teal-500' }, 
};

export default function DeviceIcon({ type }) {
    const { icon: Icon, bgClass } = deviceConfig[type?.toLowerCase()] || deviceConfig['router'];
    
    return (
        <div className={`${bgClass} p-1 rounded-full shadow-sm border border-white`}>
            <Icon size={16} color="white" />
        </div>
    );
}