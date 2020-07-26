var app = require('express')();
var http = require('http');
var server = http.createServer(app);

var WebSocket = require('ws');
var wss = new WebSocket.Server({ server });

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const db = low(new FileSync('db.json'));

const RssFeedEmitter = require('rss-feed-emitter');
const feeder = new RssFeedEmitter({ skipFirstLoad: true });

const request = require('request');
const crypto = require('crypto');

const he = require('he');

const config = require('./config.json');

// Globals
let connectMessage = JSON.stringify([{
  title: "Server ist gerade beschäftigt, bitte Seite neu laden",
  date: new Date().toISOString(),
  link: ""
}]);
let cacheTimeout;
let feedsHash;

function updateFeeds () {
  // Fetch endpoint .json
  request({
    url: config.endpoint
    },
    function (error, response, body) {
      const md5 = crypto.createHash('md5').update(body).digest('hex');
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
        feeder.add({
          url: JSON.parse(body)
        });
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
  return string ? string.replace(/<(?:.|\n)*?>/gm, '').trim() : '';
}

feeder.on('new-item', item => {
  // Skip empty titles
  if (!item.title) {
    return;
  }
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
    date: item.date || new Date().toISOString(),
    link: item.link,
    summary: he.decode(removeTags(item.summary))
  }
  // Send to all connected clients immediately
  // via WebSocket
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN ) {
      client.send(JSON.stringify([newItem]));
    }
  });
  // Push to db
  db.get('log')
    .push(newItem)
    .write()
  
  // Update cache after 10s if no new item comes in
  cacheTimeout = setTimeout(() => {
    updateCache();
  }, 10000);
});

feeder.on('error', console.error);

wss.on('connection', function(socket) {
  console.log('a user connected');
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(connectMessage);
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

server.listen(config.port, function() {
  console.log(`listening on *:${config.port}`);
});
// Kickstart
updateFeeds();
