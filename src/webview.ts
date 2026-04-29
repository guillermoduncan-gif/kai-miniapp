import express from 'express';

export function addWebviewRoute(app: express.Express) {
  app.get('/webview', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KAI</title>
  <style>
    body { background: #000; color: #fff; font-family: sans-serif; 
           display: flex; align-items: center; justify-content: center; 
           height: 100vh; margin: 0; flex-direction: column; }
    h1 { font-size: 2.5em; margin-bottom: 8px; }
    p { opacity: 0.6; font-size: 1.1em; }
  </style>
</head>
<body>
  <h1>🤖 KAI</h1>
  <p>Voice AI is active.</p>
  <p>Speak to your glasses.</p>
</body>
</html>`);
  });
}
