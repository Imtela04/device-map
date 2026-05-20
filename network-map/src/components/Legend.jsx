import { LINKS } from "../data/networkData";

const linkTypes = Object.values(
    LINKS.reduce((accumulator, currentItem) => {
  accumulator[currentItem.type] = accumulator[currentItem.type] || { type: currentItem.type, color: currentItem.color };
  return accumulator;
}, {})
);

const dashMap = {
  copper: '6 4',
  wireless: '3 6',
  fiber: null,
};

export default function Legend(){
    return(
        <div className="absolute bottom-10 right-4 bg-white p-3 rounded shadow text-sm z-[99999]">
            {linkTypes.map((link)=>(
                <div className='flex items-center gap-2' key={link.type}>
                    <svg width="32" height="12">
                        <line x1="0" y1="6" x2="32" y2="6" stroke={link.color} strokeWidth="2" strokeDasharray={dashMap[link.type]} />
                    </svg>
                    <span>{link.type[0].toUpperCase()+link.type.slice(1)}</span>
                </div>
            ))}
        </div>
    );
}