var app = require('express')();
var http = require('http');
var server = http.createServer(app);

var WebSocket = require('ws');
var wss = new WebSocket.Server({ server });

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const RssFeedEmitter = require('rss-feed-emitter');
const feeder = new RssFeedEmitter();

const request = require('request');

const API_ENDPOINT = 'http://localhost:4000/feeds.json';
const WEBSOCKET_PORT = 63409;

const adapter = new FileSync('db.json');
const db = low(adapter);

// Globals
let connectMessage;
let newItem;
let updatingFeeds;
let cacheTimeout;

function updateFeeds () {
  // Stop updateCache() recursion
  clearTimeout(cacheTimeout);

  updatingFeeds = true;

  // Clear db
  db.unset('log')
    .write()
  
  // Set some defaults
  db.defaults({ log: [] })
    .write();

  // Remove all feeds
  feeder.destroy();

  // Fetch endpoint .json
  request({
    url: API_ENDPOINT,
    json: true
    },
    function (error, response, body) {
      body.forEach(feed => {
        // Add all feeds
        feeder.add({
          url: feed
        });
      });
      // Give feeder some time to fetch all feeds
      cacheTimeout = setTimeout(() => {
        // Allow sending to clients again
        updatingFeeds = false;
        
        updateCache();
      }, 60000);
    }
  );
  // Update feeds daily
  setTimeout(() => {
    updateFeeds();
  }, 24 * 60 * 60 * 1000);
}

function updateCache () {
  if (newItem) {
    const entries = db.get('log')
                      .sortBy('date')
                      .takeRight(25)
                      .value();
    connectMessage = JSON.stringify(entries);

    // Wait for another new item first
    newItem = false;
  }
  // Start recursion
  cacheTimeout = setTimeout(() => {
    updateCache();
  }, 30000);
}

feeder.on('new-item', item => {
  // Skip already existing links
  const link = db.get('log')
                 .find({ link: item.link })
                 .value()
  if (link) {
    return;
  }
  // Push to db
  db.get('log')
    .push({ title: item.title, date: item.date, link: item.link})
    .write()
  
  // Send to all connected clients immediately
  if (!updatingFeeds) {
    wss.clients.forEach(function(client) {
      if (client.readyState === WebSocket.OPEN ) {
        client.send(JSON.stringify([{
          title: item.title,
          date: item.date,
          link: item.link
        }]));
      }
    });
  }
  // Allow cache to be updated
  newItem = true;
});

wss.on('connection', function(socket) {
  console.log('a user connected');
  if (socket.readyState === WebSocket.OPEN) {
    if (connectMessage) {
      socket.send(connectMessage);
    }
    else {
      // On launch connectMessage might still be empty
      socket.send(JSON.stringify([{
        title: "Server ist gerade beschäftigt, bitte Seite neu laden",
        date: new Date().toISOString(),
        link: "/"
      }]));
    }
  }

  socket.on('message', function(message) {
    if (message === 'ping' && socket.readyState === WebSocket.OPEN) {
      socket.send('pong');
    }
  });

  socket.on('close', function() {
    console.log('user disconnected');
  });
});

server.listen(WEBSOCKET_PORT, function() {
  console.log(`listening on *:${WEBSOCKET_PORT}`);
});
// Kickstart
updateFeeds();
