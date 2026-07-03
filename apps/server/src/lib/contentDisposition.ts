/**
 * Build a `Content-Disposition` header value that is safe for non-ASCII filenames.
 *
 * HTTP header values must be ASCII (RFC 7230); a raw Cyrillic filename such as
 * "Интернет-магазин.zip" throws `ERR_INVALID_CHAR` when set as a header value.
 * Per RFC 6266 we emit BOTH a sanitized ASCII `filename=` token (legacy clients)
 * and an RFC 5987 `filename*=UTF-8''<percent-encoded>` token (modern browsers,
 * which prefer it and recover the original UTF-8 name).
 */
export function contentDisposition(filename: string): string {
  // ASCII fallback: any non-printable-ASCII char (incl. control chars, which are
  // outside 0x20–0x7e) plus quote/backslash become '_' so the token stays header-safe.
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 value-chars: percent-encode UTF-8 bytes. encodeURIComponent covers
  // most of it; also escape the extra chars it leaves literal (' ( ) *).
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
