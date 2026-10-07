// Shared by the service worker and the popup so a saved broker URL and a sent
// capture are checked by exactly one predicate. Importable in plain Node.
export const REMOTE_INGEST_URL = 'https://twinbrowser.bbos.tech/work-edge/ingest';
export const REMOTE_CHAT_URL = 'https://twinbrowser.bbos.tech/work-edge/chat';
export const REMOTE_WS_URL = 'wss://twinbrowser.bbos.tech/work-edge/ws';
const REMOTE_ORIGIN = 'https://twinbrowser.bbos.tech';

// A local broker must spell out its port in the URL itself: URL.port normalizes
// an explicit ":80" away to '', so the raw string is the only place the source
// port survives. Anchored end to end, so the path may be "/" or anything deeper
// but never carries credentials, a query, a fragment, or whitespace.
const LOCAL_BROKER_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/[^\s?#]*$/;

export function validateBrokerUrl(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return false;
  if (normalizeBrokerUrl(value) === REMOTE_INGEST_URL) return true;
  const match = LOCAL_BROKER_URL.exec(value);
  if (!match) return false;
  let target;
  try { target = new URL(value); } catch { return false; }
  if (target.protocol !== 'http:' || target.username || target.password) return false;
  if (target.hostname !== '127.0.0.1' || target.search || target.hash) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

export function normalizeBrokerUrl(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return value;
  if (value === REMOTE_ORIGIN || value === `${REMOTE_ORIGIN}/` || value === `${REMOTE_ORIGIN}/work-edge`) return REMOTE_INGEST_URL;
  return value;
}

// Pairing is available only on the same pinned broker. This function is never
// given user-controlled path components, queries, fragments, or credentials.
export function pairingExchangeUrl(brokerUrl) {
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) return null;
  if (brokerUrl === REMOTE_INGEST_URL) return 'https://twinbrowser.bbos.tech/work-edge/pair/exchange';
  const target = new URL(brokerUrl);
  return `${target.origin}/pair/exchange`;
}

// Chat is always sent to the fixed broker route. The saved ingest URL is used
// only to pin the permitted broker origin; no user-supplied path is reused.
export function chatEndpointUrl(brokerUrl) {
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) return null;
  if (brokerUrl === REMOTE_INGEST_URL) return REMOTE_CHAT_URL;
  return `${new URL(brokerUrl).origin}/work-edge/chat`;
}

export function websocketEndpointUrl(brokerUrl) {
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) return null;
  if (brokerUrl === REMOTE_INGEST_URL) return REMOTE_WS_URL;
  const target = new URL(brokerUrl);
  return `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}/work-edge/ws`;
}

export function verifiedActionEndpointUrl(brokerUrl, action) {
  brokerUrl = normalizeBrokerUrl(brokerUrl);
  if (!validateBrokerUrl(brokerUrl)) return null;
  if (!['pending', 'approve', 'reject'].includes(action)) return null;
  return `${new URL(brokerUrl).origin}/work-edge/verified-actions/${action}`;
}
