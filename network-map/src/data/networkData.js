export const DEVICES = [
          { id:'core-1',  name:'Core Router Alpha',   lat:23.7269, lng:90.4193 },
          { id:'dist-1',  name:'Router Beta',         lat:23.7808, lng:90.4147 },
          { id:'dist-2',  name:'Router Gamma',        lat:23.7465, lng:90.3740 },
          { id:'sw-1',    name:'Switch Delta',        lat:23.8069, lng:90.3666 },
          { id:'edge-1',  name:'Edge Router Epsilon', lat:23.8759, lng:90.3795 },
          { id:'srv-1',   name:'Server Node Zeta',    lat:23.7155, lng:90.4220 },
        ];

export const LINKS = [
    { id:'l1', from:'core-1', to:'dist-1',  type:'fiber',    color:'#22d3ee' },
    { id:'l2', from:'core-1', to:'dist-2',  type:'fiber',    color:'#22d3ee' },
    { id:'l3', from:'dist-1', to:'sw-1',    type:'copper',   color:'#f59e0b' },
    { id:'l4', from:'sw-1',   to:'edge-1',  type:'fiber',    color:'#22d3ee' },
    { id:'l5', from:'core-1', to:'srv-1',   type:'copper',   color:'#f59e0b' },
    { id:'l6', from:'dist-2', to:'sw-1',    type:'wireless', color:'#22c55e' },
];