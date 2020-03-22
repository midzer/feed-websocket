var app = require('express')();
var http = require('http');
var server = http.createServer(app);

var bodyParser = require('body-parser');
app.use(bodyParser.json())

var WebSocket = require('ws');
var wss = new WebSocket.Server({ server });

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const db = low(new FileSync('db.json'));
const dbUsers = low(new FileSync('users.json'));

// Set some defaults
dbUsers.defaults({ users: [] })
  .write();

const RssFeedEmitter = require('rss-feed-emitter');
const feeder = new RssFeedEmitter();

const request = require('request');
const crypto = require('crypto');

const he = require('he');

const config = require('./config.json');

const webpush = require('web-push');
webpush.setVapidDetails(
  config.email,
  config.publicKey,
  config.privateKey
)

// Globals
let connectMessage;
let updatingFeeds;
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

        // Dont send to clients while updating
        updatingFeeds = true;

        // Clear db
        db.unset('log')
          .write()

        // Set some defaults
        db.defaults({ log: [] })
          .write();

        // Remove all feeds
        feeder.destroy();

        // Add all feeds
        JSON.parse(body).forEach(feed => {
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
  if (!updatingFeeds) {
    // via WebSocket
    wss.clients.forEach(function(client) {
      if (client.readyState === WebSocket.OPEN ) {
        client.send(JSON.stringify([newItem]));
      }
    });
    // via Push
    const url = new URL(item.link);
    let hostname = url.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.replace('www.', '');
    }
    const payload = JSON.stringify({
      title: 'Neuer Feed',
      body: `${hostname} | ${item.title}`
    });
    const subscriptions = dbUsers.get('users')
      .value();
    subscriptions.forEach(function(subscription) {
      webpush.sendNotification(subscription, payload).catch(error => {
        console.error(error.stack);
      });
    });
  }
  // Push to db
  db.get('log')
    .push(newItem)
    .write()
  
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

// Subscription management
app.post('/subscribe', (req, res) => {
  // Push to db
  const subscription = req.body;
  dbUsers.get('users')
    .push(subscription)
    .write()
  
  // Notify users instantly
  const payload = JSON.stringify({
    title: 'Push-Benachrichtungen aktivieren',
    body: 'Das hat funktioniert :)'
  });
  webpush.sendNotification(subscription, payload).catch(error => {
    console.error(error.stack);
  });
  // Leave proper status code
  res.status(201).json({ message: 'Subscribed successfully' });
});

app.post('/unsubscribe', (req, res) => {
  // Remove from db
  const subscription = req.body;
  dbUsers.get('users')
    .remove({ endpoint: subscription.endpoint })
    .write()
  
  // Leave proper status code
  res.status(204).json({ message: 'Unsubscribed successfully' });
});

// Listen to incoming users and messages
server.listen(config.port, function() {
  console.log(`listening on *:${config.port}`);
});
app.listen(3000);

// Kickstart
updateFeeds();
