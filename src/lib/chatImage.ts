/** Only embedded raster images: no network requests, filesystem access or SVG. */
export function chatImageSource(mimeType: string, data: string): string | null {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) return null;
  // Bound base64 to 8 MiB (~6 MiB decoded). Validate before constructing a URL.
  if (!data || data.length > 8 * 1024 * 1024 || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  return `data:${mimeType};base64,${data}`;
}
