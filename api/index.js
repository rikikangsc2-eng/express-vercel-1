const app = require('express')();

app.get('/blackbox',require('/AI/blackbox.js'))

app.get('/', (req, res) => {
  res.end("Gomen Amanai")
  });

module.exports = app;
