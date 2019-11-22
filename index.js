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
const crypto = require('crypto');

const API_ENDPOINT = 'http://localhost:4000/feeds.json';
const WEBSOCKET_PORT = 63409;

const adapter = new FileSync('db.json');
const db = low(adapter);

// Globals
let connectMessage;
let updatingFeeds;
let cacheTimeout;
let feedsHash;

function updateFeeds () {
  updatingFeeds = true;

  // Fetch endpoint .json
  request({
    url: API_ENDPOINT,
    json: true
    },
    function (error, response, body) {
      const md5 = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex');
      if (md5 !== feedsHash) {
        feedsHash = md5;

        // Clear db
        db.unset('log')
          .write()

        // Set some defaults
        db.defaults({ log: [] })
          .write();

        // Remove all feeds
        feeder.destroy();

        // Add all feeds
        body.forEach(feed => {
          feeder.add({
            url: feed
          });
        });
        // Let's assume updating all feeds is finished after 120s
        setTimeout(() => {
          updatingFeeds = false;
        }, 120000);
      }
    }
  );
  // Update feeds every hour
  setTimeout(() => {
    updateFeeds();
  }, 60 * 60 * 1000);
}

function updateCache () {
  const entries = db.get('log')
                    .sortBy('date')
                    .takeRight(25)
                    .value();
  connectMessage = JSON.stringify(entries);
}

function removeTags (string) {
  return string.replace(/<(?:.|\n)*?>/gm, '').trim()
}

feeder.on('new-item', item => {
  // Skip already existing links
  const link = db.get('log')
                 .find({ link: item.link })
                 .value()
  if (link) {
    return;
  }
  // Stop current timeout
  clearTimeout(cacheTimeout);

  // Create item
  const newItem = {
    title: item.title,
    date: item.date,
    link: item.link,
    summary: removeTags(item.summary)
  }
  // Push to db
  db.get('log')
    .push(newItem)
    .write()
  
  // Send to all connected clients immediately
  if (!updatingFeeds) {
    wss.clients.forEach(function(client) {
      if (client.readyState === WebSocket.OPEN ) {
        client.send(JSON.stringify([newItem]));
      }
    });
  }
  // Update cache after 10s if no new item comes in
  cacheTimeout = setTimeout(() => {
    updateCache();
  }, 10000);
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
        link: ""
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
