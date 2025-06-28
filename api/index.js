const app = require('express')();

app.use('/blackbox',require('/AI/blackbox.js'))

app.get('/', (req, res) => {
  res.end("Gomen Amanai")
  });

module.exports = app;
