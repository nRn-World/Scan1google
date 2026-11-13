export const DEFAULT_CLOUD_API_URL =
  'https://ais-pre-ncnoznyjxu2f7hwmclvldu-505178481153.europe-west2.run.app';

export function isNativeCapacitorApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    return true;
  }
  return window.location.protocol === 'capacitor:';
}

export function getApiBaseUrl(): string {
  if (isNativeCapacitorApp()) {
    return DEFAULT_CLOUD_API_URL;
  }
  return '';
}

export function getApiEndpoint(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
}
