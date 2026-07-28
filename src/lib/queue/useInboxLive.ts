'use client';

import { useEffect, useRef, useState } from 'react';

export type InboxLiveStatus = 'connecting' | 'live' | 'offline';

export function useInboxLive(onChange: () => void): InboxLiveStatus {
  const [status, setStatus] = useState<InboxLiveStatus>('connecting');
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const source = new EventSource('/api/inbox/stream');

    const markLive = () => setStatus('live');
    source.addEventListener('ready', markLive);
    source.addEventListener('heartbeat', markLive);
    source.addEventListener('change', () => {
      setStatus('live');
      onChangeRef.current();
    });
    source.onerror = () => setStatus('offline');

    return () => source.close();
  }, []);

  return status;
}
