'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isStandalone } from '@/lib/pwa/push-client';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // The installed app (PWA mode) lives in the inbox; the inbox sends signed-out users to login.
    router.replace(isStandalone() ? '/inbox' : '/login');
  }, [router]);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-gray-500">Redirecting...</div>
    </div>
  );
}