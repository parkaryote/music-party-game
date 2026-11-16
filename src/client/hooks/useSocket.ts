import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

// One connection for the whole app. Creating it at module scope (instead of inside a
// component) keeps React StrictMode's double-mount in development from tearing it down.
const socket: Socket = io({ autoConnect: false });

export function useSocket(): { socket: Socket; connected: boolean } {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return { socket, connected };
}
