// The response with a new body. Its length and encoding headers described the old one.
export function withBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
