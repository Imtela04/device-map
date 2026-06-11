import { useNetworkMap } from '../hooks/useNetworkMap';

export default function NetworkMap() {
  const { mapRef } = useNetworkMap();
  return (
    <div className='relative'>
      <div ref={mapRef} style={{ height: '100vh', width: '100%' }} />
    </div>
  );
}