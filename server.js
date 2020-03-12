#!/usr/bin/env node
const express = require('express');
const server = express();

server.all('/*', (request, res) => {
  // You would probably not want to hard-code this,
  // but make it a command line argument.
  if(request.url.startsWith('/node_modules/monaco-editor-core/node_modules')) {
    request.url = request.url.substring('/node_modules/monaco-editor-core/'.length - 1)
  }
  if(request.url.startsWith('/node_modules/monaco-editor-core//node_modules')) {
    request.url = request.url.substring('/node_modules/monaco-editor-core/'.length)
  }
  if(request.url.startsWith('/node_modules/monaco-editor-core/out')) {
    request.url = '/out/' + request.url.substring('/node_modules/monaco-editor-core/out'.length)
  }
  res.sendFile(__dirname + request.url);
});

const port = 8000;
server.listen(port, () => {
  console.log('Server listening on port', port);
});
