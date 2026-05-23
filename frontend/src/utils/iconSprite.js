

const deviceIcons = {
  'core-router': {
    color: '#e98686',
    svg: `<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>`
  },
  'router': {
    color: '#8cb5f7',
    svg: `<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>`
  },
	'switch': {
    color: '#fad086',
    svg: `<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>`
	},
  'edge-router': {
    color: '#bea8f0',
    svg: `<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>`
  },
  'server': {
    color: '#81d19e',
    svg: `<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`
  },
};


export async function loadDeviceIcons(map) {
    return Promise.all(
        Object.entries(deviceIcons).map(([type, { color, svg }]) => {
            const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;
            return loadIcon(map, type, color, svgString);
        })
    );
}

function loadIcon(map, name, color, svgString) {
    return new Promise((resolve) => {
        const img = new Image(32, 32);
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d');
            // draw colored circle background
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(16, 16, 15, 0, Math.PI * 2);
            ctx.fill();
						ctx.strokeStyle = 'grey';
						ctx.lineWidth = 2;
						ctx.setLineDash([10,5]);
						ctx.stroke();


            // draw icon
            ctx.drawImage(img, 8, 8, 16, 16);
            map.addImage(name, {
                width: 32,
                height: 32,
                data: ctx.getImageData(0, 0, 32, 32).data
            });
            URL.revokeObjectURL(url);
            resolve();
        };
        img.src = url;
    });
}