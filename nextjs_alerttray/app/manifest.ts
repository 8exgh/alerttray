import type { MetadataRoute } from 'next';

/**
 * Web app manifest: lets AlertTray be added to the iPhone home screen (and
 * installed elsewhere) as a standalone app that opens on the inbox. Web Push
 * on iOS (16.4+) only works from such an installed home-screen app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/inbox',
    name: 'AlertTray',
    short_name: 'AlertTray',
    description: 'Your alerts, as notifications, with a scrollable history.',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f9fafb',
    theme_color: '#4f46e5',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
