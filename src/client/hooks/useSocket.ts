import { useEffect, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';

export function useSocket(): Socket {
  const socket = useMemo(() => io(), []);

  useEffect(() => {
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  return socket;
}
