'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Contact {
  email: string;
  phoneNumber: string | null;
  notificationEmail: string | null;
}

type Policy = Record<string, string[]>;

const CHANNEL_LABELS: Record<string, string> = {
  apns: 'iPhone push',
  call: 'Phone call',
  sms: 'SMS',
  email: 'Email',
  emergency: 'iPhone emergency alert',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export default function SettingsPage() {
  const router = useRouter();
  const [contact, setContact] = useState<Contact | null>(null);
  const [policy, setPolicy] = useState<Policy>({});
  const [fallbackChannel, setFallbackChannel] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [notificationEmail, setNotificationEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fetchContact = useCallback(async () => {
    try {
      const response = await fetch('/api/contact');
      if (response.ok) {
        const data = await response.json();
        setContact(data.contact);
        setPolicy(data.policy ?? {});
        setFallbackChannel(data.fallbackChannel ?? null);
        setPhoneNumber(data.contact.phoneNumber ?? '');
        setNotificationEmail(data.contact.notificationEmail ?? '');
      } else if (response.status === 401) {
        router.push('/login');
      }
    } catch (err) {
      console.error('Error fetching contact details:', err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchContact();
  }, [fetchContact]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/contact', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, notificationEmail }),
      });
      const data = await response.json();
      if (response.ok) {
        setContact(data.contact);
        setPhoneNumber(data.contact.phoneNumber ?? '');
        setNotificationEmail(data.contact.notificationEmail ?? '');
        setSaved(true);
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch (err) {
      console.error('Error saving contact details:', err);
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const phoneMissing = !contact?.phoneNumber;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <h1 className="text-xl font-bold">AlertTray Dashboard</h1>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <Link
                  href="/dashboard"
                  className="border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  API Keys
                </Link>
                <Link
                  href="/settings"
                  className="border-indigo-500 text-gray-900 inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium"
                >
                  Delivery Settings
                </Link>
              </div>
            </div>
            <div className="flex items-center">
              <button
                onClick={handleLogout}
                className="text-gray-500 hover:text-gray-700 px-3 py-2 rounded-md text-sm font-medium"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0 space-y-6">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h2 className="text-lg font-medium text-gray-900">Contact details</h2>
              <p className="mt-2 text-sm text-gray-700">
                Where phone calls, SMS and emails are sent. Account email: <span className="font-mono">{contact?.email}</span>
              </p>

              {phoneMissing && (
                <div className="mt-4 rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
                  No phone number set — high and critical alerts cannot call or text you
                  {fallbackChannel ? ` and will fall back to ${CHANNEL_LABELS[fallbackChannel] ?? fallbackChannel}` : ''}.
                </div>
              )}

              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
                    Phone number (for calls &amp; SMS)
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    placeholder="+14155552671"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">International format with country code. Leave blank to disable.</p>
                </div>
                <div>
                  <label htmlFor="notificationEmail" className="block text-sm font-medium text-gray-700">
                    Alert email (optional)
                  </label>
                  <input
                    id="notificationEmail"
                    type="email"
                    placeholder={contact?.email}
                    value={notificationEmail}
                    onChange={(e) => setNotificationEmail(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">Defaults to your account email.</p>
                </div>
              </div>

              {error && (
                <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}
              {saved && !error && (
                <div className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700">Saved.</div>
              )}

              <div className="mt-6">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h2 className="text-lg font-medium text-gray-900">Delivery by severity</h2>
              <p className="mt-2 text-sm text-gray-700">
                Every notification is pushed to your registered iPhones. Depending on severity it is also delivered via:
              </p>
              <div className="mt-4 overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                <table className="min-w-full divide-y divide-gray-300">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Severity</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Channels</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {SEVERITY_ORDER.filter((s) => s in policy).map((severity) => (
                      <tr key={severity}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 capitalize">
                          {severity}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-700">
                          {['apns', ...policy[severity]].map((c) => CHANNEL_LABELS[c] ?? c).join(', ')}
                          {severity === 'critical' && (
                            <span className="ml-2 text-xs text-gray-400">(iPhone emergency alert coming soon)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
