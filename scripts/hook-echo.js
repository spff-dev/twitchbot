'use strict';
const http = require('http');

const PORT = 18081;
const PATH = '/hooks/twitchbot';

const srv = http.createServer((req, res) => {
  if (req.url !== PATH) {
    res.statusCode = 404;
    return res.end('no');
  }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    console.log('[WH/TEST] req', req.method, req.url, 'len', body.length);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('hook-ok');
  });
});

srv.listen(PORT, '127.0.0.1', () => {
  console.log('[WH/TEST] listening 127.0.0.1:' + PORT);
});
