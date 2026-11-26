// Netlify adapter: converts a Netlify event into the Express-like req/res the original code expects.
const { api } = require('../lib/_core');

exports.handler = async (event) => {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  let parsed = {};
  if (body && (headers['content-type'] || '').includes('application/json')) {
    try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
  }

  // Original code expects paths like /api/products
  let path = event.path || '/';
  path = path.replace(/^\/\.netlify\/functions\/[^/]+/, '/api');
  if (!path.startsWith('/api')) path = '/api' + path;

  const req = {
    method: event.httpMethod,
    path,
    body: parsed,
    query: event.queryStringParameters || {},
    protocol: (headers['x-forwarded-proto'] || 'https').split(',')[0].trim(),
    get: (name) => headers[String(name).toLowerCase()]
  };

  return await new Promise((resolve) => {
    let statusCode = 200;
    const res = {
      status(code) { statusCode = code; return res; },
      json(data) {
        resolve({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      },
      send(data) {
        resolve({ statusCode, headers: { 'Content-Type': 'text/plain' }, body: String(data ?? '') });
      }
    };
    Promise.resolve(api(req, res)).catch((e) => {
      resolve({
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: e.message || 'Server error.' })
      });
    });
  });
};
