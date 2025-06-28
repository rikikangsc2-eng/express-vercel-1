const app = require('express')();

app.get('/', (req, res) => {
  res.end("Gomen Amanai")
  });

module.exports = app;
