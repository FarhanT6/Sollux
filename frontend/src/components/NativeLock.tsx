import { useCallback, useEffect, useRef, useState } from 'react';
import { isNative } from '../lib/native';

/**
 * On the phone: a Face ID (or passcode) lock when Sollux opens or comes back
 * after a minute away, if the owner turned it on in Settings; and, always, a
 * cover over the screen while the app is in the background so the app
 * switcher's snapshot shows nothing. On the web it renders nothing.
 */
const KEY = 'sollux.faceIdLock';
const AWAY_MS = 60 * 1000;

export const faceIdLockEnabled = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

/** Whether this phone can use Face ID / Touch ID, and its name for the setting. */
export async function biometryName(): Promise<string | null> {
  if (!isNative) return null;
  try {
    const { BiometricAuth, BiometryType } = await import('@aparajita/capacitor-biometric-auth');
    const r = await BiometricAuth.checkBiometry();
    if (!r.isAvailable && !r.deviceIsSecure) return null;
    return r.biometryType === BiometryType.faceId ? 'Face ID' : r.biometryType === BiometryType.touchId ? 'Touch ID' : 'your passcode';
  } catch { return null; }
}

export async function authenticate(reason: string): Promise<boolean> {
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({ reason, cancelTitle: 'Cancel', allowDeviceCredential: true, iosFallbackTitle: 'Use passcode' });
    return true;
  } catch { return false; }
}

/** Turning the lock on asks for Face ID first, so it cannot lock the owner out. */
export async function setFaceIdLock(on: boolean): Promise<boolean> {
  if (on && !(await authenticate('Turn on the Sollux lock'))) return false;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { return false; }
  return true;
}

export default function NativeLock() {
  const [locked, setLocked] = useState(() => isNative && faceIdLockEnabled());
  const [covered, setCovered] = useState(false);
  const [trying, setTrying] = useState(false);
  const leftAt = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    if (trying) return;
    setTrying(true);
    const ok = await authenticate('Unlock Sollux');
    setTrying(false);
    if (ok) setLocked(false);
  }, [trying]);

  useEffect(() => {
    if (!isNative) return;
    let remove: (() => void) | undefined;
    (async () => {
      const { App } = await import('@capacitor/app');
      const h = await App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) { leftAt.current = Date.now(); setCovered(true); return; }
        setCovered(false);
        if (faceIdLockEnabled() && leftAt.current && Date.now() - leftAt.current > AWAY_MS) setLocked(true);
      });
      remove = () => h.remove();
    })();
    return () => remove?.();
  }, []);

  useEffect(() => { if (locked) void unlock(); }, [locked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isNative || (!locked && !covered)) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4" style={{ background: '#1e1e1e' }}>
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: '#F5A623' }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1e1e1e" strokeWidth="2"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
      </div>
      <p className="text-white font-semibold">Sollux</p>
      {locked && !covered && (
        <button onClick={unlock} disabled={trying} className="btn btn-primary text-sm px-6">{trying ? 'Checking…' : 'Unlock'}</button>
      )}
    </div>
  );
}
