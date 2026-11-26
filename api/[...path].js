const { api } = require('../netlify/lib/_core');

module.exports = async (req, res) => {
  req.path = new URL(req.url, 'https://vercel.local').pathname;
  req.protocol = req.headers['x-forwarded-proto'] || 'https';
  req.get = (name) => req.headers[String(name).toLowerCase()];

  try {
    await api(req, {
      status(code) {
        res.statusCode = code;
        return this;
      },
      json(data) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      },
      send(data) {
        res.setHeader('Content-Type', 'text/plain');
        res.end(String(data ?? ''));
      }
    });
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error.message || 'Server error.' }));
  }
};
