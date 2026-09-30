const DB_NAME = 'openrocket-onshape-preferences';
const STORE_NAME = 'preferences';
const AUTO_DOWNLOAD_KEY = 'autoDownloadJson';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open preference storage.'));
  });
}

export async function getAutoDownloadPreference(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(AUTO_DOWNLOAD_KEY);
      request.onsuccess = () => resolve(request.result === true);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

export async function setAutoDownloadPreference(enabled: boolean): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(enabled, AUTO_DOWNLOAD_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // A private browsing policy may block IndexedDB; the current session still works.
  }
}

export function shouldAutoDownload(warnings: Array<{ severity: string }>): boolean {
  return !warnings.some((warning) => ['error', 'high', 'medium'].includes(warning.severity));
}
