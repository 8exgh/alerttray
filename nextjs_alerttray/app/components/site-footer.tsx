/**
 * Site-wide footer with attribution links. Plain, crawlable anchors
 * (no rel="nofollow") so both credits count as proper backlinks.
 */
export default function SiteFooter() {
  return (
    <footer className="border-t border-gray-200 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 text-center text-xs text-gray-500">
        Created by{' '}
        <a
          href="https://8examples.com"
          className="font-medium text-gray-700 underline underline-offset-2 hover:text-gray-900"
        >
          8examples.com
        </a>
        <span className="mx-2 text-gray-300" aria-hidden="true">·</span>
        Hosted by{' '}
        <a
          href="https://swiftgrid.net"
          className="font-medium text-gray-700 underline underline-offset-2 hover:text-gray-900"
        >
          SwiftGrid.net
        </a>
      </div>
    </footer>
  );
}
