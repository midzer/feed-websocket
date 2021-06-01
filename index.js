const fs = require('fs');
const path = require('path');
const app = require('express')();
const http = require('http');
const server = http.createServer(app);

const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const protocolDb = low(new FileSync('protocols.json'));
protocolDb.defaults({ protocols: [] })
          .write();

const RssFeedEmitter = require('rss-feed-emitter');

const he = require('he');

const config = require('./config.json');

// Globals
const feeders = new Map();
const connectMessages = new Map();

function createDb(protocolPath, filename) {
  if (!fs.existsSync(protocolPath)) {
    // Create dir
    fs.mkdirSync(protocolPath, { recursive: true });
  }
  let reset = false;
  const dbPath = protocolPath + filename;
  if (!fs.existsSync(dbPath)) {
    reset = true; 
  }
  const adapter = new FileSync(dbPath);
  const db = low(adapter);
  if (reset) {
    // Set some defaults
    db.defaults({ log: [] })  
      .write();
  }
  return db;
}

function createFeeder(protocol) {
  // Create feeder instance
  const feeder = new RssFeedEmitter(/*{ skipFirstLoad: true }*/);

  // Create or get db
  const db = createDb('./data/' + protocol + '/', 'db.json');

  let cacheTimeout;
  feeder.on('new-item', item => {
    // Skip empty titles or links
    if (!item.title || !item.link) {
      return;
    }
    // Stop current timeout
    clearTimeout(cacheTimeout);

    // Skip already existing links
    const link = db.get('log')
                   .find({ link: item.link })
                   .value()
    if (!link) {
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
        if (client.protocol.replace(/_/g, '-') === protocol && client.readyState === WebSocket.OPEN ) {
          client.send(JSON.stringify([newItem]));
        }
      });
      // Push to db
      const size = db.get('log')
                    .size()
                    .value();
      if (size === 25) {
        db.get('log')
          .pullAt([0])
          .write();
      }
      db.get('log')
        .push(newItem)
        .write()
    }
    // Update cache after 5s if no new item comes in
    cacheTimeout = setTimeout(() => {
      // Update cache
      const entries = db.get('log')
                        .sortBy('date')
                        .takeRight(25)
                        .value();
      connectMessages.set(protocol, JSON.stringify(entries));
    }, 5000);
  });
  
  feeder.on('error', console.error);

  feeders.set(protocol, feeder);

  return feeder;
}

function removeTags (string) {
  return string ? string.replace(/<(?:.|\n)*?>/gm, '').trim() : '';
}

wss.on('connection', function(socket) {
  console.log('a user connected');
  if (socket.readyState === WebSocket.OPEN) {
    const protocol = socket.protocol.replace(/_/g, '-');
    
    // Send back
    if (connectMessages.has(protocol)) {
      socket.send(connectMessages.get(protocol));
    }
    else {
      socket.send(JSON.stringify(
        [
          {
            title: "",
            date: new Date().toISOString(),
            link: ""
          }
        ]
      ));
    }
  }

  socket.on('message', function(message) {
    if (socket.readyState === WebSocket.OPEN) {
      if (message === 'ping') {
        socket.send('pong');
      }
      else {
        // TODO: send error message if URL is down or no RSS feed
        const protocol = socket.protocol.replace(/_/g, '-');

        // Check if exists
        const db = createDb('./data/' + protocol + '/', 'feeds.json');
        const feed = db.get('log')
                       .find({ feed: message })
                       .value()
        if (feed) {
          return;
        }
        // Save
        db.get('log')
          .push({
            feed: message
          })
          .write();

        let feeder;
        if (feeders.has(protocol)) {
          feeder = feeders.get(protocol);
        }
        else {
          // Create new feeder
          feeder = createFeeder(protocol);
          protocolDb.get('protocols')
                    .push({
                      key: protocol
                    })
                    .write()
        }
        feeder.add({
          url: message
        });
      }
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
const protocols = protocolDb.get('protocols')
                             .map('key')
                             .value();
protocols.forEach(protocol => {
  const feeder = createFeeder(protocol);
  const db = createDb('./data/' + protocol + '/', 'feeds.json');
  const feeds = db.get('log')
                  .map('feed')
                  .value();
  feeds.forEach(feed => feeder.add({
    url: feed
  }));
});
