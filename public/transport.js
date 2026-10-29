// @ts-check
/**
 * How app.js reaches the API. In the browser that is plain fetch to the Node server. The
 * Android build replaces this file with mobile/web/transport.js, which answers the same
 * /api/* requests on the device.
 */

/**
 * @param {string} url  an /api/* path with its query
 * @param {RequestInit} [init]
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<any>}>}
 */
export function apiFetch(url, init) {
  return fetch(url, init);
}
